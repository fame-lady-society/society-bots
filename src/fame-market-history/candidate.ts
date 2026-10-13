/** Reviewed candidate chunks. Production promotion is deliberately absent. */
import { octoberScope } from "./october-scope.ts";
import { DECODER_VERSION } from "./decode.ts";
import type { Header } from "./model.ts";
import { digest } from "./model.ts";
import { launchScope } from "./local-backfill.ts";
import { sampledPolicy, sampledMarketBucket } from "./sampled-market.ts";
import {
  deriveSampledObservation,
  type SampledEvidence,
} from "./sampled-rpc.ts";
import { referenceBoundary } from "./reference-collector.ts";
import { collect, type ArchiveStore, type ChainReader } from "./collector.ts";
import { publishSampled, type SampledStore } from "./sampled-live.ts";

export const candidateKey = { pk: "candidate:launch-30d-v1", sk: "job" };
export const candidateChunks = [
  "launch-30d-v1",
  "august-30d-v1",
  "september-30d-v1",
  "october-30d-v1",
  "november-30d-v1",
] as const;
export type CandidateChunk = (typeof candidateChunks)[number];
export function candidateJobKey(chunk: CandidateChunk) {
  candidateSpec(chunk); // Runtime callers cannot introduce arbitrary chunks.
  return { pk: `candidate:${chunk}`, sk: "job" };
}
const expanded = (chunk: CandidateChunk) =>
  chunk === "october-30d-v1" || chunk === "november-30d-v1";
export const candidateScope = (chunk: CandidateChunk = "launch-30d-v1") =>
  expanded(chunk) ? octoberScope() : launchScope();
export function candidateSpec(chunk: CandidateChunk = "launch-30d-v1") {
  const index = candidateChunks.indexOf(chunk);
  if (index < 0) throw new Error("Unknown candidate chunk");
  const scope = candidateScope(chunk);
  return {
    version: chunk,
    ...(chunk === "october-30d-v1"
      ? { historyMode: "dated-membership-v1" }
      : {}),
    decoderVersion: DECODER_VERSION,
    from: 1720828800 + index * 30 * 86400,
    to: 1720828800 + (index + 1) * 30 * 86400,
    startBlock: 17019741,
    scopeId: scope.id,
    policyRevision: sampledPolicy(scope).revision,
  };
}
/** Scope cursors retain their original start across later chunks. */
export const candidateSampleStart = (chunk: CandidateChunk = "launch-30d-v1") =>
  candidateSpec(expanded(chunk) ? "october-30d-v1" : "launch-30d-v1").from;
export const candidateHash = (chunk: CandidateChunk = "launch-30d-v1") =>
  digest(JSON.stringify(candidateSpec(chunk)));
export interface CandidateBounds {
  captureStart?: Header;
  launch: Header;
  before: Header;
  end: Header;
  endBefore: Header;
}
export async function prepareCandidate(
  chain: ChainReader,
  chunk: CandidateChunk = "launch-30d-v1",
): Promise<CandidateBounds> {
  const spec = candidateSpec(chunk);
  const launch = await chain.header(spec.startBlock),
    before = await chain.header(spec.startBlock - 1),
    head = await chain.finalized();
  if (
    launch.timestamp !== candidateSpec().from + 29 ||
    launch.parentHash !== before.hash ||
    head.timestamp < spec.to
  )
    throw new Error("Candidate launch or finalized boundary mismatch");
  const { block: endBefore, after: end } = await referenceBoundary(
    spec.to - 300,
    launch,
    head,
    chain.header,
  );
  const captureStart = expanded(chunk)
    ? (
        await referenceBoundary(
          candidateSampleStart(chunk) - 300,
          launch,
          end,
          chain.header,
        )
      ).block
    : undefined;
  return {
    launch,
    before,
    end,
    endBefore,
    ...(captureStart ? { captureStart } : {}),
  };
}
export function validateCandidateBounds(
  b: CandidateBounds,
  chunk: CandidateChunk = "launch-30d-v1",
) {
  const s = candidateSpec(chunk);
  if (
    (expanded(chunk) &&
      (!b.captureStart ||
        b.captureStart.timestamp >= candidateSampleStart(chunk) ||
        b.captureStart.number <= b.launch.number)) ||
    b.launch.number !== s.startBlock ||
    b.launch.timestamp !== candidateSpec().from + 29 ||
    b.before.number !== s.startBlock - 1 ||
    b.launch.parentHash !== b.before.hash ||
    b.end.number <= b.launch.number ||
    b.end.timestamp < s.to ||
    b.endBefore.timestamp >= s.to ||
    b.endBefore.number + 1 !== b.end.number ||
    b.end.parentHash !== b.endBefore.hash
  )
    throw new Error("Invalid candidate boundaries");
}
/** Existing stores retain independent raw, Parquet and sampled/publication cursors.
 * The coordinator never loads a day or month into memory. */
export async function advanceCandidate(args: {
  chunk?: CandidateChunk;
  bounds: CandidateBounds;
  chain: ChainReader;
  archive: ArchiveStore;
  sampled: SampledStore;
  sample: (t: number, b: Header, a: Header) => Promise<SampledEvidence>;
  aggregate: () => Promise<{ status: string }>;
  aggregationNext: () => Promise<number>;
  canContinue: () => Promise<boolean>;
  maxSteps?: number;
}) {
  const { bounds, chain, archive, sampled } = args,
    spec = candidateSpec(args.chunk),
    scope = candidateScope(args.chunk);
  validateCandidateBounds(bounds, args.chunk);
  const sample = args.sample;
  if (
    (await chain.header(bounds.launch.number)).hash !== bounds.launch.hash ||
    (await chain.header(bounds.end.number)).hash !== bounds.end.hash
  )
    throw new Error("Candidate frozen boundary hash changed");
  const startBlock = bounds.captureStart?.number ?? spec.startBlock;
  const sampleStart = candidateSampleStart(args.chunk);
  let steps = 0;
  let raw = await archive.cursor(scope.id, startBlock);
  if (
    raw.startBlock !== startBlock ||
    raw.nextBlock < startBlock ||
    raw.nextBlock > bounds.end.number + 1
  )
    throw new Error("Candidate raw cursor outside chunk");
  let rawTime =
    raw.nextBlock === startBlock
      ? (bounds.captureStart ?? bounds.before).timestamp
      : (await chain.header(raw.nextBlock - 1)).timestamp;
  let parquetNext = await args.aggregationNext();
  if (
    !Number.isSafeInteger(parquetNext) ||
    parquetNext < startBlock ||
    parquetNext > raw.nextBlock
  )
    throw new Error("Candidate Parquet exceeds raw coverage");
  let cursor =
    spec.version === "launch-30d-v1"
      ? await sampled.cursor({
          startTimestamp: candidateSpec().from,
          nextTimestamp: candidateSpec().from,
          anchor: bounds.before,
          policyRevision: spec.policyRevision,
        })
      : await sampled.collected();
  if (!cursor) throw new Error("Missing predecessor samples");
  if (
    cursor.startTimestamp !== sampleStart ||
    cursor.nextTimestamp < spec.from ||
    cursor.nextTimestamp > spec.to ||
    cursor.policyRevision !== spec.policyRevision
  )
    throw new Error("Candidate sampled cursor changed");
  if ((await chain.header(cursor.anchor.number)).hash !== cursor.anchor.hash)
    throw new Error("Candidate sample anchor changed");
  while (steps < (args.maxSteps ?? 256) && (await args.canContinue())) {
    if (parquetNext < raw.nextBlock) {
      const result = await args.aggregate();
      steps++;
      if (result.status !== "published")
        return { phase: "parquet", steps, outcome: result.status };
      const advanced = await args.aggregationNext();
      if (advanced <= parquetNext || advanced > raw.nextBlock)
        throw new Error("Candidate Parquet checkpoint made no progress");
      parquetNext = advanced;
      continue;
    }
    // Repair publication lag first: a lost response must never repeat a sample.
    const published = await sampled.publication();
    if (
      spec.version !== "launch-30d-v1" &&
      spec.version !== "october-30d-v1" &&
      (!published || published.nextTimestamp < spec.from)
    )
      throw new Error("Missing predecessor publication");
    if ((published?.nextTimestamp ?? spec.from) > cursor.nextTimestamp)
      throw new Error("Candidate publication exceeds samples");
    if ((published?.nextTimestamp ?? spec.from) < cursor.nextTimestamp) {
      const result = await publishSampled(scope, sampled, () => true, 1);
      steps++;
      if (result.published !== 1)
        throw new Error("Candidate publication made no progress");
      continue;
    }
    if (cursor.nextTimestamp === spec.to && raw.nextBlock > bounds.end.number)
      return { phase: "complete", steps };
    if (cursor.nextTimestamp + 300 > rawTime) {
      if (raw.nextBlock > bounds.end.number)
        throw new Error("Candidate raw coverage ends before target");
      const result = await collect({
        scope,
        chain,
        store: archive,
        startBlock,
        endBlock: bounds.end.number,
        maxBlocks: 2000,
        maxEvents: 5000,
      });
      steps++;
      if (result.status !== "archived")
        return { phase: "raw", steps, outcome: result.status };
      raw = await archive.cursor(scope.id, startBlock);
      rawTime = (await chain.header(raw.nextBlock - 1)).timestamp;
      continue;
    }
    const t: number = cursor.nextTimestamp;
    if (t >= spec.to) throw new Error("Candidate sample outside chunk");
    const guess = Math.min(bounds.end.number - 1, cursor.anchor.number + 150);
    const low = await chain.header(guess),
      high = await chain.header(guess + 1);
    const boundary =
      low.timestamp < t + 300 && high.timestamp >= t + 300
        ? { block: low, after: high }
        : await referenceBoundary(t, cursor.anchor, bounds.end, chain.header);
    const e = await sample(t, boundary.block, boundary.after);
    sampledMarketBucket(
      scope,
      "ETH",
      t,
      deriveSampledObservation(scope, e),
      [],
    );
    if (
      (await chain.header(boundary.after.number)).hash !== boundary.after.hash
    )
      throw new Error("Candidate sample boundary changed");
    await sampled.commit(cursor, e);
    cursor = { ...cursor, nextTimestamp: t + 300, anchor: e.block };
    steps++;
  }
  return { phase: "yielded", steps };
}
