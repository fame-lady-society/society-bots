import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
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
      const cursor: Cursor = Item
        ? {
            startBlock: integer(Item.startBlock, "stored start", 1),
            nextBlock: integer(Item.nextBlock, "stored cursor", 1),
            previousHash: hash(Item.previousHash),
          }
        : { startBlock, nextBlock: startBlock, previousHash: null };
      const hint = await db.send(
        new GetCommand({
          TableName: table,
          Key: { pk: `scope:${scopeId}`, sk: "scan-window" },
          ConsistentRead: true,
        }),
      );
      // A hint changes scheduling only. It is obsolete once coverage advances.
      if (hint.Item?.nextBlock === cursor.nextBlock)
        cursor.maxBlocks = integer(
          hint.Item.maxBlocks,
          "stored scan window",
          1,
        );
      return cursor;
    },
    reduceRange: async (scopeId, nextBlock, maxBlocks) => {
      integer(nextBlock, "scan window block", 1);
      integer(maxBlocks, "scan window size", 1);
      try {
        await db.send(
          new PutCommand({
            TableName: table,
            Item: {
              pk: `scope:${scopeId}`,
              sk: "scan-window",
              nextBlock,
              maxBlocks,
            },
            ConditionExpression:
              "attribute_not_exists(pk) OR nextBlock < :next OR (nextBlock = :next AND maxBlocks >= :blocks)",
            ExpressionAttributeValues: {
              ":next": nextBlock,
              ":blocks": maxBlocks,
            },
          }),
        );
      } catch (error) {
        // Another attempt already saved a later or smaller window; keep it.
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
      }
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
