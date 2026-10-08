import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { digest, hash, integer, type Scope, type Manifest } from "./model.ts";
import { sampledPolicy, sampledMarketBucket } from "./sampled-market.ts";
import {
  deriveSampledObservation,
  type SampledEvidence,
} from "./sampled-rpc.ts";
import {
  nextSampledPublication,
  validateSampledPublication,
  type SampledStore,
  type SampledCursor,
  type SampledPublication,
} from "./sampled-live.ts";
import { rangeKey, sampledKey, sampledPageKey } from "./keys.ts";
import { readArchive } from "./archive.ts";
import { rebuildActivity } from "./sampled-rebuild.ts";
import type { TokenMetadata } from "./decode.ts";
function cursorValue(
  row: Record<string, any> | undefined,
  revision: string,
): SampledCursor | null {
  if (!row) return null;
  const startTimestamp = integer(row.startTimestamp, "sampled start"),
    nextTimestamp = integer(row.nextTimestamp, "sampled next");
  if (
    startTimestamp % 300 ||
    nextTimestamp % 300 ||
    nextTimestamp < startTimestamp ||
    row.policyRevision !== revision
  )
    throw new Error("Invalid sampled cursor");
  return {
    startTimestamp,
    nextTimestamp,
    policyRevision: revision,
    anchor: {
      number: integer(row.anchor?.number, "anchor block"),
      timestamp: integer(row.anchor?.timestamp, "anchor time"),
      hash: hash(row.anchor?.hash),
      parentHash: hash(row.anchor?.parentHash),
    },
  };
}
export function awsSampled({
  scope,
  table,
  bucket,
  metadata,
  canContinue = () => true,
  db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
  s3 = new S3Client({ maxAttempts: 2 }),
}: {
  scope: Scope;
  table: string;
  bucket: string;
  metadata?: TokenMetadata;
  canContinue?: () => boolean;
  db?: DynamoDBDocumentClient;
  s3?: S3Client;
}): SampledStore {
  const revision = sampledPolicy(scope).revision;
  const rawCache = new Map<string, Buffer>();
  const get = async (Key: Record<string, string>) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  const collected = async () =>
    cursorValue(await get(sampledKey(revision, "collected")), revision);
  const download = async (key: string, length: number, sha: string) => {
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > 8 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(sha)
    )
      throw new Error("Invalid sampled artifact");
    const response = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body || response.ContentLength !== length)
      throw new Error("Sampled archive size mismatch");
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > length) throw new Error("Oversized sampled archive");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== sha)
      throw new Error("Sampled archive checksum mismatch");
    return bytes;
  };
  return {
    collected,
    cursor: async (initial) => {
      try {
        await db.send(
          new PutCommand({
            TableName: table,
            Item: { ...sampledKey(revision, "collected"), ...initial },
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
      const c = await collected();
      if (!c) throw new Error("Missing sampled cursor");
      return c;
    },
    commit: async (cursor, e) => {
      if (e.timestamp !== cursor.nextTimestamp || e.policyRevision !== revision)
        throw new Error("Sampled commit skips bucket");
      sampledMarketBucket(
        scope,
        "ETH",
        e.timestamp,
        deriveSampledObservation(scope, e),
        [],
      );
      const bytes = Buffer.from(JSON.stringify(e)),
        sha = digest(bytes),
        key = `raw/sampled/${revision}/${e.timestamp}/${sha}.json`;
      if (bytes.length > 65536)
        throw new Error("Sampled evidence exceeds limit");
      const checksum = Buffer.from(sha, "hex").toString("base64");
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
        throw new Error("Sampled archive verification failed");
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table,
                Key: sampledKey(revision, "collected"),
                UpdateExpression: "SET nextTimestamp = :next, anchor = :anchor",
                ConditionExpression:
                  "nextTimestamp = :expected AND policyRevision = :revision AND anchor.#hash = :hash",
                ExpressionAttributeNames: { "#hash": "hash" },
                ExpressionAttributeValues: {
                  ":next": e.timestamp + 300,
                  ":anchor": e.block,
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
                  ...sampledKey(revision, `observation:${e.timestamp}`),
                  timestamp: e.timestamp,
                  key,
                  sha256: sha,
                  bytes: bytes.length,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    },
    read: async (timestamp) => {
      const m = await get(sampledKey(revision, `observation:${timestamp}`));
      if (
        !m ||
        m.timestamp !== timestamp ||
        m.bytes > 65536 ||
        m.key !== `raw/sampled/${revision}/${timestamp}/${m.sha256}.json`
      )
        throw new Error("Invalid sampled manifest");
      const e = JSON.parse(
        (await download(m.key, m.bytes, m.sha256)).toString(),
      ) as SampledEvidence;
      if (e.timestamp !== timestamp)
        throw new Error("Sampled timestamp mismatch");
      sampledMarketBucket(
        scope,
        "ETH",
        timestamp,
        deriveSampledObservation(scope, e),
        [],
      );
      return e;
    },
    publication: async () => {
      const row = await get(sampledKey(revision, "published"));
      if (!row) return null;
      const { pk: _, sk: __, ...p } = row;
      if (
        p.version !== "fame-sampled-publication-v1" ||
        p.policyRevision !== revision ||
        !Array.isArray(p.pages) ||
        p.pages.length > 288
      )
        throw new Error("Invalid sampled publication");
      return validateSampledPublication(p as SampledPublication, revision);
    },
    activity: async (e) => {
      if (!metadata) throw new Error("Missing publisher token metadata");
      const result = await db.send(
        new QueryCommand({
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
          ExpressionAttributeValues: {
            ":pk": `scope:${scope.id}`,
            ":lo": rangeKey(1),
            ":hi": rangeKey(e.after.number),
          },
          ScanIndexForward: false,
          Limit: 16,
        }),
      );
      const inputs: { manifest: Manifest; bytes: Uint8Array }[] = [];
      let size = 0,
        bracketed = false;
      for (const row of result.Items ?? []) {
        const m = row as Manifest;
        if (!m.key.startsWith(`raw/${m.schema}/chain=8453/scope=${scope.id}/`))
          throw new Error("Unexpected execution archive");
        size += m.bytes;
        if (size > 8 * 1024 * 1024)
          throw new Error("Sampled execution read allowance exceeded");
        if (!canContinue()) return null;
        let bytes = rawCache.get(m.sha256);
        if (!bytes) {
          bytes = await download(m.key, m.bytes, m.sha256);
          rawCache.set(m.sha256, bytes);
        }
        const batch = readArchive(m, bytes);
        for (const h of batch.headers)
          for (const boundary of [e.block, e.after])
            if (
              h.number === boundary.number &&
              (h.hash !== boundary.hash || h.timestamp !== boundary.timestamp)
            )
              throw new Error(
                "Sampled and execution canonical boundary mismatch",
              );
        inputs.push({ manifest: m, bytes });
        if (batch.headers[0].timestamp < e.timestamp) {
          bracketed = true;
          break;
        }
      }
      if (!bracketed && result.LastEvaluatedKey)
        throw new Error("Sampled execution range allowance exceeded");
      if (!inputs.length) return null;
      const rows = rebuildActivity(
        scope,
        metadata,
        inputs,
        e.timestamp,
        e.timestamp + 300,
      ).buckets.get(e.timestamp)!;
      // Never freeze pending/partial native counts into an immutable live generation.
      const newest = readArchive(inputs[0].manifest, inputs[0].bytes);
      return newest.headers.at(-1)!.timestamp >= e.timestamp + 300
        ? rows
        : null;
    },
    publish: async (previous, e, buckets) => {
      const next = nextSampledPublication(previous, e, buckets);
      const ref = next.pages.at(-1)!;
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: sampledKey(revision, `observation:${e.timestamp}`),
                ConditionExpression: "sha256 = :sha",
                ExpressionAttributeValues: {
                  ":sha": digest(JSON.stringify(e)),
                },
              },
            },
            ...buckets.map((b) => ({
              Put: {
                TableName: table,
                Item: {
                  ...sampledPageKey(
                    revision,
                    b.currency,
                    e.timestamp,
                    ref[b.currency],
                  ),
                  body: JSON.stringify(b),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            })),
            {
              Put: {
                TableName: table,
                Item: { ...sampledKey(revision, "published"), ...next },
                ConditionExpression: previous
                  ? "generation = :previous"
                  : "attribute_not_exists(pk)",
                ...(previous
                  ? {
                      ExpressionAttributeValues: {
                        ":previous": previous.generation,
                      },
                    }
                  : {}),
              },
            },
          ],
        }),
      );
    },
  };
}
