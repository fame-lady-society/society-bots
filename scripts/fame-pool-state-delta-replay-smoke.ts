import { readFileSync } from "node:fs";
import type {
  FameClReplayMaintenanceMetric,
  FameClReplaySnapshotMetric,
  FamePoolStateIndexerResult,
} from "../src/fame-swap-pool-state/indexer.ts";
import type {
  FamePoolQuoteBatchResponse,
  FamePoolQuoteUnavailableReason,
} from "../src/fame-swap-pool-state/cl-quote.ts";

export interface FameDeltaReplaySmokeInput {
  indexer: Pick<
    FamePoolStateIndexerResult,
    | "sourceRegistryId"
    | "observedThroughBlock"
    | "clReplaySnapshots"
    | "clReplayMetrics"
    | "clReplayMaintenanceMetrics"
  >;
  quoteResponse?: FamePoolQuoteBatchResponse;
}

export interface FameDeltaReplaySmokeReport {
  sourceRegistryId: string;
  observedThroughBlock: number;
  replaySnapshotCount: number;
  providerReadCount: number;
  maintenance: {
    poolId: string;
    status: FameClReplayMaintenanceMetric["status"];
    reason: string | null;
    fromBlock: number;
    toBlock: number;
    scannedLogCount: number;
    appliedEventCount: number;
    candidateWritten: boolean;
    stateHash: string | null;
  }[];
  quote: {
    quoted: number;
    unavailable: number;
    unavailableReasons: Partial<Record<FamePoolQuoteUnavailableReason, number>>;
  } | null;
}

function sumProviderReads(
  metrics: readonly FameClReplaySnapshotMetric[],
): number {
  return metrics.reduce(
    (total, metric) => total + metric.providerReadCount,
    0,
  );
}

function quoteSummary(response: FamePoolQuoteBatchResponse | undefined) {
  if (!response) return null;
  const unavailableReasons: Partial<
    Record<FamePoolQuoteUnavailableReason, number>
  > = {};
  let quoted = 0;
  let unavailable = 0;
  for (const quote of response.quotes) {
    if (quote.status === "quoted") {
      quoted += 1;
      continue;
    }
    unavailable += 1;
    unavailableReasons[quote.reason] =
      (unavailableReasons[quote.reason] ?? 0) + 1;
  }
  return {
    quoted,
    unavailable,
    unavailableReasons,
  };
}

function maintenanceReport(metric: FameClReplayMaintenanceMetric) {
  return {
    poolId: metric.poolId,
    status: metric.status,
    reason: metric.reason,
    fromBlock: metric.fromBlock,
    toBlock: metric.toBlock,
    scannedLogCount: metric.scannedLogCount,
    appliedEventCount: metric.appliedEventCount,
    candidateWritten: metric.candidateWritten,
    stateHash: metric.stateHash,
  };
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return value;
}

function validateSmokeInput(value: unknown): FameDeltaReplaySmokeInput {
  const input = objectValue(value, "Delta replay smoke input");
  const indexer = objectValue(input.indexer, "indexer");
  const sourceRegistryId = stringValue(
    indexer.sourceRegistryId,
    "indexer.sourceRegistryId",
  );
  const observedThroughBlock = numberValue(
    indexer.observedThroughBlock,
    "indexer.observedThroughBlock",
  );
  const clReplaySnapshots = numberValue(
    indexer.clReplaySnapshots,
    "indexer.clReplaySnapshots",
  );
  arrayValue(indexer.clReplayMetrics, "indexer.clReplayMetrics");
  arrayValue(
    indexer.clReplayMaintenanceMetrics,
    "indexer.clReplayMaintenanceMetrics",
  );
  if (input.quoteResponse !== undefined) {
    const quoteResponse = objectValue(input.quoteResponse, "quoteResponse");
    arrayValue(quoteResponse.quotes, "quoteResponse.quotes");
  }
  return {
    indexer: {
      sourceRegistryId,
      observedThroughBlock,
      clReplaySnapshots,
      clReplayMetrics:
        indexer.clReplayMetrics as FameClReplaySnapshotMetric[],
      clReplayMaintenanceMetrics:
        indexer.clReplayMaintenanceMetrics as FameClReplayMaintenanceMetric[],
    },
    quoteResponse: input.quoteResponse as FamePoolQuoteBatchResponse | undefined,
  };
}

export function buildFameDeltaReplaySmokeReport(
  input: FameDeltaReplaySmokeInput,
): FameDeltaReplaySmokeReport {
  return {
    sourceRegistryId: input.indexer.sourceRegistryId,
    observedThroughBlock: input.indexer.observedThroughBlock,
    replaySnapshotCount: input.indexer.clReplaySnapshots,
    providerReadCount: sumProviderReads(input.indexer.clReplayMetrics),
    maintenance: input.indexer.clReplayMaintenanceMetrics.map(
      maintenanceReport,
    ),
    quote: quoteSummary(input.quoteResponse),
  };
}

function parseInput(path: string): FameDeltaReplaySmokeInput {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return validateSmokeInput(parsed);
}

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error(
      "Usage: yarn fame-pool-state:delta-replay-smoke <input-json>",
    );
  }
  const report = buildFameDeltaReplaySmokeReport(parseInput(inputPath));
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1]?.endsWith("fame-pool-state-delta-replay-smoke.ts")) {
  main();
}
