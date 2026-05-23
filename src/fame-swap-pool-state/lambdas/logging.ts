import type {
  FamePoolStateBatchResponse,
  FamePoolStateResponseEntry,
} from "../api.ts";
import type { FamePoolStateIndexerResult } from "../indexer.ts";

export type PoolStateLogLevel = "error" | "info" | "warn";
export type PoolStateLogEvent =
  | "fame-pool-state-api-batch"
  | "fame-pool-state-api-error"
  | "fame-pool-state-indexed";

type PoolStateLogValue =
  | boolean
  | null
  | number
  | string
  | PoolStateLogValue[]
  | PoolStateLogFields;

export interface PoolStateLogFields {
  [key: string]: PoolStateLogValue;
}

interface ClReplayLogSummary extends PoolStateLogFields {
  returned: number;
  fresh: number;
  stale: number;
  bitmapWordCount: number;
  initializedTickCount: number;
  bitmapChunkCount: number;
  tickChunkCount: number;
}

type ClReplayResponseEntry = Extract<
  FamePoolStateResponseEntry,
  { stateKind: "cl-replay-v1" }
>;

function statusCounts(response: Pick<FamePoolStateBatchResponse, "pools">) {
  const counts: Record<string, number> = {};
  for (const pool of response.pools) {
    counts[pool.status] = (counts[pool.status] ?? 0) + 1;
  }
  return counts;
}

function isClReplayResponse(
  pool: FamePoolStateResponseEntry,
): pool is ClReplayResponseEntry {
  return "stateKind" in pool && pool.stateKind === "cl-replay-v1";
}

function clReplaySummary(
  response: Pick<FamePoolStateBatchResponse, "pools">,
): ClReplayLogSummary | null {
  const summary: ClReplayLogSummary = {
    returned: 0,
    fresh: 0,
    stale: 0,
    bitmapWordCount: 0,
    initializedTickCount: 0,
    bitmapChunkCount: 0,
    tickChunkCount: 0,
  };

  for (const pool of response.pools) {
    if (!isClReplayResponse(pool)) continue;
    summary.returned += 1;
    if (pool.status === "fresh") summary.fresh += 1;
    if (pool.status === "stale") summary.stale += 1;
    summary.bitmapWordCount += pool.bitmapWordCount;
    summary.initializedTickCount += pool.initializedTickCount;
    summary.bitmapChunkCount += pool.bitmapChunkCount;
    summary.tickChunkCount += pool.tickChunkCount;
  }

  return summary.returned > 0 ? summary : null;
}

export function shouldLogPoolStateApiBatch(
  response: FamePoolStateBatchResponse,
): boolean {
  return response.pools.some(
    (pool) => pool.status !== "fresh" || isClReplayResponse(pool),
  );
}

export function poolStateApiBatchLogFields(
  response: FamePoolStateBatchResponse,
): PoolStateLogFields {
  const fields: PoolStateLogFields = {
    sourceRegistryId: response.sourceRegistryId,
    currentBlock: response.currentBlock,
    effectiveMaxFreshnessBlocks: response.effectiveMaxFreshnessBlocks,
    batchSize: response.pools.length,
    statusCounts: statusCounts(response),
  };
  const replay = clReplaySummary(response);
  if (replay) fields.clReplay = replay;
  return fields;
}

export function writePoolStateLog(
  level: PoolStateLogLevel,
  event: PoolStateLogEvent,
  fields: PoolStateLogFields,
): void {
  const line = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  });

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function indexerResultLogFields(
  result: FamePoolStateIndexerResult,
): PoolStateLogFields {
  return {
    chainId: result.chainId,
    durationMs: result.durationMs,
    fromBlock: result.fromBlock,
    observedThroughBlock: result.observedThroughBlock,
    syncEvents: result.syncEvents,
    writtenEvents: result.writtenEvents,
    ignoredEvents: result.ignoredEvents,
    seededPools: result.seededPools,
    reconciledPools: result.reconciledPools,
    observedPools: result.observedPools,
    clHeadSnapshots: result.clHeadSnapshots,
    clHeadWrittenPools: result.clHeadWrittenPools,
    clHeadFailedPools: result.clHeadFailedPools,
    clHeadFailures: result.clHeadFailures.map((failure) => ({
      poolId: failure.poolId,
      message: failure.message,
    })),
    clReplaySnapshots: result.clReplaySnapshots,
    clReplayWrittenPools: result.clReplayWrittenPools,
    clReplayFailedPools: result.clReplayFailedPools,
    clReplayFailures: result.clReplayFailures.map((failure) => ({
      poolId: failure.poolId,
      message: failure.message,
    })),
    clReplayMetrics: result.clReplayMetrics.map((metric) => ({
      poolId: metric.poolId,
      bitmapWordCount: metric.bitmapWordCount,
      initializedTickCount: metric.initializedTickCount,
      bitmapChunkCount: metric.bitmapChunkCount,
      tickChunkCount: metric.tickChunkCount,
      providerReadCount: metric.providerReadCount,
      durationMs: metric.durationMs,
      stateHash: metric.stateHash,
    })),
    sourceRegistryId: result.sourceRegistryId,
  };
}

export function logPoolStateApiBatch(
  response: FamePoolStateBatchResponse,
): void {
  if (!shouldLogPoolStateApiBatch(response)) return;
  writePoolStateLog(
    "info",
    "fame-pool-state-api-batch",
    poolStateApiBatchLogFields(response),
  );
}

export function logPoolStateIndexerResult(
  result: FamePoolStateIndexerResult,
): void {
  writePoolStateLog(
    result.clReplayFailedPools > 0 ? "error" : "info",
    "fame-pool-state-indexed",
    indexerResultLogFields(result),
  );
}
