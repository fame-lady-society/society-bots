import { valuedActivity } from "./activity-events.ts";
import { activityIndexed, writeActivity } from "./activity-storage.ts";
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
  prependSampledPublication,
  validateSampledPublication,
  type SampledStore,
  type SampledCursor,
  type SampledPublication,
  type SampledBucket,
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
}): SampledStore & {
  indexActivity(
    evidence: SampledEvidence,
    buckets: SampledBucket[],
  ): Promise<void>;
  revise(
    previous: SampledPublication,
    evidence: SampledEvidence,
    buckets: SampledBucket[],
  ): Promise<void>;
  importPrevious(
    previous: SampledPublication,
    evidence: SampledEvidence,
    buckets: SampledBucket[],
    jobId: string,
  ): Promise<void>;
} {
  const revision = sampledPolicy(scope).revision;
  const rawCache = new Map<string, Buffer>();
  const evidenceCache = new Map<number, SampledEvidence>();
  const get = async (Key: Record<string, string>) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  // Retain both sides atomically with every publication switch. Refresh the old
  // generation's expiry on supersession, so even long-idle clients can catch up.
  const manifests = (...publications: (SampledPublication | null)[]) =>
    publications
      .filter((p): p is SampledPublication => p !== null)
      .map((p) => ({
        Put: {
          TableName: table,
          Item: {
            ...sampledKey(revision, `manifest:${p.generation}`),
            body: JSON.stringify(p),
            expiresAt: Math.floor(Date.now() / 1000) + 86400,
          },
          ConditionExpression: "attribute_not_exists(pk) OR body = :body",
          ExpressionAttributeValues: { ":body": JSON.stringify(p) },
        },
      }));
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
  const archiveEvidence = async (e: SampledEvidence) => {
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
    if (bytes.length > 65536) throw new Error("Sampled evidence exceeds limit");
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
    if (head.ContentLength !== bytes.length || head.ChecksumSHA256 !== checksum)
      throw new Error("Sampled archive verification failed");
    return { key, sha, bytes };
  };
  const read = async (timestamp: number) => {
    const cached = evidenceCache.get(timestamp);
    if (cached) return cached;
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
    evidenceCache.set(timestamp, e);
    return e;
  };
  let lastActivity:
    | {
        sha: string;
        rows: NonNullable<Awaited<ReturnType<SampledStore["activity"]>>>;
      }
    | undefined;
  const activity = async (e: SampledEvidence) => {
    const sha = digest(JSON.stringify(e));
    if (lastActivity?.sha === sha) return structuredClone(lastActivity.rows);
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
    if (newest.headers.at(-1)!.timestamp < e.timestamp + 300) return null;
    lastActivity = { sha, rows: structuredClone(rows) };
    return rows;
  };
  const indexActivity = async (
    e: SampledEvidence,
    buckets: SampledBucket[],
  ) => {
    const ref = nextSampledPublication(null, e, buckets).pages[0];
    if (await activityIndexed(db, table, revision, ref)) return;
    const rows = await activity(e);
    if (!rows) throw new Error("Activity archive not ready");
    const coverage = rows.every((r) => r.coverage === "complete")
      ? "complete"
      : rows.some((r) => r.coverage !== "missing")
        ? "partial"
        : "missing";
    await writeActivity(
      db,
      table,
      revision,
      ref,
      valuedActivity(scope, deriveSampledObservation(scope, e), rows),
      coverage,
    );
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
      const { key, sha, bytes } = await archiveEvidence(e);
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
    read,
    previous: async (timestamp) =>
      evidenceCache.has(timestamp - 300) ||
      (await get(sampledKey(revision, `observation:${timestamp - 300}`)))
        ? read(timestamp - 300)
        : null,
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
    activity,
    indexActivity,
    revise: async (previous, e, buckets) => {
      previous = validateSampledPublication(previous, revision);
      const replacement = nextSampledPublication(null, e, buckets).pages[0];
      if (!previous.pages.some((p) => p.timestamp === e.timestamp))
        throw new Error("Revision outside published window");
      const pages = previous.pages.map((p) =>
        p.timestamp === e.timestamp ? replacement : p,
      );
      const { generation: _, ...body } = previous;
      const next = { ...body, pages };
      const generation = digest(JSON.stringify(next));
      if (generation === previous.generation) return;
      await indexActivity(e, buckets);
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            ...manifests(previous, { ...next, generation }),
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
                    replacement[b.currency],
                  ),
                  body: JSON.stringify(b),
                },
                ConditionExpression: "attribute_not_exists(pk) OR body = :body",
                ExpressionAttributeValues: { ":body": JSON.stringify(b) },
              },
            })),
            {
              Put: {
                TableName: table,
                Item: {
                  ...sampledKey(revision, "published"),
                  ...next,
                  generation,
                },
                ConditionExpression: "generation = :old",
                ExpressionAttributeValues: { ":old": previous.generation },
              },
            },
          ],
        }),
      );
    },
    importPrevious: async (previous, e, buckets, jobId) => {
      if (!/^[a-f0-9]{64}$/.test(jobId))
        throw new Error("Invalid import job identity");
      const next = prependSampledPublication(previous, e, buckets);
      await indexActivity(e, buckets);
      const { key, sha, bytes } = await archiveEvidence(e);
      const ref = next.pages[0];
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            ...manifests(previous, next),
            // Historical work can never claim a live collector's bucket.
            {
              ConditionCheck: {
                TableName: table,
                Key: sampledKey(revision, "collected"),
                ConditionExpression:
                  "startTimestamp > :t AND policyRevision = :revision",
                ExpressionAttributeValues: {
                  ":t": e.timestamp,
                  ":revision": revision,
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
                ConditionExpression: "generation = :previous",
                ExpressionAttributeValues: { ":previous": previous.generation },
              },
            },
            // Separate progress receipt; no live cursor or execution records are mutated.
            {
              Put: {
                TableName: table,
                Item: {
                  ...sampledKey(revision, `import:${jobId}`),
                  jobId,
                  importedFromTimestamp: e.timestamp,
                  publicationNextTimestamp: previous.nextTimestamp,
                  generation: next.generation,
                },
              },
            },
          ],
        }),
      );
    },
    publish: async (previous, e, buckets) => {
      const next = nextSampledPublication(previous, e, buckets);
      await indexActivity(e, buckets);
      const ref = next.pages.at(-1)!;
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            ...manifests(previous, next),
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
