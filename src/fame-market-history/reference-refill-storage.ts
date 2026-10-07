import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { digest, hash, integer, record, type Scope } from "./model.ts";
import { awsReferences } from "./reference-storage.ts";
import { referenceParquet } from "./reference-worker.ts";
import { deriveReference } from "./reference-rpc.ts";
import {
  referenceRefillKey,
  referenceRefillBounds,
  referenceProgressKey,
  referenceProgress,
  referencePolicy,
  referenceKey,
  referenceManifestKey,
} from "./reference.ts";
import type {
  ReferenceRefill,
  ReferenceRefillStore,
} from "./reference-refill.ts";
export function awsReferenceRefill({
  scope,
  table,
  bucket,
  db,
  s3,
}: {
  scope: Scope;
  table: string;
  bucket: string;
  db: DynamoDBDocumentClient;
  s3: S3Client;
}): ReferenceRefillStore & {
  initialize(initial: ReferenceRefill): Promise<void>;
} {
  const policy = referencePolicy(scope),
    key = referenceRefillKey(scope.id);
  const archive = awsReferences({ scope, table, bucket, db, s3 });
  const get = async (Key: { pk: string; sk: string }) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  return {
    initialize: async (initial) => {
      const live = referenceProgress(
        await get(referenceProgressKey(scope.id, "collected")),
        policy.revision,
      );
      referenceRefillBounds(initial, policy.revision);
      if (
        !live ||
        initial.toTimestamp !== live.startTimestamp ||
        initial.nextTimestamp !== initial.toTimestamp ||
        initial.upper.timestamp < initial.toTimestamp
      )
        throw Error("Reference refill must end at live activation");
      try {
        await db.send(
          new PutCommand({
            TableName: table,
            Item: { ...key, ...initial },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
        const existing = referenceRefillBounds(await get(key), policy.revision);
        if (
          !existing ||
          existing.targetFrom !== initial.targetFrom ||
          existing.toTimestamp !== initial.toTimestamp
        )
          throw Error("Another reference refill exists");
      }
    },
    load: async () => {
      const row = await get(key),
        bounds = referenceRefillBounds(row, policy.revision);
      if (!row || !bounds) throw Error("Reference refill not initialized");
      const h = record(row.upper);
      return {
        ...bounds,
        upper: {
          number: integer(h.number, "refill block", 1),
          timestamp: integer(h.timestamp, "refill time", 1),
          hash: hash(h.hash),
          parentHash: hash(h.parentHash),
        },
      };
    },
    commit: async (cursor, evidence) => {
      if (
        evidence.timestamp !== cursor.nextTimestamp - 300 ||
        evidence.timestamp < cursor.targetFrom
      )
        throw Error("Reference refill would skip a bucket");
      const point = deriveReference(evidence, scope);
      const raw = Buffer.from(JSON.stringify(evidence)),
        rawSha = digest(raw);
      const rawKey = `raw/reference/${scope.id}/${evidence.timestamp}/${rawSha}.json`;
      await archive.upload(rawKey, raw);
      const parquet = await referenceParquet(evidence, scope),
        sha256 = digest(parquet);
      const parquetKey = `derived/reference/${scope.id}/${evidence.timestamp}/${sha256}/reference.parquet`;
      await archive.upload(parquetKey, parquet);
      // Never update either live cursor or any execution row. The backward frontier and row commit together.
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: referenceProgressKey(scope.id, "collected"),
                ConditionExpression:
                  "startTimestamp = :end AND policyRevision = :revision",
                ExpressionAttributeValues: {
                  ":end": cursor.toTimestamp,
                  ":revision": policy.revision,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...referenceManifestKey(scope.id, evidence.timestamp),
                  timestamp: evidence.timestamp,
                  key: rawKey,
                  sha256: rawSha,
                  bytes: raw.length,
                  policyRevision: policy.revision,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...referenceKey(scope.id, evidence.timestamp),
                  timestamp: evidence.timestamp,
                  ...point,
                  artifact: { key: parquetKey, sha256, bytes: parquet.length },
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                TableName: table,
                Key: key,
                UpdateExpression: "SET nextTimestamp = :next, #upper = :upper",
                ExpressionAttributeNames: { "#upper": "upper" },
                ConditionExpression:
                  "nextTimestamp = :expected AND targetFrom = :from AND toTimestamp = :end AND policyRevision = :revision",
                ExpressionAttributeValues: {
                  ":next": evidence.timestamp,
                  ":upper": evidence.after,
                  ":expected": cursor.nextTimestamp,
                  ":from": cursor.targetFrom,
                  ":end": cursor.toTimestamp,
                  ":revision": policy.revision,
                },
              },
            },
          ],
        }),
      );
    },
  };
}
