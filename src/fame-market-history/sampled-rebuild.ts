import { eventSpot, extend } from "./spot-candles.ts";
import { readArchive, validateBatchSequence } from "./archive.ts";
import { decode, validateMetadata, type TokenMetadata } from "./decode.ts";
import {
  digest,
  type Manifest,
  type Scope,
  type ArchiveBatch,
} from "./model.ts";
import {
  sampledMarketBucket,
  type PoolActivity,
  type SampledObservation,
} from "./sampled-market.ts";

/** Import verified raw ranges, retaining gaps instead of inferring empty activity. */
export function rebuildActivity(
  scope: Scope,
  metadata: TokenMetadata,
  inputs: { manifest: Manifest; bytes: Uint8Array }[],
  from: number,
  to: number,
) {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from % 300 ||
    to % 300 ||
    to <= from ||
    to - from > 86400
  )
    throw new Error("Expected at most one day of aligned buckets");
  validateMetadata(scope, metadata);
  const byHash = new Map(inputs.map((i) => [i.manifest.sha256, i]));
  const sorted = [...byHash.values()].sort(
    (a, b) => a.manifest.fromBlock - b.manifest.fromBlock,
  );
  const buckets = new Map<number, PoolActivity[]>();
  const rejected = new Set<string>();
  for (let t = from; t < to; t += 300)
    buckets.set(
      t,
      scope.pools.map((p) => ({
        poolId: p.id,
        coverage: "missing",
        baseVolumeAtoms: "0",
        quoteVolumeAtoms: "0",
        tradeCount: 0,
        transactionHashes: [],
      })),
    );
  const ranges: { from: number; to: number }[] = [];
  let prior: ArchiveBatch | undefined, previousManifest: Manifest | undefined;
  for (const input of sorted) {
    const batch = readArchive(input.manifest, input.bytes);
    if (batch.scope.id !== scope.id) throw new Error("Rebuild scope mismatch");
    if (prior)
      validateBatchSequence(
        [prior, batch],
        [previousManifest!, input.manifest],
      );
    const first = batch.headers[0],
      last = batch.headers.at(-1)!;
    const previousRange = ranges.at(-1);
    if (prior && prior.toBlock + 1 === batch.fromBlock)
      previousRange!.to = last.timestamp;
    else ranges.push({ from: first.timestamp + 1, to: last.timestamp });
    for (const raw of batch.events) {
      const t = Math.floor(raw.blockTimestamp / 300) * 300;
      const row = buckets.get(t)?.find((r) => r.poolId === raw.poolId);
      if (!row) continue;
      const event = decode(
        raw,
        scope.pools.find((p) => p.id === raw.poolId)!,
        metadata,
      );
      if (
        event.classification === "invalid-trade" ||
        event.classification === "unknown"
      )
        rejected.add(`${t}:${raw.poolId}`);
      const spot = eventSpot(
        scope,
        scope.pools.find((p) => p.id === raw.poolId)!,
        event,
        metadata,
      );
      if (spot === null) row.spotInvalid = true;
      else if (spot) {
        row.spot = extend(row.spot, spot);
        (row.spotEvents ??= []).push({
          blockNumber: raw.blockNumber,
          logIndex: raw.logIndex,
          price: spot,
        });
      }
      if (event.classification !== "trade") continue;
      row.baseVolumeAtoms = String(
        BigInt(row.baseVolumeAtoms) + BigInt(event.baseAtoms!),
      );
      row.quoteVolumeAtoms = String(
        BigInt(row.quoteVolumeAtoms) + BigInt(event.quoteAtoms!),
      );
      row.tradeCount++;
      if (!row.transactionHashes.includes(raw.transactionHash))
        row.transactionHashes.push(raw.transactionHash);
    }
    prior = batch;
    previousManifest = input.manifest;
  }
  for (const [t, rows] of buckets)
    for (const row of rows) {
      row.transactionHashes.sort();
      row.coverage =
        ranges.some((r) => r.from <= t && r.to >= t + 300) &&
        !rejected.has(`${t}:${row.poolId}`)
          ? "complete"
          : row.tradeCount ||
              rejected.has(`${t}:${row.poolId}`) ||
              ranges.some((r) => r.from < t + 300 && r.to > t)
            ? "partial"
            : "missing";
    }
  return {
    buckets,
    ranges,
    sourceRevision: digest(
      JSON.stringify(sorted.map((i) => i.manifest.sha256)),
    ),
  };
}
export function sampledPages(
  scope: Scope,
  activity: ReturnType<typeof rebuildActivity>,
  observations: Map<number, SampledObservation>,
) {
  const pages: { key: string; sha256: string; bytes: Buffer }[] = [];
  for (const currency of ["ETH", "USDC"] as const) {
    const buckets = [...activity.buckets].map(([t, a]) =>
      sampledMarketBucket(
        scope,
        currency,
        t,
        observations.get(t) ?? null,
        a,
        observations.get(t - 300) ?? null,
      ),
    );
    if (Buffer.byteLength(JSON.stringify({ buckets })) > 2 * 1024 * 1024)
      throw new Error("Sampled response exceeds API cap");
    for (let i = 0; i < buckets.length; i += 12) {
      const bytes = Buffer.from(
        JSON.stringify({
          version: "fame-market-page-v1",
          currency,
          sourceRevision: activity.sourceRevision,
          buckets: buckets.slice(i, i + 12),
        }),
      );
      if (bytes.length > 300 * 1024)
        throw new Error("Serving page exceeds conservative item cap");
      pages.push({
        key: `${currency}-${buckets[i].timestamp}.json`,
        sha256: digest(bytes),
        bytes,
      });
    }
  }
  return pages;
}
