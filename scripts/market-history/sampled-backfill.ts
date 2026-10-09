/** Local backfill only. AWS operations are Query/Get; all writes stay under output. */
import { mkdir, readFile, open, unlink } from "node:fs/promises";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DuckDBInstance } from "@duckdb/node-api";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import {
  historyScope,
  digest,
  type Manifest,
  type Header,
} from "../../src/fame-market-history/model.ts";
import { readArchive } from "../../src/fame-market-history/archive.ts";
import {
  sampledPolicy,
  type SampledObservation,
} from "../../src/fame-market-history/sampled-market.ts";
import {
  sampledReader,
  deriveSampledObservation,
  type SampledEvidence,
} from "../../src/fame-market-history/sampled-rpc.ts";
import { referenceBoundary } from "../../src/fame-market-history/reference-collector.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import {
  immutableFile,
  readJson,
} from "../../src/fame-market-history/local-artifacts.ts";
import {
  rebuildActivity,
  sampledPages,
} from "../../src/fame-market-history/sampled-rebuild.ts";
import type { TokenMetadata } from "../../src/fame-market-history/decode.ts";
import { rangeKey } from "../../src/fame-market-history/keys.ts";

let lock: string | undefined;
let runMetrics:
  | import("../../src/fame-market-history/rpc.ts").RpcMetrics
  | undefined;
import { failureCode } from "../../src/fame-market-history/failure.ts";
try {
  if (process.argv.length !== 3) throw new Error("Expected output directory");
  const output = path.resolve(process.argv[2]);
  const table = process.env.FAME_HISTORY_TABLE,
    bucket = process.env.FAME_HISTORY_BUCKET,
    url = process.env.FAME_HISTORY_RPC_URL;
  if (!table || !bucket || !url)
    throw new Error("Missing rehearsal configuration");
  await mkdir(output, { recursive: true });
  const lockPath = path.join(output, "lock");
  const handle = await open(lockPath, "wx");
  lock = lockPath;
  await handle.close();
  for (const dir of ["raw", "observations", "pages"])
    await mkdir(path.join(output, dir), { recursive: true });
  const scope = historyScope(famePoolStateRegistry),
    policy = sampledPolicy(scope);
  const db = DynamoDBDocumentClient.from(
      new DynamoDBClient({ maxAttempts: 2 }),
    ),
    s3 = new S3Client({ maxAttempts: 2 });
  const metadata = JSON.parse(
    await readFile(
      new URL(
        "../../src/fame-market-history/token-metadata.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as TokenMetadata;
  type Job = {
    version: string;
    scopeId: string;
    policyRevision: string;
    table: string;
    bucket: string;
    from: number;
    to: number;
    manifests: Manifest[];
    metadataRevision: string;
  };
  const requestedTo =
    process.env.FAME_HISTORY_TO === undefined
      ? undefined
      : Number(process.env.FAME_HISTORY_TO);
  if (
    requestedTo !== undefined &&
    (!Number.isSafeInteger(requestedTo) ||
      requestedTo < 86400 ||
      requestedTo % 300)
  )
    throw new Error("FAME_HISTORY_TO must be an aligned exclusive timestamp");
  let job = await readJson<Job>(path.join(output, "job.json"));
  const getRaw = async (m: Manifest) => {
    if (
      !m.key.startsWith(`raw/${m.schema}/chain=8453/scope=${scope.id}/`) ||
      m.bytes > 8 * 1024 * 1024
    )
      throw new Error("Invalid archive key or size");
    const file = path.join(output, "raw", `${m.sha256}.gz`);
    try {
      const bytes = await readFile(file);
      readArchive(m, bytes);
      return bytes;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const result = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: m.key }),
    );
    if (!result.Body || result.ContentLength !== m.bytes)
      throw new Error("Archive length mismatch");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
      length += chunk.length;
      if (length > m.bytes) throw new Error("Archive exceeds limit");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    readArchive(m, bytes);
    await immutableFile(file, bytes);
    return bytes;
  };
  if (!job) {
    const manifests: Manifest[] = [];
    let cursor: Record<string, unknown> | undefined;
    let from = 0,
      to = 0,
      done = false;
    for (let page = 0; page < 20 && !done; page++) {
      const result = await db.send(
        new QueryCommand({
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
          ExpressionAttributeValues: {
            ":pk": `scope:${scope.id}`,
            ":lo": rangeKey(1),
            ":hi": rangeKey(Number.MAX_SAFE_INTEGER),
          },
          ScanIndexForward: false,
          Limit: 50,
          ExclusiveStartKey: cursor,
        }),
      );
      for (const item of result.Items ?? []) {
        const m = item as Manifest,
          batch = readArchive(m, await getRaw(m));
        if (!to) {
          const availableTo =
            Math.floor(batch.headers.at(-1)!.timestamp / 300) * 300;
          to = requestedTo ?? availableTo;
          if (to > availableTo)
            throw new Error("Requested range is not archived yet");
          from = to - 86400;
        }
        manifests.push(m);
        if (batch.headers[0].timestamp < from) {
          done = true;
          break;
        }
      }
      cursor = result.LastEvaluatedKey;
      if (!cursor) break;
    }
    if (!manifests.length || !done)
      throw new Error("Cannot bracket full day from committed archives");
    job = {
      version: "sampled-local-job-v1",
      scopeId: scope.id,
      policyRevision: policy.revision,
      table,
      bucket,
      from,
      to,
      manifests,
      metadataRevision: digest(JSON.stringify(metadata)),
    };
    await immutableFile(
      path.join(output, "job.json"),
      Buffer.from(JSON.stringify(job)),
    );
  }
  if (
    (requestedTo !== undefined && job.to !== requestedTo) ||
    job.version !== "sampled-local-job-v1" ||
    job.scopeId !== scope.id ||
    job.policyRevision !== policy.revision ||
    job.table !== table ||
    job.bucket !== bucket ||
    job.metadataRevision !== digest(JSON.stringify(metadata))
  )
    throw new Error("Frozen job changed");
  const inputs = [];
  for (const manifest of job.manifests)
    inputs.push({ manifest, bytes: await getRaw(manifest) });
  const activity = rebuildActivity(scope, metadata, inputs, job.from, job.to);
  const observations = new Map<number, SampledObservation>();
  let rpc = boundedTransport({
    url,
    maxRequests: 3500,
    maxResponseBytes: 256 * 1024,
    maxTotalResponseBytes: 64 * 1024 * 1024,
    deadline: Date.now() + 15 * 60_000,
  });
  runMetrics = rpc.metrics;
  const chain = chainReader(scope, rpc.transport, 1),
    head = await chain.finalized(),
    reader = sampledReader(scope, rpc.transport);
  const cache = new Map<number, Header>([[head.number, head]]);
  // Verified finalized archive headers bracket each sample without another long
  // search back from the current head. The successor is still re-read from RPC.
  for (const input of inputs)
    for (const h of readArchive(input.manifest, input.bytes).headers) {
      const existing = cache.get(h.number);
      if (existing && existing.hash !== h.hash)
        throw new Error("Archive/header conflict");
      cache.set(h.number, h);
    }
  const header = async (n: number) => {
    let h = cache.get(n);
    if (!h) {
      h = await chain.header(n);
      cache.set(n, h);
    }
    return h;
  };
  let low = await header(Math.min(...job.manifests.map((m) => m.fromBlock)));
  for (let t = job.from; t < job.to; t += 300) {
    const file = path.join(output, "observations", `${t}.json`);
    let evidence = await readJson<SampledEvidence>(file);
    if (!evidence) {
      let upper = head;
      for (const h of cache.values()) {
        if (h.timestamp < t + 300 && h.number > low.number) low = h;
        if (h.timestamp >= t + 300 && h.number < upper.number) upper = h;
      }
      const boundary = await referenceBoundary(t, low, upper, header);
      evidence = await reader(t, boundary.block, boundary.after);
      if (
        (await chain.header(boundary.after.number)).hash !== boundary.after.hash
      )
        throw new Error("Canonical boundary changed");
      deriveSampledObservation(scope, evidence);
      await immutableFile(file, Buffer.from(JSON.stringify(evidence)));
    }
    const observation = deriveSampledObservation(scope, evidence);
    observations.set(t, observation);
    low = evidence.block;
    if (observations.size % 24 === 0)
      console.log(
        JSON.stringify({
          event: "local-sampled-progress",
          buckets: observations.size,
          requests: rpc.metrics.requests,
          bytes: rpc.metrics.responseBytes,
        }),
      );
  }
  const pages = sampledPages(scope, activity, observations);
  for (const page of pages)
    await immutableFile(path.join(output, "pages", page.key), page.bytes);
  // Reusable compact evidence export; JSON payload retains exact strings and raw ABI bytes.
  const instance = await DuckDBInstance.create(":memory:"),
    conn = await instance.connect();
  const parquet = path.join(output, "observations.parquet");
  try {
    await conn.run(
      "CREATE TABLE observations (timestamp BIGINT, payload VARCHAR)",
    );
    const app = await conn.createAppender("observations");
    try {
      for (const [t] of observations) {
        app.appendBigInt(BigInt(t));
        app.appendVarchar(
          await readFile(
            path.join(output, "observations", `${t}.json`),
            "utf8",
          ),
        );
        app.endRow();
      }
      app.flushSync();
    } finally {
      app.closeSync();
    }
    await conn.run(
      `COPY observations TO '${parquet.replaceAll("'", "''")}.tmp' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    await immutableFile(parquet, await readFile(`${parquet}.tmp`));
    await unlink(`${parquet}.tmp`);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  const pageManifest = pages.map(({ key, sha256, bytes }) => ({
    key,
    sha256,
    bytes: bytes.length,
  }));
  const manifest = {
    version: "sampled-local-publication-v1",
    jobRevision: digest(JSON.stringify(job)),
    sourceRevision: activity.sourceRevision,
    policyRevision: policy.revision,
    from: job.from,
    to: job.to,
    pages: pageManifest,
    parquetSha256: digest(await readFile(parquet)),
  };
  await immutableFile(
    path.join(output, "publication.json"),
    Buffer.from(JSON.stringify(manifest)),
  );
  const stats = {
    event: "local-sampled-complete",
    from: job.from,
    to: job.to,
    archives: inputs.length,
    rawBytes: inputs.reduce((n, i) => n + i.bytes.length, 0),
    observations: observations.size,
    pages: pages.length,
    pageBytes: pages.reduce((n, p) => n + p.bytes.length, 0),
    parquetBytes: (await readFile(parquet)).length,
    metrics: rpc.metrics,
  };
  console.log(JSON.stringify(stats));
  await immutableFile(
    path.join(output, `receipt-${Date.now()}.json`),
    Buffer.from(JSON.stringify(stats)),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "local-sampled-failed",
      code: failureCode(error),
      metrics: runMetrics,
    }),
  );
  console.error(
    "Local sampled rebuild failed; completed immutable artifacts retained. Provider details withheld.",
  );
  process.exitCode = 1;
} finally {
  if (lock) await unlink(lock);
}
