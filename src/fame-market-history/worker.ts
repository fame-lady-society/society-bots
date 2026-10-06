import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildHistory, type Candle } from "./analytics.ts";
import { readArchive } from "./archive.ts";
import { validateMetadata, type TokenMetadata } from "./decode.ts";
import { digest, type Manifest, type Scope } from "./model.ts";
import type { MarketCandle } from "./market.ts";
import { servingRevision } from "./revision.ts";

export const LEASE_MS = 180_000;
export const MAX_PUBLISHED_CANDLES = 90;
export interface Publication {
  scopeId: string;
  owner: string;
  now: number;
  metadataRevision: string;
  target: Manifest;
  sourceRevision: string;
  candles: Candle[];
  market: MarketCandle[];
  coverageFromTimestamp: number;
  publishedThroughTimestamp: number;
  artifacts: { key: string; sha256: string; bytes: number }[];
}
export interface AggregationStore {
  acquire(
    scopeId: string,
    startBlock: number,
    metadataRevision: string,
    owner: string,
    now: number,
  ): Promise<{ nextBlock: number; collectedThrough: number } | null>;
  pending(scopeId: string, nextBlock: number): Promise<Manifest | null>;
  previous(scopeId: string, beforeBlock: number): Promise<Manifest | null>;
  read(manifest: Manifest): Promise<Uint8Array>;
  upload(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  publish(publication: Publication): Promise<void>;
  release(scopeId: string, owner: string): Promise<void>;
}

/** One sequential committed range per invocation. Failed runs retain their lease
 * until expiry; immutable uploaded objects remain invisible until publication. */
export async function aggregateNext({
  scope,
  startBlock,
  metadata,
  store,
  now = Date.now,
  owner = randomUUID(),
}: {
  scope: Scope;
  startBlock: number;
  metadata: TokenMetadata;
  store: AggregationStore;
  now?: () => number;
  owner?: string;
}) {
  validateMetadata(scope, metadata);
  const metadataRevision = servingRevision(scope, metadata);
  const lease = await store.acquire(
    scope.id,
    startBlock,
    metadataRevision,
    owner,
    now(),
  );
  if (!lease) return { status: "busy" as const };
  const target = await store.pending(scope.id, lease.nextBlock);
  if (!target) {
    await store.release(scope.id, owner);
    return { status: "caught-up" as const, aggregationLagBlocks: 0 };
  }
  if (target.fromBlock !== lease.nextBlock || target.scopeId !== scope.id)
    throw new Error("Pending range does not match aggregation checkpoint");
  const inputs = [{ manifest: target, bytes: await store.read(target) }];
  const batch = readArchive(target, inputs[0].bytes);
  const verifyServingScope = (archivedScope: Scope) => {
    if (servingRevision(archivedScope, metadata) !== metadataRevision)
      throw new Error(
        "Archived valuation sources differ from serving policy; explicit reconciliation required",
      );
  };
  verifyServingScope(batch.scope);
  const firstTime = batch.headers[0].timestamp;
  const lastTime = batch.headers.at(-1)!.timestamp;
  let firstBucket = Math.floor(firstTime / 300) * 300;
  // Need a strictly earlier timestamp to claim the first bucket is complete.
  // Empty ranges matter too: they establish coverage without creating trades.
  let earliest = batch;
  const prependPrevious = async () => {
    if (inputs.length === 8)
      throw new Error(
        "Candle context exceeds eight archives; aggregation needs range reconciliation",
      );
    const previous = await store.previous(scope.id, earliest.fromBlock);
    if (!previous || previous.toBlock + 1 !== earliest.fromBlock)
      throw new Error("Missing adjacent committed candle input");
    const bytes = await store.read(previous);
    earliest = readArchive(previous, bytes);
    verifyServingScope(earliest.scope);
    inputs.unshift({ manifest: previous, bytes });
  };
  if (target.fromBlock > startBlock) {
    await prependPrevious();
    // This range closes the preceding range's trailing partial candle, even
    // when its first block lands in a later bucket or follows a timestamp gap.
    firstBucket = Math.floor(earliest.headers.at(-1)!.timestamp / 300) * 300;
  }
  while (
    earliest.fromBlock > startBlock &&
    earliest.headers[0].timestamp >= firstBucket
  )
    await prependPrevious();
  const count =
    (Math.floor(lastTime / 300) - firstBucket / 300 + 1) *
    (scope.pools.length + 1);
  if (count > MAX_PUBLISHED_CANDLES)
    throw new Error(
      "Range or timestamp gap exceeds atomic candle publication capacity; operator reconciliation required",
    );
  const directory = await mkdtemp(path.join(tmpdir(), "fame-aggregate-"));
  try {
    const combined = await buildHistory(
      inputs,
      metadata,
      path.join(directory, "window"),
    );
    // Canonical Parquet partitions contain only the target range. Context ranges
    // contribute to candles but must never duplicate events in the data lake.
    const partitionDirectory =
      inputs.length === 1
        ? path.join(directory, "window")
        : path.join(directory, "partition");
    if (inputs.length > 1)
      await buildHistory([inputs.at(-1)!], metadata, partitionDirectory);
    const artifacts: Publication["artifacts"] = [];
    for (const [file, contentType] of [
      ["events.parquet", "application/vnd.apache.parquet"],
      ["evidence.json", "application/json"],
    ]) {
      const bytes = await readFile(path.join(partitionDirectory, file));
      const sha256 = digest(bytes);
      const key = `derived/${scope.id}/${target.fromBlock}-${target.toBlock}/${sha256}/${file}`;
      await store.upload(key, bytes, contentType);
      artifacts.push({ key, sha256, bytes: bytes.length });
    }
    const candles = combined.dataset.candles[300].filter(
      (c) => c.timestamp >= firstBucket && c.timestamp <= lastTime,
    );
    await store.publish({
      scopeId: scope.id,
      owner,
      now: now(),
      metadataRevision,
      target,
      sourceRevision: combined.dataset.sourceRevision,
      candles,
      market: combined.dataset.market.filter(
        (c) => c.timestamp >= firstBucket && c.timestamp <= lastTime,
      ),
      coverageFromTimestamp: firstTime + 1,
      publishedThroughTimestamp: lastTime,
      artifacts,
    });
    return {
      status: "published" as const,
      fromBlock: target.fromBlock,
      toBlock: target.toBlock,
      candleCount: candles.length,
      inputRanges: inputs.length,
      sourceRevision: combined.dataset.sourceRevision,
      aggregationLagBlocks: Math.max(
        0,
        lease.collectedThrough - target.toBlock,
      ),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
