/** Candidate generation staging from immutable retained evidence. No RPC access. */
import { gzipSync } from "node:zlib";
import { readArchive } from "./archive.ts";
import { expansionPools } from "./scope-expansion.ts";
import { admissionOrigins } from "./pool-lifecycle.ts";
import {
  digest,
  SCHEMA,
  type Scope,
  type Manifest,
  type Header,
} from "./model.ts";
import type { ArchiveStore } from "./collector.ts";
import {
  sampledCalls,
  sampledCallsAtBlock,
  deriveSampledObservation,
  type SampledEvidence,
} from "./sampled-rpc.ts";
import { sampledPolicy, sampledMarketBucket } from "./sampled-market.ts";
import { publishSampled, type SampledStore } from "./sampled-live.ts";

export function reusePreAdmissionArchive(
  source: Scope,
  target: Scope,
  manifest: Manifest,
  bytes: Uint8Array,
) {
  const added = expansionPools(source, target);
  if (
    added.pools.some(
      (p) =>
        !admissionOrigins[p.id] ||
        manifest.toBlock >= admissionOrigins[p.id].block,
    )
  )
    throw new Error("Archive reuse crosses pool admission; new logs required");
  const batch = readArchive(manifest, bytes);
  if (batch.scope.id !== source.id)
    throw new Error("Wrong retained source scope");
  const { events, ...metadata } = batch;
  const content =
    [
      JSON.stringify({ kind: "range", ...metadata, scope: target }),
      ...events.map((e) => JSON.stringify({ kind: "event", ...e })),
    ].join("\n") + "\n";
  const output = gzipSync(content),
    sha256 = digest(output);
  const next: Manifest = {
    schema: manifest.schema,
    scopeId: target.id,
    sha256,
    fromBlock: manifest.fromBlock,
    toBlock: manifest.toBlock,
    firstHash: manifest.firstHash,
    lastHash: manifest.lastHash,
    previousHash: manifest.previousHash,
    eventCount: manifest.eventCount,
    eventIdentityDigest: manifest.eventIdentityDigest,
    key: `raw/${SCHEMA}/chain=8453/scope=${target.id}/${manifest.fromBlock}-${manifest.toBlock}/${sha256}.jsonl.gz`,
    contentSha256: digest(content),
    bytes: output.length,
    sourceArchive: {
      scopeId: source.id,
      key: manifest.key,
      sha256: manifest.sha256,
      fromBlock: manifest.fromBlock,
      toBlock: manifest.toBlock,
    },
  };
  readArchive(next, output); // Validate the new archive, preserving event identities.
  return { manifest: next, bytes: output };
}
export function reusePreAdmissionSample(
  source: Scope,
  target: Scope,
  e: SampledEvidence,
): SampledEvidence {
  const added = expansionPools(source, target);
  if (
    added.pools.some(
      (p) =>
        !admissionOrigins[p.id] ||
        e.after.number >= admissionOrigins[p.id].block,
    )
  )
    throw new Error("Sample reuse crosses pool admission");
  deriveSampledObservation(source, e);
  const oldCalls = sampledCalls(source),
    active = sampledCallsAtBlock(target, e.block.number);
  const values = new Map(
    oldCalls.map((c, i) => [JSON.stringify(c), e.results[i]]),
  );
  if (active.some((c) => !values.has(JSON.stringify(c))))
    throw new Error("Missing retained sampled call");
  return {
    ...e,
    policyRevision: sampledPolicy(target).revision,
    sourceEvidence: {
      policyRevision: e.policyRevision,
      sha256: digest(JSON.stringify(e)),
    },
    results: sampledCalls(target).map(
      (c) =>
        values.get(JSON.stringify(c)) ?? { success: false, returnData: "0x" },
    ),
  };
}
/** Bounded resumable raw -> Parquet -> sampled pages. Durable cursors own progress.
 * Source stores are read-only here; every write uses the new scope/policy. */
export async function replayCandidate(args: {
  source: Scope;
  target: Scope;
  startBlock: number;
  from: number;
  to: number;
  end: Header;
  before: Header;
  archive: ArchiveStore;
  sourceRange: (
    nextBlock: number,
  ) => Promise<{ manifest: Manifest; bytes: Uint8Array }>;
  sourceSamples: SampledStore;
  targetSamples: SampledStore;
  aggregate: () => Promise<{ status: string }>;
  aggregationNext: () => Promise<number>;
  canContinue: () => Promise<boolean>;
  maxSteps?: number;
}) {
  const { source, target, archive, targetSamples: samples } = args;
  let raw = await archive.cursor(target.id, args.startBlock);
  let cursor = await samples.cursor({
    startTimestamp: args.from,
    nextTimestamp: args.from,
    anchor: args.before,
    policyRevision: sampledPolicy(target).revision,
  });
  if (
    cursor.startTimestamp !== args.from ||
    cursor.nextTimestamp > args.to ||
    raw.nextBlock > args.end.number + 1
  )
    throw new Error("Candidate staging cursor outside retained coverage");
  let steps = 0;
  while (steps < (args.maxSteps ?? 256) && (await args.canContinue())) {
    const parquet = await args.aggregationNext();
    if (parquet > raw.nextBlock) throw new Error("Staged Parquet exceeds raw");
    if (parquet < raw.nextBlock) {
      const result = await args.aggregate();
      steps++;
      if (result.status !== "published")
        return { phase: "staging-parquet", steps };
      if ((await args.aggregationNext()) <= parquet)
        throw new Error("Staged Parquet made no progress");
      continue;
    }
    const published = await samples.publication();
    const next = published?.nextTimestamp ?? args.from;
    if (next > cursor.nextTimestamp)
      throw new Error("Staged publication exceeds samples");
    if (next < cursor.nextTimestamp) {
      if (
        (await publishSampled(target, samples, () => true, 1)).published !== 1
      )
        throw new Error("Staged publication made no progress");
      steps++;
      continue;
    }
    if (
      cursor.nextTimestamp === args.to &&
      raw.nextBlock === args.end.number + 1
    )
      return { phase: "staged", steps };
    const e =
      cursor.nextTimestamp < args.to
        ? await args.sourceSamples.read(cursor.nextTimestamp)
        : null;
    if (!e || raw.nextBlock <= e.after.number) {
      const range = await args.sourceRange(raw.nextBlock);
      if (
        range.manifest.fromBlock !== raw.nextBlock ||
        range.manifest.toBlock > args.end.number
      )
        throw new Error("Retained range does not match staging checkpoint");
      if (
        raw.previousHash !== null &&
        range.manifest.previousHash !== raw.previousHash
      )
        throw new Error("Retained range chain discontinuity");
      const reused = reusePreAdmissionArchive(
        source,
        target,
        range.manifest,
        range.bytes,
      );
      await archive.upload(
        reused.manifest.key,
        reused.bytes,
        reused.manifest.sha256,
      );
      await archive.commit(reused.manifest, raw);
      raw = await archive.cursor(target.id, args.startBlock);
      steps++;
      continue;
    }
    const mapped = reusePreAdmissionSample(source, target, e);
    // Prove prices, candles and totals against retained source evidence before commit.
    const activity = await args.sourceSamples.activity(e);
    if (!activity) throw new Error("Source activity incomplete during replay");
    const previous = await args.sourceSamples.previous(e.timestamp);
    for (const currency of ["ETH", "USDC"] as const) {
      const old = sampledMarketBucket(
        source,
        currency,
        e.timestamp,
        deriveSampledObservation(source, e),
        activity,
        previous ? deriveSampledObservation(source, previous) : null,
      );
      const next = sampledMarketBucket(
        target,
        currency,
        e.timestamp,
        deriveSampledObservation(target, mapped),
        activity,
        previous
          ? deriveSampledObservation(
              target,
              reusePreAdmissionSample(source, target, previous),
            )
          : null,
      );
      if (
        JSON.stringify([old.market, old.series, old.totals]) !==
        JSON.stringify([next.market, next.series, next.totals])
      )
        throw new Error("Candidate replay changed pre-admission market");
    }
    await samples.commit(cursor, mapped);
    cursor = { ...cursor, nextTimestamp: e.timestamp + 300, anchor: e.block };
    steps++;
  }
  return { phase: "staging", steps };
}
