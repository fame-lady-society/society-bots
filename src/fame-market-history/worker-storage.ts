import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
  TransactGetCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { digest, integer, type Manifest } from "./model.ts";
import {
  LEASE_MS,
  MAX_PUBLISHED_CANDLES,
  type AggregationStore,
  type Publication,
} from "./worker.ts";

export const rangeKey = (block: number) =>
  `range:${String(block).padStart(16, "0")}`;
export const progressKey = (scopeId: string) => ({
  pk: `scope:${scopeId}`,
  sk: "aggregation",
});
export const candleKey = (
  scopeId: string,
  poolId: string,
  timestamp: number,
) => ({
  pk: `candles:${scopeId}:${poolId}:300`,
  sk: String(timestamp).padStart(16, "0"),
});

export function publicationInput(
  table: string,
  p: Publication,
): TransactWriteCommandInput {
  if (!p.candles.length || p.candles.length > MAX_PUBLISHED_CANDLES)
    throw new Error("Invalid atomic candle publication size");
  const put = (Item: Record<string, unknown>) => ({
    Put: { TableName: table, Item },
  });
  return {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: table,
          Key: { pk: "history:8453", sk: "active-scope" },
          ConditionExpression: "scopeId = :scope",
          ExpressionAttributeValues: { ":scope": p.scopeId },
        },
      },
      {
        ConditionCheck: {
          TableName: table,
          Key: { pk: `scope:${p.scopeId}`, sk: rangeKey(p.target.fromBlock) },
          ConditionExpression: "sha256 = :sha",
          ExpressionAttributeValues: { ":sha": p.target.sha256 },
        },
      },
      {
        Update: {
          TableName: table,
          Key: progressKey(p.scopeId),
          UpdateExpression:
            "SET nextBlock = :next, sourceRevision = :revision, leaseUntil = :zero REMOVE #owner",
          ConditionExpression:
            "#owner = :owner AND leaseUntil > :now AND nextBlock = :expected AND metadataRevision = :metadata",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: {
            ":next": p.target.toBlock + 1,
            ":revision": p.sourceRevision,
            ":zero": 0,
            ":owner": p.owner,
            ":now": p.now,
            ":expected": p.target.fromBlock,
            ":metadata": p.metadataRevision,
          },
        },
      },
      {
        Update: {
          TableName: table,
          Key: { pk: `work:${p.scopeId}`, sk: rangeKey(p.target.fromBlock) },
          UpdateExpression: "SET #status = :done, sourceRevision = :revision",
          ConditionExpression: "#status = :pending AND manifestKey = :key",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":done": "done",
            ":pending": "pending",
            ":revision": p.sourceRevision,
            ":key": p.target.key,
          },
        },
      },
      put({
        pk: `partitions:${p.scopeId}`,
        sk: rangeKey(p.target.fromBlock),
        fromBlock: p.target.fromBlock,
        toBlock: p.target.toBlock,
        manifestSha256: p.target.sha256,
        metadataRevision: p.metadataRevision,
        artifacts: p.artifacts,
      }),
      ...p.candles.map((c) =>
        put({
          ...candleKey(p.scopeId, c.poolId, c.timestamp),
          ...c,
          sourceRevision: p.sourceRevision,
          throughBlock: p.target.toBlock,
          metadataRevision: p.metadataRevision,
        }),
      ),
    ],
  };
}

export function awsAggregation({
  table,
  bucket,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
  s3 = new S3Client({ maxAttempts: 2 }),
}: {
  table: string;
  bucket: string;
  db?: DynamoDBDocumentClient;
  s3?: S3Client;
}): AggregationStore {
  const get = async (Key: { pk: string; sk: string }) =>
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key,
          ConsistentRead: true,
        }),
      )
    ).Item;
  return {
    acquire: async (scopeId, startBlock, metadataRevision, owner, now) => {
      const active = await get({ pk: "history:8453", sk: "active-scope" });
      if (!active) return null;
      if (active.scopeId !== scopeId) throw new Error("History scope changed");
      const cursor = await get({ pk: `scope:${scopeId}`, sk: "cursor" });
      if (!cursor || cursor.startBlock !== startBlock)
        throw new Error("Collector start differs from worker");
      try {
        const result = await db.send(
          new UpdateCommand({
            TableName: table,
            Key: progressKey(scopeId),
            UpdateExpression:
              "SET #owner = :owner, leaseUntil = :until, nextBlock = if_not_exists(nextBlock, :start), metadataRevision = :metadata",
            ConditionExpression:
              "(attribute_not_exists(leaseUntil) OR leaseUntil <= :now) AND (attribute_not_exists(metadataRevision) OR metadataRevision = :metadata)",
            ExpressionAttributeNames: { "#owner": "owner" },
            ExpressionAttributeValues: {
              ":owner": owner,
              ":until": now + LEASE_MS,
              ":start": startBlock,
              ":now": now,
              ":metadata": metadataRevision,
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        return {
          nextBlock: integer(
            result.Attributes?.nextBlock,
            "aggregation cursor",
            startBlock,
          ),
          collectedThrough:
            integer(cursor.nextBlock, "collector cursor", startBlock) - 1,
        };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
        const progress = await get(progressKey(scopeId));
        if (progress?.metadataRevision !== metadataRevision)
          throw new Error("Metadata changed; explicit candle rebuild required");
        return null;
      }
    },
    pending: async (scopeId, nextBlock) => {
      // Collector arrival between independent reads must not look like a gap.
      const result = await db.send(
        new TransactGetCommand({
          TransactItems: [
            {
              Get: {
                TableName: table,
                Key: { pk: `work:${scopeId}`, sk: rangeKey(nextBlock) },
              },
            },
            {
              Get: {
                TableName: table,
                Key: { pk: `scope:${scopeId}`, sk: "cursor" },
              },
            },
            {
              Get: {
                TableName: table,
                Key: { pk: `scope:${scopeId}`, sk: rangeKey(nextBlock) },
              },
            },
          ],
        }),
      );
      const [work, cursor, manifest] = (result.Responses ?? []).map(
        (r) => r.Item,
      );
      if (!work) {
        if (!cursor || cursor.nextBlock !== nextBlock)
          throw new Error("Missing pending aggregation work");
        return null;
      }
      if (
        work.status !== "pending" ||
        !manifest ||
        work.manifestKey !== manifest.key
      )
        throw new Error("Pending work/manifest conflict");
      return manifest as unknown as Manifest;
    },
    previous: async (scopeId, beforeBlock) => {
      const result = await db.send(
        new QueryCommand({
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high",
          ExpressionAttributeValues: {
            ":pk": `scope:${scopeId}`,
            ":low": rangeKey(1),
            ":high": rangeKey(beforeBlock - 1),
          },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
      return (result.Items?.[0] as unknown as Manifest) ?? null;
    },
    read: async (manifest) => {
      if (
        !manifest.key.startsWith(
          `raw/${manifest.schema}/chain=8453/scope=${manifest.scopeId}/`,
        )
      )
        throw new Error("Unexpected raw object key");
      const result = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: manifest.key }),
      );
      if (
        !result.Body ||
        result.ContentLength !== manifest.bytes ||
        manifest.bytes > 8 * 1024 * 1024
      )
        throw new Error("Raw object size mismatch");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > manifest.bytes)
          throw new Error("Raw object exceeds manifest size");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    upload: async (key, bytes, contentType) => {
      const sha256 = digest(bytes),
        checksum = Buffer.from(sha256, "hex").toString("base64");
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            IfNoneMatch: "*",
            ChecksumSHA256: checksum,
          }),
        );
      } catch (error) {
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
        throw new Error("Derived object verification failed");
    },
    publish: async (publication) => {
      await db.send(
        new TransactWriteCommand(publicationInput(table, publication)),
      );
    },
    release: async (scopeId, owner) => {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: progressKey(scopeId),
          UpdateExpression: "SET leaseUntil = :zero REMOVE #owner",
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":zero": 0, ":owner": owner },
        }),
      );
    },
  };
}
