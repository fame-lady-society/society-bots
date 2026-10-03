import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ArchiveStore } from "./collector.ts";
import {
  hash,
  integer,
  type Cursor,
  type Manifest,
  type LiquidityObservation,
} from "./model.ts";

export const cursorKey = (scopeId: string) => ({
  pk: `scope:${scopeId}`,
  sk: "cursor",
});
const rangeKey = (block: number) => block.toString().padStart(16, "0");

export function commitInput(table: string, manifest: Manifest, cursor: Cursor) {
  return {
    TransactItems: [
      {
        Put: {
          TableName: table,
          Item: {
            pk: "history:8453",
            sk: "active-scope",
            scopeId: manifest.scopeId,
          },
          ConditionExpression: "attribute_not_exists(pk) OR scopeId = :scope",
          ExpressionAttributeValues: { ":scope": manifest.scopeId },
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            ...cursorKey(manifest.scopeId),
            startBlock: cursor.startBlock,
            nextBlock: manifest.toBlock + 1,
            previousHash: manifest.lastHash,
          },
          ConditionExpression:
            cursor.previousHash === null
              ? "attribute_not_exists(pk)"
              : "nextBlock = :next AND previousHash = :hash AND startBlock = :start",
          ...(cursor.previousHash === null
            ? {}
            : {
                ExpressionAttributeValues: {
                  ":next": cursor.nextBlock,
                  ":hash": cursor.previousHash,
                  ":start": cursor.startBlock,
                },
              }),
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            pk: `scope:${manifest.scopeId}`,
            sk: `range:${rangeKey(manifest.fromBlock)}`,
            ...manifest,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: table,
          Item: {
            pk: `work:${manifest.scopeId}`,
            sk: `range:${rangeKey(manifest.fromBlock)}`,
            manifestKey: manifest.key,
            fromBlock: manifest.fromBlock,
            toBlock: manifest.toBlock,
            status: "pending",
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ],
  };
}

export function awsArchive({
  table,
  bucket,
  poolStateTable,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
  s3 = new S3Client({ maxAttempts: 2 }),
}: {
  table: string;
  bucket: string;
  poolStateTable?: string;
  db?: DynamoDBDocumentClient;
  s3?: S3Client;
}): ArchiveStore {
  return {
    cursor: async (scopeId, startBlock) => {
      const active = await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk: "history:8453", sk: "active-scope" },
          ConsistentRead: true,
        }),
      );
      if (active.Item && active.Item.scopeId !== scopeId)
        throw new Error(
          "History scope changed; reviewed coverage transition required",
        );
      const { Item } = await db.send(
        new GetCommand({
          TableName: table,
          Key: cursorKey(scopeId),
          ConsistentRead: true,
        }),
      );
      if (!Item)
        return { startBlock, nextBlock: startBlock, previousHash: null };
      return {
        startBlock: integer(Item.startBlock, "stored start", 1),
        nextBlock: integer(Item.nextBlock, "stored cursor", 1),
        previousHash: hash(Item.previousHash),
      };
    },
    upload: async (key, bytes, sha256) => {
      const checksum = Buffer.from(sha256, "hex").toString("base64");
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: "application/x-ndjson",
            ContentEncoding: "gzip",
            ChecksumSHA256: checksum,
            Metadata: { sha256 },
            IfNoneMatch: "*",
          }),
        );
      } catch (error) {
        // A retry may encounter the identical content-addressed object. Verify
        // it below; never replace an existing object or swallow another failure.
        if (!(error instanceof Error) || error.name !== "PreconditionFailed")
          throw error;
      }
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
          ChecksumMode: "ENABLED",
        }),
      );
      if (
        head.ContentLength !== bytes.length ||
        head.ChecksumSHA256 !== checksum
      )
        throw new Error("S3 archive verification failed");
    },
    commit: async (manifest, cursor) => {
      await db.send(
        new TransactWriteCommand(commitInput(table, manifest, cursor)),
      );
    },
    observations: async (scope) => {
      if (!poolStateTable) return [];
      const keys = scope.pools.map((pool) => ({
        pk:
          pool.venueFamily === "Slipstream"
            ? `pool:8453:address:${pool.address}`
            : `pool:8453:${pool.address}`,
        sk:
          pool.venueFamily === "Slipstream" ? "cl-head-snapshot-v1" : "latest",
      }));
      const response = await db.send(
        new BatchGetCommand({
          RequestItems: {
            [poolStateTable]: { Keys: keys, ConsistentRead: true },
          },
        }),
      );
      if (
        Object.values(response.UnprocessedKeys ?? {}).some(
          (value) => (value.Keys?.length ?? 0) > 0,
        )
      )
        throw new Error("Incomplete liquidity observation read");
      const rows = response.Responses?.[poolStateTable] ?? [];
      return scope.pools.map((pool, index): LiquidityObservation => {
        const row = rows.find(
          (item) => item.pk === keys[index].pk && item.sk === keys[index].sk,
        );
        if (!row)
          return {
            poolId: pool.id,
            status: "missing",
            finality: "source-observation-unverified",
          };
        if (row.poolId !== pool.id)
          throw new Error("Liquidity observation identity mismatch");
        const state: Record<string, string | number> = {
          observedThroughBlock: integer(
            row.observedThroughBlock,
            "observation block",
          ),
        };
        for (const key of [
          "token0",
          "token1",
          "updatedAt",
          "sourceRegistryId",
          "reserve0",
          "reserve1",
          "sqrtPriceX96",
          "liquidity",
          "tick",
          "observedThroughBlockHash",
        ]) {
          const value = row[key];
          if (
            typeof value === "string" ||
            (typeof value === "number" && Number.isFinite(value))
          )
            state[key] = value;
        }
        return {
          poolId: pool.id,
          status: "available",
          finality: "source-observation-unverified",
          state,
        };
      });
    },
  };
}

/** Shared across live invocations. Charged before RPC, including failed requests. */
export function dailyAllowance(
  table: string,
  limit: number,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 })),
  now = () => new Date(),
) {
  integer(limit, "daily request allowance", 1);
  return async () => {
    const date = now();
    try {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: {
            pk: "budget:base-history",
            sk: date.toISOString().slice(0, 10),
          },
          UpdateExpression: "SET expiresAt = :expiry ADD usedRequests :one",
          ConditionExpression:
            "attribute_not_exists(usedRequests) OR usedRequests < :limit",
          ExpressionAttributeValues: {
            ":one": 1,
            ":limit": limit,
            ":expiry": Math.floor(date.getTime() / 1000) + 90 * 86400,
          },
        }),
      );
    } catch {
      throw new Error(
        "Daily RPC allowance unavailable or exhausted; no request sent",
      );
    }
  };
}
