import type {
  FamePoolStateBatchResponse,
  FamePoolStateResponseEntry,
} from "../api.ts";
import { FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID } from "../cl-reducer-manifests.ts";
import {
  FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
  FAME_V4_ZORA_QUOTE_LANE_POOL_IDS,
} from "../v4-zora-manifests.ts";
import type {
  FamePoolQuoteBatchResponse,
  FamePoolQuoteResponseEntry,
} from "../cl-quote.ts";
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

interface SelectedClReplayCandidateLogSummary extends PoolStateLogFields {
  poolId: string;
  providerReadCount: number | null;
  bitmapWordCount: number | null;
  initializedTickCount: number | null;
  bitmapChunkCount: number | null;
  tickChunkCount: number | null;
  scannedLogCount: number | null;
  appliedEventCount: number | null;
  maintenanceStatus: string | null;
  maintenanceReason: string | null;
  candidateWritten: boolean | null;
  stateHash: string | null;
}

interface SelectedClReplayCandidateQuoteLogSummary extends PoolStateLogFields {
  poolId: string;
  returned: number;
  statusCounts: Record<string, number>;
  reasonCounts: Record<string, number>;
}

interface SelectedV4ZoraReplayLogSummary extends PoolStateLogFields {
  poolId: string;
  providerReadCount: number | null;
  bitmapWordCount: number | null;
  initializedTickCount: number | null;
  bitmapChunkCount: number | null;
  tickChunkCount: number | null;
  scannedLogCount: number | null;
  appliedEventCount: number | null;
  maintenanceStatus: string | null;
  maintenanceReason: string | null;
  candidateWritten: boolean | null;
  lpFee: string | null;
  protocolFee: string | null;
  stateHash: string | null;
}

type ClReplayResponseEntry = Extract<
  FamePoolStateResponseEntry,
  { stateKind: "cl-replay-v1" }
>;
type V4ClReplayResponseEntry = Extract<
  FamePoolStateResponseEntry,
  { stateKind: "v4-cl-replay-v1" }
>;

function statusCounts(response: Pick<FamePoolStateBatchResponse, "pools">) {
  const counts: Record<string, number> = {};
  for (const pool of response.pools) {
    counts[pool.status] = (counts[pool.status] ?? 0) + 1;
  }
  return counts;
}

function poolQuoteStatusCounts(quotes: FamePoolQuoteResponseEntry[]) {
  const statusCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  for (const quote of quotes) {
    statusCounts[quote.status] = (statusCounts[quote.status] ?? 0) + 1;
    if (quote.status === "unavailable") {
      reasonCounts[quote.reason] = (reasonCounts[quote.reason] ?? 0) + 1;
    }
  }
  return { statusCounts, reasonCounts };
}

function poolQuotePoolId(quote: FamePoolQuoteResponseEntry): string {
  return quote.status === "unavailable" ? quote.requested.poolId : quote.poolId;
}

function selectedClReplayCandidateQuoteLogSummary(
  response: Pick<FamePoolQuoteBatchResponse, "quotes">,
): SelectedClReplayCandidateQuoteLogSummary | null {
  const selectedQuotes = response.quotes.filter(
    (quote) =>
      poolQuotePoolId(quote) === FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
  );
  if (selectedQuotes.length === 0) return null;

  const counts = poolQuoteStatusCounts(selectedQuotes);
  return {
    poolId: FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
    returned: selectedQuotes.length,
    statusCounts: counts.statusCounts,
    reasonCounts: counts.reasonCounts,
  };
}

function selectedV4ZoraQuoteLogSummary(
  response: Pick<FamePoolQuoteBatchResponse, "quotes">,
  poolId = FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
): SelectedClReplayCandidateQuoteLogSummary | null {
  const selectedQuotes = response.quotes.filter(
    (quote) => poolQuotePoolId(quote) === poolId,
  );
  if (selectedQuotes.length === 0) return null;

  const counts = poolQuoteStatusCounts(selectedQuotes);
  return {
    poolId,
    returned: selectedQuotes.length,
    statusCounts: counts.statusCounts,
    reasonCounts: counts.reasonCounts,
  };
}

function reviewedV4ZoraQuoteLogSummaries(
  response: Pick<FamePoolQuoteBatchResponse, "quotes">,
): SelectedClReplayCandidateQuoteLogSummary[] {
  return FAME_V4_ZORA_QUOTE_LANE_POOL_IDS.flatMap((poolId) => {
    const summary = selectedV4ZoraQuoteLogSummary(response, poolId);
    return summary ? [summary] : [];
  });
}

function isClReplayResponse(
  pool: FamePoolStateResponseEntry,
): pool is ClReplayResponseEntry {
  return "stateKind" in pool && pool.stateKind === "cl-replay-v1";
}

function isV4ClReplayResponse(
  pool: FamePoolStateResponseEntry,
): pool is V4ClReplayResponseEntry {
  return "stateKind" in pool && pool.stateKind === "v4-cl-replay-v1";
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

function v4ClReplaySummary(
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
    if (!isV4ClReplayResponse(pool)) continue;
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
    (pool) =>
      pool.status !== "fresh" ||
      isClReplayResponse(pool) ||
      isV4ClReplayResponse(pool),
  );
}

export function poolStateApiBatchLogFields(
  response: FamePoolStateBatchResponse,
): PoolStateLogFields {
  const fields: PoolStateLogFields = {
    routeKind: "pool-state",
    sourceRegistryId: response.sourceRegistryId,
    currentBlock: response.currentBlock,
    effectiveMaxFreshnessBlocks: response.effectiveMaxFreshnessBlocks,
    batchSize: response.pools.length,
    statusCounts: statusCounts(response),
  };
  const replay = clReplaySummary(response);
  if (replay) fields.clReplay = replay;
  const v4Replay = v4ClReplaySummary(response);
  if (v4Replay) fields.v4ClReplay = v4Replay;
  return fields;
}

export function poolQuoteApiBatchLogFields(
  response: FamePoolQuoteBatchResponse,
): PoolStateLogFields {
  const counts = poolQuoteStatusCounts(response.quotes);
  const fields: PoolStateLogFields = {
    routeKind: "pool-quotes",
    sourceRegistryId: response.sourceRegistryId,
    currentBlock: response.currentBlock,
    effectiveMaxFreshnessBlocks: response.effectiveMaxFreshnessBlocks,
    batchSize: response.quotes.length,
    statusCounts: counts.statusCounts,
    reasonCounts: counts.reasonCounts,
  };
  const selectedCandidate = selectedClReplayCandidateQuoteLogSummary(response);
  if (selectedCandidate) {
    fields.selectedClReplayCandidateQuote = selectedCandidate;
  }
  const selectedV4Zora = selectedV4ZoraQuoteLogSummary(response);
  if (selectedV4Zora) {
    fields.selectedV4ZoraQuote = selectedV4Zora;
  }
  const reviewedV4Zora = reviewedV4ZoraQuoteLogSummaries(response);
  if (reviewedV4Zora.length > 0) {
    fields.reviewedV4ZoraQuotes = reviewedV4Zora;
  }
  return fields;
}

export function writePoolStateLog(
  level: PoolStateLogLevel,
  event: PoolStateLogEvent,
  fields: PoolStateLogFields,
): void {
  const line = JSON.stringify({
    ...fields,
    level,
    event,
    timestamp: new Date().toISOString(),
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
  const fields: PoolStateLogFields = {
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
    clReplayMaintenanceMetrics: result.clReplayMaintenanceMetrics.map(
      (metric) => ({
        poolId: metric.poolId,
        status: metric.status,
        reason: metric.reason,
        fromBlock: metric.fromBlock,
        toBlock: metric.toBlock,
        scannedLogCount: metric.scannedLogCount,
        appliedEventCount: metric.appliedEventCount,
        candidateWritten: metric.candidateWritten,
        stateHash: metric.stateHash,
      }),
    ),
    v4ClReplaySnapshots: result.v4ClReplaySnapshots,
    v4ClReplayWrittenPools: result.v4ClReplayWrittenPools,
    v4ClReplayFailedPools: result.v4ClReplayFailedPools,
    v4ClReplayFailures: result.v4ClReplayFailures.map((failure) => ({
      poolId: failure.poolId,
      message: failure.message,
    })),
    v4ClReplayMetrics: result.v4ClReplayMetrics.map((metric) => ({
      poolId: metric.poolId,
      bitmapWordCount: metric.bitmapWordCount,
      initializedTickCount: metric.initializedTickCount,
      bitmapChunkCount: metric.bitmapChunkCount,
      tickChunkCount: metric.tickChunkCount,
      providerReadCount: metric.providerReadCount,
      durationMs: metric.durationMs,
      stateHash: metric.stateHash,
      lpFee: metric.lpFee,
      protocolFee: metric.protocolFee,
    })),
    v4ClReplayMaintenanceMetrics: result.v4ClReplayMaintenanceMetrics.map(
      (metric) => ({
        poolId: metric.poolId,
        status: metric.status,
        reason: metric.reason,
        fromBlock: metric.fromBlock,
        toBlock: metric.toBlock,
        scannedLogCount: metric.scannedLogCount,
        appliedEventCount: metric.appliedEventCount,
        candidateWritten: metric.candidateWritten,
        stateHash: metric.stateHash,
      }),
    ),
    sourceRegistryId: result.sourceRegistryId,
  };
  const selectedCandidate = selectedClReplayCandidateLogSummary(result);
  if (selectedCandidate) fields.selectedClReplayCandidate = selectedCandidate;
  const selectedV4Zora = selectedV4ZoraReplayLogSummary(result);
  if (selectedV4Zora) fields.selectedV4ZoraReplay = selectedV4Zora;
  const reviewedV4Zora = reviewedV4ZoraReplayLogSummaries(result);
  if (reviewedV4Zora.length > 0) {
    fields.reviewedV4ZoraReplay = reviewedV4Zora;
  }
  return fields;
}

function selectedClReplayCandidateLogSummary(
  result: FamePoolStateIndexerResult,
): SelectedClReplayCandidateLogSummary | null {
  const snapshot = result.clReplayMetrics.find(
    (metric) => metric.poolId === FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
  );
  const maintenance = result.clReplayMaintenanceMetrics.find(
    (metric) => metric.poolId === FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
  );
  if (!snapshot && !maintenance) return null;

  return {
    poolId: FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
    providerReadCount: snapshot?.providerReadCount ?? null,
    bitmapWordCount: snapshot?.bitmapWordCount ?? null,
    initializedTickCount: snapshot?.initializedTickCount ?? null,
    bitmapChunkCount: snapshot?.bitmapChunkCount ?? null,
    tickChunkCount: snapshot?.tickChunkCount ?? null,
    scannedLogCount: maintenance?.scannedLogCount ?? null,
    appliedEventCount: maintenance?.appliedEventCount ?? null,
    maintenanceStatus: maintenance?.status ?? null,
    maintenanceReason: maintenance?.reason ?? null,
    candidateWritten: maintenance?.candidateWritten ?? null,
    stateHash: maintenance?.stateHash ?? snapshot?.stateHash ?? null,
  };
}

function selectedV4ZoraReplayLogSummary(
  result: FamePoolStateIndexerResult,
  poolId = FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
): SelectedV4ZoraReplayLogSummary | null {
  const snapshot = result.v4ClReplayMetrics.find(
    (metric) => metric.poolId === poolId,
  );
  const maintenance = result.v4ClReplayMaintenanceMetrics.find(
    (metric) => metric.poolId === poolId,
  );
  if (!snapshot && !maintenance) return null;

  return {
    poolId,
    providerReadCount: snapshot?.providerReadCount ?? null,
    bitmapWordCount: snapshot?.bitmapWordCount ?? null,
    initializedTickCount: snapshot?.initializedTickCount ?? null,
    bitmapChunkCount: snapshot?.bitmapChunkCount ?? null,
    tickChunkCount: snapshot?.tickChunkCount ?? null,
    scannedLogCount: maintenance?.scannedLogCount ?? null,
    appliedEventCount: maintenance?.appliedEventCount ?? null,
    maintenanceStatus: maintenance?.status ?? null,
    maintenanceReason: maintenance?.reason ?? null,
    candidateWritten: maintenance?.candidateWritten ?? null,
    lpFee: snapshot?.lpFee ?? null,
    protocolFee: snapshot?.protocolFee ?? null,
    stateHash: maintenance?.stateHash ?? snapshot?.stateHash ?? null,
  };
}

function reviewedV4ZoraReplayLogSummaries(
  result: FamePoolStateIndexerResult,
): SelectedV4ZoraReplayLogSummary[] {
  return FAME_V4_ZORA_QUOTE_LANE_POOL_IDS.flatMap((poolId) => {
    const summary = selectedV4ZoraReplayLogSummary(result, poolId);
    return summary ? [summary] : [];
  });
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

export function logPoolQuoteApiBatch(
  response: FamePoolQuoteBatchResponse,
): void {
  writePoolStateLog(
    "info",
    "fame-pool-state-api-batch",
    poolQuoteApiBatchLogFields(response),
  );
}

export function logPoolStateIndexerResult(
  result: FamePoolStateIndexerResult,
): void {
  writePoolStateLog(
    result.clReplayFailedPools > 0 || result.v4ClReplayFailedPools > 0
      ? "error"
      : "info",
    "fame-pool-state-indexed",
    indexerResultLogFields(result),
  );
}
