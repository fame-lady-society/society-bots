import { gunzipSync } from "node:zlib";
import {
  digest,
  hash,
  historyScope,
  integer,
  SCHEMA,
  validateLogs,
  type ArchiveBatch,
  type Manifest,
  type RawLog,
} from "./model.ts";

/** Accept only committed, checksum-verified batches, including zero-event ranges. */
export function readArchive(
  manifest: Manifest,
  bytes: Uint8Array,
): ArchiveBatch {
  if (
    bytes.length > 8 * 1024 * 1024 ||
    bytes.length !== manifest.bytes ||
    digest(bytes) !== manifest.sha256
  )
    throw new Error("Archive checksum/size mismatch");
  return readArchiveContent(
    manifest,
    gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }),
  );
}

export function readArchiveContent(
  manifest: Manifest,
  content: Uint8Array,
): ArchiveBatch {
  if (
    content.length > 8 * 1024 * 1024 ||
    digest(content) !== manifest.contentSha256
  )
    throw new Error("Archive content checksum/size mismatch");
  const lines = Buffer.from(content).toString("utf8").trim().split("\n");
  if (lines.length > 10001) throw new Error("Archive row allowance exceeded");
  const metadata = JSON.parse(lines[0]);
  if (
    metadata.kind !== "range" ||
    metadata.schema !== SCHEMA ||
    manifest.schema !== SCHEMA
  )
    throw new Error("Unsupported archive schema");
  const scope = historyScope(metadata.scope.registry);
  if (
    scope.id !== metadata.scope.id ||
    scope.id !== manifest.scopeId ||
    JSON.stringify(scope.pools) !== JSON.stringify(metadata.scope.pools)
  )
    throw new Error("Archive scope mismatch");
  const fromBlock = integer(metadata.fromBlock, "archive start", 1);
  const toBlock = integer(metadata.toBlock, "archive end", fromBlock);
  if (fromBlock !== manifest.fromBlock || toBlock !== manifest.toBlock)
    throw new Error("Archive range mismatch");
  if (!Array.isArray(metadata.headers) || !Array.isArray(metadata.observations))
    throw new Error("Archive headers/observations missing");
  const headers = metadata.headers.map(
    (h: ArchiveBatch["headers"][number]) => ({
      number: integer(h.number, "header number", fromBlock),
      hash: hash(h.hash),
      parentHash: hash(h.parentHash),
      timestamp: integer(h.timestamp, "timestamp"),
    }),
  );
  const headerMap = new Map<number, ArchiveBatch["headers"][number]>(
    headers.map((h: ArchiveBatch["headers"][number]) => [h.number, h]),
  );
  if (
    headerMap.size !== headers.length ||
    headers.some((h: ArchiveBatch["headers"][number]) => h.number > toBlock)
  )
    throw new Error("Duplicate/out-of-range archive header");
  for (let i = 1; i < headers.length; i++) {
    const prior = headers[i - 1],
      current = headers[i];
    if (
      current.number <= prior.number ||
      current.timestamp < prior.timestamp ||
      (current.number === prior.number + 1 && current.parentHash !== prior.hash)
    )
      throw new Error("Inconsistent archive headers");
  }
  const first = headerMap.get(fromBlock),
    last = headerMap.get(toBlock);
  if (
    !first ||
    !last ||
    first.hash !== manifest.firstHash ||
    last.hash !== manifest.lastHash ||
    first.parentHash !== manifest.previousHash
  )
    throw new Error("Archive boundary mismatch");
  const raw = lines.slice(1).map((line) => {
    const { kind, ...log } = JSON.parse(line);
    if (kind !== "event") throw new Error("Unexpected archive row");
    return log;
  });
  const events = validateLogs(
    raw as RawLog[],
    scope,
    fromBlock,
    toBlock,
    headerMap,
  );
  if (
    events.length !== raw.length ||
    events.length !== manifest.eventCount ||
    digest(events.map((e) => `${e.blockHash}:${e.logIndex}`).join("\n")) !==
      manifest.eventIdentityDigest ||
    events.some(
      (e, i) =>
        e.poolId !== raw[i].poolId ||
        e.blockTimestamp !== raw[i].blockTimestamp,
    )
  )
    throw new Error("Archive event identity mismatch");
  return {
    schema: SCHEMA,
    scope,
    fromBlock,
    toBlock,
    headers,
    events,
    observations: metadata.observations,
  };
}

export function canonicalBatches(
  inputs: { manifest: Manifest; bytes: Uint8Array }[],
) {
  if (!inputs.length || inputs.length > 8)
    throw new Error("Expected 1–8 bounded archive batches");
  const unique = new Map(inputs.map((input) => [input.manifest.sha256, input]));
  const sorted = [...unique.values()].sort(
    (a, b) => a.manifest.fromBlock - b.manifest.fromBlock,
  );
  const batches = sorted.map((input) =>
    readArchive(input.manifest, input.bytes),
  );
  validateBatchSequence(
    batches,
    sorted.map((i) => i.manifest),
  );
  return batches;
}

export function validateBatchSequence(
  batches: ArchiveBatch[],
  manifests: Manifest[],
) {
  if (
    !batches.length ||
    batches.length > 8 ||
    manifests.length !== batches.length
  )
    throw new Error("Expected 1–8 matching archive batches");
  let count = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i],
      prior = batches[i - 1];
    count += batch.events.length;
    if (count > 10000) throw new Error("Aggregation event allowance exceeded");
    if (batch.scope.id !== batches[0].scope.id)
      throw new Error("Mixed history scopes");
    if (prior && batch.fromBlock <= prior.toBlock)
      throw new Error("Overlapping archive ranges require reconciliation");
    if (prior && batch.headers[0].timestamp < prior.headers.at(-1)!.timestamp)
      throw new Error("Archive timestamps regress between ranges");
    if (
      prior &&
      batch.fromBlock === prior.toBlock + 1 &&
      manifests[i].previousHash !== manifests[i - 1].lastHash
    )
      throw new Error("Noncanonical adjacent archives");
  }
}
