import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { digest, hash, integer, type Scope } from "./model.ts";
import {
  referencePolicy,
  referenceProgress,
  referenceProgressKey,
  referenceManifestKey,
  referenceKey,
  validateEvidence,
  publicReference,
  type ReferenceEvidence,
  type ReferencePoint,
  type ReferenceProgress,
} from "./reference.ts";
import { deriveReference } from "./reference-rpc.ts";
import type {
  ReferenceCollectionStore,
  ReferenceCursor,
} from "./reference-collector.ts";
export interface ReferenceManifest {
  timestamp: number;
  key: string;
  sha256: string;
  bytes: number;
  policyRevision: string;
}
export interface ReferenceStore extends ReferenceCollectionStore {
  progress(
    stage: "collected" | "published",
  ): Promise<ReferenceProgress | undefined>;
  read(timestamp: number): Promise<ReferenceEvidence>;
  upload(key: string, bytes: Uint8Array): Promise<void>;
  publish(
    startTimestamp: number,
    evidence: ReferenceEvidence,
    point: ReferencePoint,
    artifact: { key: string; sha256: string; bytes: number },
  ): Promise<void>;
}
export function awsReferences({
  scope,
  table,
  bucket,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
  s3 = new S3Client({ maxAttempts: 2 }),
}: {
  scope: Scope;
  table: string;
  bucket: string;
  db?: DynamoDBDocumentClient;
  s3?: S3Client;
}): ReferenceStore {
  const revision = referencePolicy(scope).revision;
  const get = async (Key: Record<string, string>) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  const upload = async (key: string, bytes: Uint8Array) => {
    const checksum = Buffer.from(digest(bytes), "hex").toString("base64");
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          IfNoneMatch: "*",
          ChecksumSHA256: checksum,
        }),
      );
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "PreconditionFailed") throw e;
    }
    const h = await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        ChecksumMode: "ENABLED",
      }),
    );
    if (h.ContentLength !== bytes.length || h.ChecksumSHA256 !== checksum)
      throw new Error("Reference archive checksum mismatch");
  };
  return {
    upload,
    progress: async (stage) =>
      referenceProgress(
        await get(referenceProgressKey(scope.id, stage)),
        revision,
      ),
    cursor: async (initial) => {
      const Key = referenceProgressKey(scope.id, "collected");
      try {
        await db.send(
          new PutCommand({
            TableName: table,
            Item: { ...Key, ...initial },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
      } catch (e) {
        if (
          !(e instanceof Error) ||
          e.name !== "ConditionalCheckFailedException"
        )
          throw e;
      }
      const row = await get(Key),
        p = referenceProgress(row, revision);
      if (!p || !row?.anchor) throw new Error("Missing reference cursor");
      const anchor = {
        number: integer(row.anchor.number, "reference anchor block", 1),
        timestamp: integer(row.anchor.timestamp, "reference anchor time", 1),
        hash: hash(row.anchor.hash),
        parentHash: hash(row.anchor.parentHash),
      };
      return { ...p, anchor } as ReferenceCursor;
    },
    commit: async (cursor, evidence) => {
      validateEvidence(evidence, scope);
      if (evidence.timestamp !== cursor.nextTimestamp)
        throw new Error("Reference collection would skip a bucket");
      deriveReference(evidence, scope); // Fail malformed source data before advancing.
      const bytes = Buffer.from(JSON.stringify(evidence)),
        sha256 = digest(bytes);
      const key = `raw/reference/${scope.id}/${evidence.timestamp}/${sha256}.json`;
      await upload(key, bytes);
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table,
                Key: referenceProgressKey(scope.id, "collected"),
                UpdateExpression: "SET nextTimestamp = :next, anchor = :anchor",
                ConditionExpression:
                  "nextTimestamp = :expected AND policyRevision = :revision AND anchor.#hash = :hash",
                ExpressionAttributeNames: { "#hash": "hash" },
                ExpressionAttributeValues: {
                  ":next": evidence.timestamp + 300,
                  ":anchor": evidence.block,
                  ":expected": cursor.nextTimestamp,
                  ":revision": revision,
                  ":hash": cursor.anchor.hash,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...referenceManifestKey(scope.id, evidence.timestamp),
                  timestamp: evidence.timestamp,
                  key,
                  sha256,
                  bytes: bytes.length,
                  policyRevision: revision,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    },
    read: async (timestamp) => {
      const m = await get(referenceManifestKey(scope.id, timestamp));
      if (
        !m ||
        m.timestamp !== timestamp ||
        m.policyRevision !== revision ||
        typeof m.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(m.sha256) ||
        m.key !== `raw/reference/${scope.id}/${timestamp}/${m.sha256}.json` ||
        !Number.isSafeInteger(m.bytes) ||
        m.bytes <= 0 ||
        m.bytes > 65536
      )
        throw new Error("Invalid reference manifest");
      const response = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: m.key }),
      );
      if (!response.Body || response.ContentLength !== m.bytes)
        throw new Error("Invalid reference archive size");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        length += chunk.length;
        if (length > m.bytes) throw new Error("Oversized reference archive");
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (digest(bytes) !== m.sha256)
        throw new Error("Reference archive hash mismatch");
      const e: ReferenceEvidence = JSON.parse(bytes.toString());
      validateEvidence(e, scope);
      if (e.timestamp !== timestamp)
        throw new Error("Reference archive timestamp mismatch");
      return e;
    },
    publish: async (startTimestamp, evidence, point, artifact) => {
      const timestamp = evidence.timestamp;
      const clean = publicReference(point, revision);
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: referenceManifestKey(scope.id, timestamp),
                ConditionExpression:
                  "sha256 = :sha AND policyRevision = :revision",
                ExpressionAttributeValues: {
                  ":sha": digest(Buffer.from(JSON.stringify(evidence))),
                  ":revision": revision,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...referenceKey(scope.id, timestamp),
                  timestamp,
                  ...clean,
                  artifact,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                TableName: table,
                Key: referenceProgressKey(scope.id, "published"),
                UpdateExpression:
                  "SET startTimestamp = :start, nextTimestamp = :next, policyRevision = :revision",
                ConditionExpression:
                  timestamp === startTimestamp
                    ? "attribute_not_exists(pk)"
                    : "nextTimestamp = :expected AND policyRevision = :revision AND startTimestamp = :start",
                ExpressionAttributeValues: {
                  ":start": startTimestamp,
                  ":next": timestamp + 300,
                  ":revision": revision,
                  ...(timestamp === startTimestamp
                    ? {}
                    : { ":expected": timestamp }),
                },
              },
            },
          ],
        }),
      );
    },
  };
}
