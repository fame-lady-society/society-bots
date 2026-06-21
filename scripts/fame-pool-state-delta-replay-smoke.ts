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
import type { FamePoolActivationStatus } from "../src/fame-swap-pool-state/types.ts";
import {
  FAME_V4_ZORA_ETH_QUOTE_LANE_POOL_ID,
  FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
  fameV4ZoraQuoteLaneManifestForPool,
} from "../src/fame-swap-pool-state/v4-zora-manifests.ts";

const SELECTED_CL_ACTIVATION_CANDIDATE = "slipstream-basedflick-fame";
const LIVE_ROUTE_DEPENDENCY = "uniswap-v4-basedflick-zora";
const BASELINE_CL_COMPACT_POOL_ID = "slipstream-usdc-weth-100";
const DEFAULT_PROVIDER_READ_THRESHOLD = 1_000;
const V4_REVIEWED_LANE_DIRECTION_COVERAGE: Record<string, readonly string[]> = {
  [FAME_V4_ZORA_QUOTE_LANE_POOL_ID]: ["BASEDFLICK->ZORA", "ZORA->BASEDFLICK"],
  [FAME_V4_ZORA_ETH_QUOTE_LANE_POOL_ID]: ["ETH->ZORA", "ZORA->ETH"],
};
const FAME_UPSTREAM_POOL_UNIVERSE_POOL_IDS = [
  "aerodrome-v2-usdc-weth",
  "scale-equalizer-frxusd-fame",
  "scale-equalizer-scale-fame",
  "scale-equalizer-usdc-frxusd",
  "scale-equalizer-usdc-scale",
  "scale-equalizer-weth-fame",
  "slipstream-basedflick-fame",
  "slipstream-spx-weth",
  "slipstream-usdc-frxusd",
  "slipstream-usdc-weth-100",
  "slipstream-usdc-weth-migrating-50",
  "slipstream-zora-usdc",
  "slipstream-zora-weth",
  "uniswap-v2-fame-direct",
  "uniswap-v2-usdc-weth",
  "uniswap-v3-usdc-weth-30bps",
  "uniswap-v3-usdc-weth-5bps",
  "uniswap-v3-zora-usdc",
  "uniswap-v3-zora-weth",
  "uniswap-v4-basedflick-zora",
  "uniswap-v4-usdc-eth",
  "uniswap-v4-zora-eth",
] as const;
const FAME_POOL_ACTIVATION_STATUS_VALUES = [
  "reserve-compact-quote-active",
  "cl-compact-quote-active",
  "cl-replay-candidate",
  "cl-head-only",
  "tracked-only",
  "blocked",
  "unsupported",
  "producer-unrepresented",
] as const satisfies readonly FamePoolActivationStatus[];
const FAME_UPSTREAM_POOL_UNIVERSE_COUNT =
  FAME_UPSTREAM_POOL_UNIVERSE_POOL_IDS.length;

type FameV4ReviewedPoolEvidenceKind =
  | "zora-protocol-pool"
  | "zero-hook-static-fee";

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
  routeLab?: FameRouteLabEvidenceInput;
  activationReport?: FamePoolActivationReportEvidenceInput;
  v4ZoraActivation?: FameV4ZoraActivationEvidenceInput;
  v4ReviewedActivations?: readonly FameV4ZoraActivationEvidenceInput[];
  providerReadThreshold?: number;
}

export interface FameRouteLabSelectedQuoteSourceEvidence {
  poolId: string;
  source: string;
  tokenIn?: string;
  tokenOut?: string;
  amountIn?: string;
}

export interface FameRouteLabSelectedActivationEvidence {
  selectedPoolId: string;
  liveDependencyPoolId: string;
  selectedPoolSource: string;
  liveDependencySource: string;
  outcome: string;
}

export interface FameRouteLabEvidenceRow {
  id: string;
  mode: string;
  status: string;
  requestedRouteId?: string | null;
  routeArtifactId?: string | null;
  selectedCandidateId?: string | null;
  materializedRouteHash?: string | null;
  selectedPools: string[];
  selectedQuoteSources: FameRouteLabSelectedQuoteSourceEvidence[];
  selectedActivation: FameRouteLabSelectedActivationEvidence | null;
  quoteContext?: string | null;
  indexedPoolState?: {
    sourceRegistryId?: string;
    currentBlock?: number;
    effectiveMaxFreshnessBlocks?: number;
  } | null;
  quoteApi?: FameRouteLabQuoteApiEvidence | null;
  simulation?: FameRouteLabSimulationEvidence | null;
}

export type FameRouteLabEvidenceInput =
  | readonly unknown[]
  | { rows: readonly unknown[] };

export interface FameRouteLabQuoteApiEvidence {
  sourceRegistryId: string;
  currentBlock: number;
  maxFreshnessBlocks?: number | null;
  diagnostics?: {
    details?: readonly FameRouteLabQuoteApiDetailEvidence[];
  };
}

export interface FameRouteLabQuoteApiDetailEvidence {
  poolId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  outcome: string;
}

export interface FameRouteLabSimulationEvidence {
  status: string;
}

export interface FameActivationReportPoolEvidence {
  poolId: string;
  activationStatus: FamePoolActivationStatus;
  producerRegistryPresence?: string;
  consumerQuoteCapability?: string;
  selectedCandidate?: boolean;
  liveRouteDependency?: boolean;
  liveRouteDependencies?: readonly string[];
  producerRegistryEntry?: {
    activationStatus?: FamePoolActivationStatus;
  } | null;
  reason?: string;
}

export interface FamePoolActivationReportEvidenceInput {
  status: "generated-reviewed-activation";
  selectedCandidatePoolId: string;
  liveRouteDependencyPoolId: string;
  upstreamPoolCount: number;
  upstreamPools: readonly FameActivationReportPoolEvidence[];
  statusCounts?: Partial<Record<FamePoolActivationStatus, number>>;
}

export interface FameV4ZoraActivationEvidenceInput {
  poolId: string;
  status: "active" | "blocked" | "pending";
  reviewedPoolEvidenceKind?: FameV4ReviewedPoolEvidenceKind;
  provenanceStatus: "verified" | "missing" | "mismatch" | "not-applicable";
  shapeStatus: "matched" | "mismatch" | "unknown";
  stateStatus: "fresh" | "stale" | "missing" | "incomplete";
  quoteStatus: "quoted" | "unavailable" | "missing";
  parityStatus: "passed" | "failed" | "missing";
  routeSimulationStatus: "passed" | "failed" | "missing";
  directionCoverage: readonly string[];
  sourceRegistryId?: string;
  evidenceId?: string;
  providerReadCount?: number;
  fallbackCount?: number;
  unavailableReasons?: Partial<Record<FamePoolQuoteUnavailableReason, number>>;
  deferredHardening?: readonly string[];
}

interface FameEvidenceGate {
  name: string;
  passed: boolean;
  detail: string;
}

interface FameRouteDependencyEvidence {
  routeLabRowId: string | null;
  requestedRouteId: string | null;
  routeArtifactId: string | null;
  selectedCandidateId: string | null;
  materializedRouteHash: string | null;
  routeLabMode: string | null;
  routeLabStatus: string | null;
  routeSimulationStatus: string | null;
  selectedPools: string[];
  selectedPoolSource: string | null;
  liveDependencySource: string | null;
  selectedPoolQuote: {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
  } | null;
  outcome: string | null;
  selectedRoutePresent: boolean;
  evidenceSourceRegistryId: string | null;
  indexedSourceRegistryId: string | null;
  quoteApiSourceRegistryId: string | null;
  indexedCurrentBlock: number | null;
}

interface FameActivationBaselineEvidence {
  baselineCompactClPoolIds: string[];
  compactClPoolIdsWithSelected: string[];
  additionalCompactClPoolIds: string[];
  exactlyOneAdditionalPoolClaim: boolean;
}

interface FameActivationNonPromotionEvidence {
  clHeadOnlyPoolIds: string[];
  trackedOnlyPoolIds: string[];
  unsupportedPoolIds: string[];
  producerUnrepresentedPoolIds: string[];
  blockedPoolIds: string[];
}

interface FameSelectedCandidateEvidence {
  poolId: string;
  reviewedActivationStatus: FamePoolActivationStatus | null;
  producerRegistryActivationStatus: FamePoolActivationStatus | null;
  consumerQuoteCapability: string | null;
  maintenanceStatus: FameClReplayMaintenanceMetric["status"] | null;
  maintenanceReason: string | null;
  maintenanceRange: { fromBlock: number; toBlock: number } | null;
  appliedEventCount: number | null;
  scannedLogCount: number | null;
  candidateWritten: boolean | null;
  stateHash: string | null;
  providerReadCount: number | null;
  compactQuoteUsedCount: number;
}

export interface FameDeltaReplayActivationEvidence {
  status: "ready" | "blocked";
  validationErrors: string[];
  providerReadThreshold: number;
  selectedCandidate: FameSelectedCandidateEvidence;
  v4ZoraActivation: FameV4ZoraActivationEvidence;
  v4ReviewedActivations: FameV4ZoraActivationEvidence[];
  routeDependency: FameRouteDependencyEvidence;
  baseline: FameActivationBaselineEvidence;
  nonPromotion: FameActivationNonPromotionEvidence;
  operatorGates: FameEvidenceGate[];
}

export interface FameV4ZoraActivationEvidence {
  poolId: string;
  status: "active" | "blocked" | "pending";
  poolQuoteStatus: "active" | "blocked" | "pending";
  routeEligibilityStatus: "active" | "blocked" | "pending";
  reviewedPoolEvidenceKind: FameV4ReviewedPoolEvidenceKind | null;
  expectedReviewedPoolEvidenceKind: FameV4ReviewedPoolEvidenceKind | null;
  provenanceStatus: FameV4ZoraActivationEvidenceInput["provenanceStatus"];
  shapeStatus: FameV4ZoraActivationEvidenceInput["shapeStatus"];
  stateStatus: FameV4ZoraActivationEvidenceInput["stateStatus"];
  quoteStatus: FameV4ZoraActivationEvidenceInput["quoteStatus"];
  parityStatus: FameV4ZoraActivationEvidenceInput["parityStatus"];
  routeSimulationStatus: FameV4ZoraActivationEvidenceInput["routeSimulationStatus"];
  directionCoverage: string[];
  sourceRegistryId: string | null;
  evidenceId: string | null;
  providerReadCount: number | null;
  fallbackCount: number | null;
  unavailableReasons: Partial<Record<FamePoolQuoteUnavailableReason, number>>;
  deferredHardening: string[];
  poolQuoteGates: FameEvidenceGate[];
  routeEligibilityGates: FameEvidenceGate[];
  gates: FameEvidenceGate[];
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
    quotedByKind: Record<string, number>;
    quotedByPoolId: Record<string, number>;
    unavailableByPoolId: Record<string, number>;
  } | null;
  activationEvidence: FameDeltaReplayActivationEvidence;
}

function sumProviderReads(
  metrics: readonly FameClReplaySnapshotMetric[],
): number {
  return metrics.reduce((total, metric) => total + metric.providerReadCount, 0);
}

function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function safeReasonCode(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (/^[a-z0-9][a-z0-9-]{0,79}$/u.test(trimmed)) return trimmed;
  return "redacted-reason";
}

function quoteSummary(response: FamePoolQuoteBatchResponse | undefined) {
  if (!response) return null;
  const unavailableReasons: Partial<
    Record<FamePoolQuoteUnavailableReason, number>
  > = {};
  const quotedByKind: Record<string, number> = {};
  const quotedByPoolId: Record<string, number> = {};
  const unavailableByPoolId: Record<string, number> = {};
  let quoted = 0;
  let unavailable = 0;
  for (const quote of response.quotes) {
    if (quote.status === "quoted") {
      quoted += 1;
      incrementCount(quotedByKind, quote.quoteKind);
      incrementCount(quotedByPoolId, quote.poolId);
      continue;
    }
    unavailable += 1;
    unavailableReasons[quote.reason] =
      (unavailableReasons[quote.reason] ?? 0) + 1;
    incrementCount(unavailableByPoolId, quote.poolId ?? quote.requested.poolId);
  }
  return {
    quoted,
    unavailable,
    unavailableReasons,
    quotedByKind,
    quotedByPoolId,
    unavailableByPoolId,
  };
}

function maintenanceReport(metric: FameClReplayMaintenanceMetric) {
  return {
    poolId: metric.poolId,
    status: metric.status,
    reason: safeReasonCode(metric.reason),
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

function activationStatusValue(
  value: unknown,
  name: string,
): FamePoolActivationStatus {
  const status = stringValue(value, name);
  if (
    !(FAME_POOL_ACTIVATION_STATUS_VALUES as readonly string[]).includes(status)
  ) {
    throw new Error(`${name} must be a known activation status.`);
  }
  return status as FamePoolActivationStatus;
}

function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return value;
}

function optionalNumberValue(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return numberValue(value, name);
}

function optionalNonNegativeNumberValue(
  value: unknown,
  name: string,
): number | undefined {
  const parsed = optionalNumberValue(value, name);
  if (parsed !== undefined && parsed < 0) {
    throw new Error(`${name} must be non-negative.`);
  }
  return parsed;
}

function optionalStringValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, name);
}

function stringEnumValue<T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T,
): T[number] {
  const parsed = stringValue(value, name);
  if (!allowed.includes(parsed)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}.`);
  }
  return parsed;
}

function unavailableReasonCountsValue(
  value: unknown,
  name: string,
): Partial<Record<FamePoolQuoteUnavailableReason, number>> | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value, name);
  const counts: Partial<Record<FamePoolQuoteUnavailableReason, number>> = {};
  for (const [reason, count] of Object.entries(record)) {
    counts[reason as FamePoolQuoteUnavailableReason] = numberValue(
      count,
      `${name}.${reason}`,
    );
  }
  return counts;
}

function activationStatusCountsValue(
  value: unknown,
  name: string,
): Partial<Record<FamePoolActivationStatus, number>> | undefined {
  if (value === undefined) return undefined;
  const record = objectValue(value, name);
  const counts: Partial<Record<FamePoolActivationStatus, number>> = {};
  for (const status of FAME_POOL_ACTIVATION_STATUS_VALUES) {
    if (record[status] !== undefined) {
      counts[status] = numberValue(record[status], `${name}.${status}`);
    }
  }
  for (const key of Object.keys(record)) {
    if (!FAME_POOL_ACTIVATION_STATUS_VALUES.some((status) => status === key)) {
      throw new Error(`${name}.${key} must be a known activation status.`);
    }
  }
  return counts;
}

function routeLabFallbackSource(quoteContext: string | null): string {
  if (!quoteContext) return "fallback";
  if (quoteContext.startsWith("live:")) return "live";
  if (quoteContext.startsWith("recorded:")) return "recorded";
  if (quoteContext.startsWith("indexed:")) return "indexed";
  if (quoteContext.startsWith("deterministic-test:")) return "deterministic";
  return "fallback";
}

function routeLabQuoteApiSource(
  outcome: string,
  quoteContext: string | null,
): string | null {
  if (outcome === "used") return "compact-indexed";
  if (outcome === "fallback") return routeLabFallbackSource(quoteContext);
  return null;
}

function routeLabQuoteApiValue(
  value: unknown,
  path: string,
): FameRouteLabQuoteApiEvidence | null {
  if (value === null || value === undefined) return null;
  const quoteApi = objectValue(value, path);
  const diagnostics =
    quoteApi.diagnostics === undefined || quoteApi.diagnostics === null
      ? undefined
      : (() => {
          const diagnosticRecord = objectValue(
            quoteApi.diagnostics,
            `${path}.diagnostics`,
          );
          const details =
            diagnosticRecord.details === undefined
              ? []
              : arrayValue(
                  diagnosticRecord.details,
                  `${path}.diagnostics.details`,
                ).map((detailValue, detailIndex) => {
                  const detailPath = `${path}.diagnostics.details[${detailIndex.toString()}]`;
                  const detail = objectValue(detailValue, detailPath);
                  return {
                    poolId: stringValue(detail.poolId, `${detailPath}.poolId`),
                    tokenIn: stringValue(
                      detail.tokenIn,
                      `${detailPath}.tokenIn`,
                    ),
                    tokenOut: stringValue(
                      detail.tokenOut,
                      `${detailPath}.tokenOut`,
                    ),
                    amountIn: stringValue(
                      detail.amountIn,
                      `${detailPath}.amountIn`,
                    ),
                    outcome: stringValue(
                      detail.outcome,
                      `${detailPath}.outcome`,
                    ),
                  };
                });
          return { details };
        })();
  return {
    sourceRegistryId: stringValue(
      quoteApi.sourceRegistryId,
      `${path}.sourceRegistryId`,
    ),
    currentBlock: numberValue(quoteApi.currentBlock, `${path}.currentBlock`),
    maxFreshnessBlocks:
      quoteApi.maxFreshnessBlocks === null
        ? null
        : optionalNumberValue(
            quoteApi.maxFreshnessBlocks,
            `${path}.maxFreshnessBlocks`,
          ),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

function routeLabSimulationValue(
  value: unknown,
  path: string,
): FameRouteLabSimulationEvidence | null {
  if (value === null || value === undefined) return null;
  const simulation = objectValue(value, path);
  return {
    status: stringValue(simulation.status, `${path}.status`),
  };
}

function selectedQuoteSourcesFromQuoteApi(
  quoteApi: FameRouteLabQuoteApiEvidence | null,
  quoteContext: string | null,
): FameRouteLabSelectedQuoteSourceEvidence[] {
  return (
    quoteApi?.diagnostics?.details?.flatMap(
      (detail): FameRouteLabSelectedQuoteSourceEvidence[] => {
        const source = routeLabQuoteApiSource(detail.outcome, quoteContext);
        if (!source) return [];
        return [
          {
            poolId: detail.poolId,
            source,
            tokenIn: detail.tokenIn,
            tokenOut: detail.tokenOut,
            amountIn: detail.amountIn,
          },
        ];
      },
    ) ?? []
  );
}

function routeLabRowsValue(
  value: unknown,
  name: string,
): FameRouteLabEvidenceRow[] | undefined {
  if (value === undefined) return undefined;
  const rowsValue = Array.isArray(value)
    ? value
    : arrayValue(objectValue(value, name).rows, `${name}.rows`);
  return rowsValue.map((rowValue, index) => {
    const path = `${name}.rows[${index.toString()}]`;
    const row = objectValue(rowValue, path);
    const quoteContext =
      row.quoteContext === null || row.quoteContext === undefined
        ? null
        : stringValue(row.quoteContext, `${path}.quoteContext`);
    const quoteApi = routeLabQuoteApiValue(row.quoteApi, `${path}.quoteApi`);
    const selectedQuoteSources =
      row.selectedQuoteSources === undefined
        ? selectedQuoteSourcesFromQuoteApi(quoteApi, quoteContext)
        : arrayValue(
            row.selectedQuoteSources,
            `${path}.selectedQuoteSources`,
          ).map((sourceValue, sourceIndex) => {
            const sourcePath = `${path}.selectedQuoteSources[${sourceIndex.toString()}]`;
            const source = objectValue(sourceValue, sourcePath);
            return {
              poolId: stringValue(source.poolId, `${sourcePath}.poolId`),
              source: stringValue(source.source, `${sourcePath}.source`),
              tokenIn:
                optionalStringValue(source.tokenIn, `${sourcePath}.tokenIn`) ??
                undefined,
              tokenOut:
                optionalStringValue(
                  source.tokenOut,
                  `${sourcePath}.tokenOut`,
                ) ?? undefined,
              amountIn:
                optionalStringValue(
                  source.amountIn,
                  `${sourcePath}.amountIn`,
                ) ?? undefined,
            };
          });
    const selectedActivation =
      row.selectedActivation === null || row.selectedActivation === undefined
        ? null
        : (() => {
            const activation = objectValue(
              row.selectedActivation,
              `${path}.selectedActivation`,
            );
            return {
              selectedPoolId: stringValue(
                activation.selectedPoolId,
                `${path}.selectedActivation.selectedPoolId`,
              ),
              liveDependencyPoolId: stringValue(
                activation.liveDependencyPoolId,
                `${path}.selectedActivation.liveDependencyPoolId`,
              ),
              selectedPoolSource: stringValue(
                activation.selectedPoolSource,
                `${path}.selectedActivation.selectedPoolSource`,
              ),
              liveDependencySource: stringValue(
                activation.liveDependencySource,
                `${path}.selectedActivation.liveDependencySource`,
              ),
              outcome: stringValue(
                activation.outcome,
                `${path}.selectedActivation.outcome`,
              ),
            };
          })();
    const indexedPoolState =
      row.indexedPoolState === null || row.indexedPoolState === undefined
        ? null
        : (() => {
            const indexed = objectValue(
              row.indexedPoolState,
              `${path}.indexedPoolState`,
            );
            return {
              sourceRegistryId:
                optionalStringValue(
                  indexed.sourceRegistryId,
                  `${path}.indexedPoolState.sourceRegistryId`,
                ) ?? undefined,
              currentBlock:
                optionalNumberValue(
                  indexed.currentBlock,
                  `${path}.indexedPoolState.currentBlock`,
                ) ?? undefined,
              effectiveMaxFreshnessBlocks:
                optionalNumberValue(
                  indexed.effectiveMaxFreshnessBlocks,
                  `${path}.indexedPoolState.effectiveMaxFreshnessBlocks`,
                ) ?? undefined,
            };
          })();

    return {
      id: stringValue(row.id, `${path}.id`),
      mode: stringValue(row.mode, `${path}.mode`),
      status: stringValue(row.status, `${path}.status`),
      requestedRouteId:
        row.requestedRouteId === null || row.requestedRouteId === undefined
          ? null
          : stringValue(row.requestedRouteId, `${path}.requestedRouteId`),
      routeArtifactId:
        row.routeArtifactId === null || row.routeArtifactId === undefined
          ? null
          : stringValue(row.routeArtifactId, `${path}.routeArtifactId`),
      selectedCandidateId:
        row.selectedCandidateId === null ||
        row.selectedCandidateId === undefined
          ? null
          : stringValue(row.selectedCandidateId, `${path}.selectedCandidateId`),
      materializedRouteHash:
        row.materializedRouteHash === null ||
        row.materializedRouteHash === undefined
          ? null
          : stringValue(
              row.materializedRouteHash,
              `${path}.materializedRouteHash`,
            ),
      selectedPools: arrayValue(row.selectedPools, `${path}.selectedPools`).map(
        (poolId, poolIndex) =>
          stringValue(poolId, `${path}.selectedPools[${poolIndex.toString()}]`),
      ),
      selectedQuoteSources,
      selectedActivation,
      quoteContext,
      indexedPoolState,
      quoteApi,
      simulation: routeLabSimulationValue(row.simulation, `${path}.simulation`),
    };
  });
}

function activationReportValue(
  value: unknown,
): FamePoolActivationReportEvidenceInput | undefined {
  if (value === undefined) return undefined;
  const report = objectValue(value, "activationReport");
  const status = stringValue(report.status, "activationReport.status");
  if (status !== "generated-reviewed-activation") {
    throw new Error(
      "activationReport.status must be generated-reviewed-activation.",
    );
  }
  return {
    status,
    selectedCandidatePoolId: stringValue(
      report.selectedCandidatePoolId,
      "activationReport.selectedCandidatePoolId",
    ),
    liveRouteDependencyPoolId: stringValue(
      report.liveRouteDependencyPoolId,
      "activationReport.liveRouteDependencyPoolId",
    ),
    upstreamPoolCount: numberValue(
      report.upstreamPoolCount,
      "activationReport.upstreamPoolCount",
    ),
    upstreamPools: arrayValue(
      report.upstreamPools,
      "activationReport.upstreamPools",
    ).map((entryValue, index) => {
      const path = `activationReport.upstreamPools[${index.toString()}]`;
      const entry = objectValue(entryValue, path);
      const producerRegistryEntry =
        entry.producerRegistryEntry === null ||
        entry.producerRegistryEntry === undefined
          ? null
          : objectValue(
              entry.producerRegistryEntry,
              `${path}.producerRegistryEntry`,
            );
      return {
        poolId: stringValue(entry.poolId, `${path}.poolId`),
        activationStatus: activationStatusValue(
          entry.activationStatus,
          `${path}.activationStatus`,
        ),
        producerRegistryPresence:
          optionalStringValue(
            entry.producerRegistryPresence,
            `${path}.producerRegistryPresence`,
          ) ?? undefined,
        consumerQuoteCapability:
          optionalStringValue(
            entry.consumerQuoteCapability,
            `${path}.consumerQuoteCapability`,
          ) ?? undefined,
        selectedCandidate:
          typeof entry.selectedCandidate === "boolean"
            ? entry.selectedCandidate
            : undefined,
        liveRouteDependency:
          typeof entry.liveRouteDependency === "boolean"
            ? entry.liveRouteDependency
            : undefined,
        liveRouteDependencies: Array.isArray(entry.liveRouteDependencies)
          ? entry.liveRouteDependencies.map((poolId, dependencyIndex) =>
              stringValue(
                poolId,
                `${path}.liveRouteDependencies[${dependencyIndex.toString()}]`,
              ),
            )
          : undefined,
        producerRegistryEntry: producerRegistryEntry
          ? {
              activationStatus: optionalStringValue(
                producerRegistryEntry.activationStatus,
                `${path}.producerRegistryEntry.activationStatus`,
              )
                ? activationStatusValue(
                    producerRegistryEntry.activationStatus,
                    `${path}.producerRegistryEntry.activationStatus`,
                  )
                : undefined,
            }
          : null,
        reason:
          optionalStringValue(entry.reason, `${path}.reason`) ?? undefined,
      };
    }),
    statusCounts: activationStatusCountsValue(
      report.statusCounts,
      "activationReport.statusCounts",
    ),
  };
}

function v4ZoraActivationValue(
  value: unknown,
  name = "v4ZoraActivation",
): FameV4ZoraActivationEvidenceInput | undefined {
  if (value === undefined) return undefined;
  const input = objectValue(value, name);
  return {
    poolId: stringValue(input.poolId, `${name}.poolId`),
    status: stringEnumValue(input.status, `${name}.status`, [
      "active",
      "blocked",
      "pending",
    ] as const),
    reviewedPoolEvidenceKind:
      input.reviewedPoolEvidenceKind === undefined
        ? undefined
        : stringEnumValue(
            input.reviewedPoolEvidenceKind,
            `${name}.reviewedPoolEvidenceKind`,
            ["zora-protocol-pool", "zero-hook-static-fee"] as const,
          ),
    provenanceStatus: stringEnumValue(
      input.provenanceStatus,
      `${name}.provenanceStatus`,
      ["verified", "missing", "mismatch", "not-applicable"] as const,
    ),
    shapeStatus: stringEnumValue(input.shapeStatus, `${name}.shapeStatus`, [
      "matched",
      "mismatch",
      "unknown",
    ] as const),
    stateStatus: stringEnumValue(input.stateStatus, `${name}.stateStatus`, [
      "fresh",
      "stale",
      "missing",
      "incomplete",
    ] as const),
    quoteStatus: stringEnumValue(input.quoteStatus, `${name}.quoteStatus`, [
      "quoted",
      "unavailable",
      "missing",
    ] as const),
    parityStatus: stringEnumValue(input.parityStatus, `${name}.parityStatus`, [
      "passed",
      "failed",
      "missing",
    ] as const),
    routeSimulationStatus: stringEnumValue(
      input.routeSimulationStatus,
      `${name}.routeSimulationStatus`,
      ["passed", "failed", "missing"] as const,
    ),
    directionCoverage: arrayValue(
      input.directionCoverage,
      `${name}.directionCoverage`,
    ).map((direction, index) =>
      stringValue(direction, `${name}.directionCoverage[${index.toString()}]`),
    ),
    sourceRegistryId:
      optionalStringValue(input.sourceRegistryId, `${name}.sourceRegistryId`) ??
      undefined,
    evidenceId:
      optionalStringValue(input.evidenceId, `${name}.evidenceId`) ?? undefined,
    providerReadCount:
      optionalNonNegativeNumberValue(
        input.providerReadCount,
        `${name}.providerReadCount`,
      ) ?? undefined,
    fallbackCount:
      optionalNonNegativeNumberValue(
        input.fallbackCount,
        `${name}.fallbackCount`,
      ) ?? undefined,
    unavailableReasons:
      unavailableReasonCountsValue(
        input.unavailableReasons,
        `${name}.unavailableReasons`,
      ) ?? undefined,
    deferredHardening: Array.isArray(input.deferredHardening)
      ? input.deferredHardening.map((item, index) =>
          stringValue(item, `${name}.deferredHardening[${index.toString()}]`),
        )
      : undefined,
  };
}

function v4ReviewedActivationsValue(
  value: unknown,
): FameV4ZoraActivationEvidenceInput[] | undefined {
  if (value === undefined) return undefined;
  return arrayValue(value, "v4ReviewedActivations").map((activation, index) => {
    const parsed = v4ZoraActivationValue(
      activation,
      `v4ReviewedActivations[${index.toString()}]`,
    );
    if (!parsed) {
      throw new Error("v4ReviewedActivations entries must be present.");
    }
    return parsed;
  });
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
  const providerReadThreshold = optionalNonNegativeNumberValue(
    input.providerReadThreshold,
    "providerReadThreshold",
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
      clReplayMetrics: indexer.clReplayMetrics as FameClReplaySnapshotMetric[],
      clReplayMaintenanceMetrics:
        indexer.clReplayMaintenanceMetrics as FameClReplayMaintenanceMetric[],
    },
    quoteResponse: input.quoteResponse as
      | FamePoolQuoteBatchResponse
      | undefined,
    routeLab: routeLabRowsValue(input.routeLab, "routeLab"),
    activationReport: activationReportValue(input.activationReport),
    v4ZoraActivation: v4ZoraActivationValue(input.v4ZoraActivation),
    v4ReviewedActivations: v4ReviewedActivationsValue(
      input.v4ReviewedActivations,
    ),
    ...(providerReadThreshold === undefined ? {} : { providerReadThreshold }),
  };
}

function routeLabRows(
  input: FameRouteLabEvidenceInput | undefined,
): FameRouteLabEvidenceRow[] {
  if (!input) return [];
  return routeLabRowsValue(input, "routeLab") ?? [];
}

function selectedRouteDependency(
  rows: readonly FameRouteLabEvidenceRow[],
  selectedPoolId = SELECTED_CL_ACTIVATION_CANDIDATE,
  liveDependencyPoolId = LIVE_ROUTE_DEPENDENCY,
): FameRouteDependencyEvidence {
  const row =
    rows.find(
      (candidate) =>
        candidate.selectedActivation?.selectedPoolId === selectedPoolId &&
        candidate.selectedActivation.liveDependencyPoolId ===
          liveDependencyPoolId,
    ) ??
    rows.find(
      (candidate) =>
        candidate.selectedPools.includes(selectedPoolId) ||
        candidate.selectedPools.includes(liveDependencyPoolId),
    );
  const sourceFor = (poolId: string) =>
    row?.selectedQuoteSources.find((source) => source.poolId === poolId)
      ?.source ?? null;
  const selectedSource = row?.selectedQuoteSources.find(
    (source) => source.poolId === selectedPoolId,
  );
  const selectedPoolSource =
    row?.selectedActivation?.selectedPoolSource ?? sourceFor(selectedPoolId);
  const liveDependencySource =
    row?.selectedActivation?.liveDependencySource ??
    sourceFor(liveDependencyPoolId);
  const inferredOutcome =
    selectedPoolSource === "compact-indexed" && liveDependencySource === "live"
      ? "compact_quote_with_live_dependency"
      : selectedPoolSource === "raw-replay-indexed" &&
          liveDependencySource === "live"
        ? "raw_replay_with_live_dependency"
        : null;

  return {
    routeLabRowId: row?.id ?? null,
    requestedRouteId: row?.requestedRouteId ?? null,
    routeArtifactId: row?.routeArtifactId ?? null,
    selectedCandidateId: row?.selectedCandidateId ?? null,
    materializedRouteHash: row?.materializedRouteHash ?? null,
    routeLabMode: row?.mode ?? null,
    routeLabStatus: row?.status ?? null,
    routeSimulationStatus: row?.simulation?.status ?? null,
    selectedPools: row?.selectedPools ?? [],
    selectedPoolSource,
    liveDependencySource,
    selectedPoolQuote:
      selectedSource?.tokenIn &&
      selectedSource.tokenOut &&
      selectedSource.amountIn
        ? {
            tokenIn: selectedSource.tokenIn,
            tokenOut: selectedSource.tokenOut,
            amountIn: selectedSource.amountIn,
          }
        : null,
    outcome: row?.selectedActivation?.outcome ?? inferredOutcome,
    selectedRoutePresent:
      row?.status === "ready" &&
      row.selectedPools.includes(selectedPoolId) &&
      row.selectedPools.includes(liveDependencyPoolId),
    evidenceSourceRegistryId:
      row?.indexedPoolState?.sourceRegistryId ??
      row?.quoteApi?.sourceRegistryId ??
      null,
    indexedSourceRegistryId: row?.indexedPoolState?.sourceRegistryId ?? null,
    quoteApiSourceRegistryId: row?.quoteApi?.sourceRegistryId ?? null,
    indexedCurrentBlock: row?.indexedPoolState?.currentBlock ?? null,
  };
}

function activationPool(
  report: FamePoolActivationReportEvidenceInput | undefined,
  poolId: string,
): FameActivationReportPoolEvidence | undefined {
  return report?.upstreamPools.find((entry) => entry.poolId === poolId);
}

function activationPoolIdsByStatus(
  report: FamePoolActivationReportEvidenceInput | undefined,
  status: FamePoolActivationStatus,
): string[] {
  return (
    report?.upstreamPools
      .filter((entry) => entry.activationStatus === status)
      .map((entry) => entry.poolId)
      .sort() ?? []
  );
}

function isReviewedV4QuoteLanePoolId(poolId: string): boolean {
  return fameV4ZoraQuoteLaneManifestForPool(poolId) !== null;
}

function activationBaseline(
  report: FamePoolActivationReportEvidenceInput | undefined,
  selectedPoolId = SELECTED_CL_ACTIVATION_CANDIDATE,
): FameActivationBaselineEvidence {
  const compactClPoolIds = activationPoolIdsByStatus(
    report,
    "cl-compact-quote-active",
  ).filter((poolId) => !isReviewedV4QuoteLanePoolId(poolId));
  const baselineCompactClPoolIds = compactClPoolIds
    .filter((poolId) => poolId !== selectedPoolId)
    .sort();
  const compactClPoolIdsWithSelected = [...compactClPoolIds].sort();
  const additionalCompactClPoolIds = compactClPoolIds
    .filter((poolId) => !baselineCompactClPoolIds.includes(poolId))
    .sort();

  return {
    baselineCompactClPoolIds,
    compactClPoolIdsWithSelected,
    additionalCompactClPoolIds,
    exactlyOneAdditionalPoolClaim:
      baselineCompactClPoolIds.length === 1 &&
      baselineCompactClPoolIds[0] === BASELINE_CL_COMPACT_POOL_ID &&
      compactClPoolIdsWithSelected.length === 2 &&
      additionalCompactClPoolIds.length === 1 &&
      additionalCompactClPoolIds[0] === selectedPoolId,
  };
}

function nonPromotionEvidence(
  report: FamePoolActivationReportEvidenceInput | undefined,
): FameActivationNonPromotionEvidence {
  return {
    clHeadOnlyPoolIds: activationPoolIdsByStatus(report, "cl-head-only"),
    trackedOnlyPoolIds: activationPoolIdsByStatus(report, "tracked-only"),
    unsupportedPoolIds: activationPoolIdsByStatus(report, "unsupported"),
    producerUnrepresentedPoolIds: activationPoolIdsByStatus(
      report,
      "producer-unrepresented",
    ),
    blockedPoolIds: activationPoolIdsByStatus(report, "blocked"),
  };
}

function selectedCompactClQuoteUsedCount(
  response: FamePoolQuoteBatchResponse | undefined,
  routeDependency: FameRouteDependencyEvidence,
  selectedPoolId = SELECTED_CL_ACTIVATION_CANDIDATE,
): number {
  const selectedQuote = routeDependency.selectedPoolQuote;
  if (!selectedQuote) return 0;
  return (
    response?.quotes.filter(
      (quote) =>
        quote.status === "quoted" &&
        quote.quoteKind === "cl-quote-v1" &&
        quote.poolId === selectedPoolId &&
        quote.tokenIn.toLowerCase() === selectedQuote.tokenIn.toLowerCase() &&
        quote.tokenOut.toLowerCase() === selectedQuote.tokenOut.toLowerCase() &&
        quote.amountIn === selectedQuote.amountIn,
    ).length ?? 0
  );
}

function expectedV4ReviewedPoolEvidenceKind(
  poolId: string,
): FameV4ReviewedPoolEvidenceKind | null {
  const manifest = fameV4ZoraQuoteLaneManifestForPool(poolId);
  if (!manifest) return null;
  return manifest.provenanceRequired
    ? "zora-protocol-pool"
    : "zero-hook-static-fee";
}

function defaultV4ZoraActivationInput(
  poolId = FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
): FameV4ZoraActivationEvidenceInput {
  const expectedKind = expectedV4ReviewedPoolEvidenceKind(poolId);
  return {
    poolId,
    status: "pending",
    reviewedPoolEvidenceKind: expectedKind ?? undefined,
    provenanceStatus:
      expectedKind === "zero-hook-static-fee" ? "not-applicable" : "missing",
    shapeStatus: "unknown",
    stateStatus: "missing",
    quoteStatus: "missing",
    parityStatus: "missing",
    routeSimulationStatus: "missing",
    directionCoverage: [],
  };
}

function v4StatusFromGates(
  requested: FameV4ZoraActivationEvidenceInput["status"],
  gates: readonly FameEvidenceGate[],
): FameV4ZoraActivationEvidence["poolQuoteStatus"] {
  if (requested === "pending") return "pending";
  return gates.every((gate) => gate.passed) ? "active" : "blocked";
}

function v4ZoraActivationEvidence(
  input: FameV4ZoraActivationEvidenceInput | undefined,
  expectedSourceRegistryId: string,
  providerReadThreshold: number,
  defaultPoolId = FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
  routeEvidence?: FameRouteDependencyEvidence,
): FameV4ZoraActivationEvidence {
  const source = input ?? defaultV4ZoraActivationInput(defaultPoolId);
  const manifest = fameV4ZoraQuoteLaneManifestForPool(source.poolId);
  const expectedKind = expectedV4ReviewedPoolEvidenceKind(source.poolId);
  const reviewedPoolEvidenceKind =
    source.reviewedPoolEvidenceKind ?? expectedKind;
  const base = {
    poolId: source.poolId,
    status: source.status,
    reviewedPoolEvidenceKind,
    expectedReviewedPoolEvidenceKind: expectedKind,
    provenanceStatus: source.provenanceStatus,
    shapeStatus: source.shapeStatus,
    stateStatus: source.stateStatus,
    quoteStatus: source.quoteStatus,
    parityStatus: source.parityStatus,
    routeSimulationStatus: source.routeSimulationStatus,
    directionCoverage: sortedStrings(source.directionCoverage),
    sourceRegistryId: source.sourceRegistryId ?? null,
    evidenceId: source.evidenceId ?? null,
    providerReadCount: source.providerReadCount ?? null,
    fallbackCount: source.fallbackCount ?? null,
    unavailableReasons: source.unavailableReasons ?? {},
    deferredHardening: sortedStrings(source.deferredHardening ?? []),
  };
  const providerReadsWithinThreshold =
    base.providerReadCount !== null &&
    base.providerReadCount <= providerReadThreshold;
  const requiredDirectionCoverage =
    V4_REVIEWED_LANE_DIRECTION_COVERAGE[base.poolId] ?? [];
  const missingDirections = requiredDirectionCoverage.filter(
    (direction) => !base.directionCoverage.includes(direction),
  );
  const unexpectedDirections = base.directionCoverage.filter(
    (direction) =>
      !requiredDirectionCoverage.some((expected) => expected === direction),
  );
  const directionCoveragePassed =
    requiredDirectionCoverage.length > 0 &&
    missingDirections.length === 0 &&
    unexpectedDirections.length === 0;
  const provenancePassed =
    manifest !== null &&
    (manifest.provenanceRequired
      ? base.provenanceStatus === "verified"
      : base.provenanceStatus === "not-applicable");
  const poolQuoteGates: FameEvidenceGate[] = [
    {
      name: "v4_zora_reviewed_pool",
      passed: manifest !== null && manifest.poolId === base.poolId,
      detail: base.poolId,
    },
    {
      name: "v4_zora_reviewed_evidence_kind",
      passed:
        expectedKind !== null && base.reviewedPoolEvidenceKind === expectedKind,
      detail: base.reviewedPoolEvidenceKind ?? "missing",
    },
    {
      name: manifest?.provenanceRequired
        ? "v4_zora_provenance_verified"
        : "v4_zora_provenance_not_required",
      passed: provenancePassed,
      detail:
        manifest?.provenanceRequired === false
          ? base.provenanceStatus
          : base.provenanceStatus,
    },
    {
      name: "v4_zora_shape_matched",
      passed: base.shapeStatus === "matched",
      detail: base.shapeStatus,
    },
    {
      name: "v4_zora_state_fresh",
      passed: base.stateStatus === "fresh",
      detail: base.stateStatus,
    },
    {
      name: "v4_zora_quote_available",
      passed: base.quoteStatus === "quoted",
      detail: base.quoteStatus,
    },
    {
      name: "v4_zora_parity_passed",
      passed: base.parityStatus === "passed",
      detail: base.parityStatus,
    },
    {
      name: "v4_zora_source_registry_matches",
      passed: base.sourceRegistryId === expectedSourceRegistryId,
      detail: base.sourceRegistryId ?? "missing",
    },
    {
      name: "v4_zora_provider_reads_within_threshold",
      passed: providerReadsWithinThreshold,
      detail:
        base.providerReadCount === null
          ? "missing"
          : `${base.providerReadCount.toString()} <= ${providerReadThreshold.toString()}`,
    },
    {
      name: "v4_zora_direction_coverage",
      passed: directionCoveragePassed,
      detail: directionCoveragePassed
        ? base.directionCoverage.join(", ")
        : [
            missingDirections.length > 0
              ? `missing ${missingDirections.join(", ")}`
              : null,
            unexpectedDirections.length > 0
              ? `unexpected ${unexpectedDirections.join(", ")}`
              : null,
          ]
            .filter((part): part is string => part !== null)
            .join("; ") || "missing",
    },
    {
      name: "v4_zora_evidence_id_present",
      passed: base.evidenceId !== null && base.evidenceId.length > 0,
      detail: base.evidenceId ?? "missing",
    },
  ];
  const routeEligibilityGates: FameEvidenceGate[] = [
    {
      name: "v4_zora_route_simulation_passed",
      passed: base.routeSimulationStatus === "passed",
      detail: base.routeSimulationStatus,
    },
    ...(routeEvidence
      ? [
          {
            name: "v4_zora_route_evidence_bound",
            passed:
              routeEvidence.selectedPools.includes(base.poolId) &&
              routeEvidence.selectedCandidateId !== null &&
              routeEvidence.materializedRouteHash !== null,
            detail:
              routeEvidence.routeLabRowId ??
              routeEvidence.routeArtifactId ??
              "missing route-lab row",
          },
        ]
      : []),
  ];
  const poolQuoteStatus = v4StatusFromGates(base.status, poolQuoteGates);
  const routeEligibilityStatus =
    base.routeSimulationStatus === "missing"
      ? "pending"
      : routeEligibilityGates.every((gate) => gate.passed)
        ? "active"
        : "blocked";
  return {
    ...base,
    status:
      base.status === "active" && poolQuoteStatus === "active"
        ? "active"
        : base.status,
    poolQuoteStatus,
    routeEligibilityStatus,
    reviewedPoolEvidenceKind: base.reviewedPoolEvidenceKind,
    expectedReviewedPoolEvidenceKind: expectedKind,
    poolQuoteGates,
    routeEligibilityGates,
    gates: [...poolQuoteGates, ...routeEligibilityGates],
  };
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function computedActivationStatusCounts(
  report: FamePoolActivationReportEvidenceInput,
): Record<FamePoolActivationStatus, number> {
  const counts = Object.fromEntries(
    FAME_POOL_ACTIVATION_STATUS_VALUES.map((status) => [status, 0]),
  ) as Record<FamePoolActivationStatus, number>;
  for (const pool of report.upstreamPools) counts[pool.activationStatus] += 1;
  return counts;
}

function activationReportValidationErrors(
  report: FamePoolActivationReportEvidenceInput | undefined,
): string[] {
  if (!report) return ["Missing activation report baseline validation."];

  const errors: string[] = [];
  if (report.upstreamPoolCount !== FAME_UPSTREAM_POOL_UNIVERSE_COUNT) {
    errors.push(
      `Activation report upstream pool count must be ${FAME_UPSTREAM_POOL_UNIVERSE_COUNT.toString()}; saw ${report.upstreamPoolCount.toString()}.`,
    );
  }
  if (report.upstreamPools.length !== report.upstreamPoolCount) {
    errors.push(
      `Activation report row count ${report.upstreamPools.length.toString()} does not match upstreamPoolCount ${report.upstreamPoolCount.toString()}.`,
    );
  }

  const seen = new Set<string>();
  for (const pool of report.upstreamPools) {
    if (seen.has(pool.poolId)) {
      errors.push(`Duplicate activation report row for ${pool.poolId}.`);
    }
    if (
      !FAME_POOL_ACTIVATION_STATUS_VALUES.some(
        (status) => status === pool.activationStatus,
      )
    ) {
      errors.push(
        `Activation report row for ${pool.poolId} has unknown activation status ${String(pool.activationStatus)}.`,
      );
    }
    seen.add(pool.poolId);
  }
  const actualPoolIds = sortedStrings([...seen]);
  const expectedPoolIds = sortedStrings(FAME_UPSTREAM_POOL_UNIVERSE_POOL_IDS);
  if (
    actualPoolIds.length !== expectedPoolIds.length ||
    actualPoolIds.some((poolId, index) => poolId !== expectedPoolIds[index])
  ) {
    const missing = expectedPoolIds.filter((poolId) => !seen.has(poolId));
    const extra = actualPoolIds.filter(
      (poolId) =>
        !FAME_UPSTREAM_POOL_UNIVERSE_POOL_IDS.some(
          (expected) => expected === poolId,
        ),
    );
    errors.push(
      `Activation report pool universe mismatch: missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}.`,
    );
  }

  if (report.statusCounts === undefined) {
    errors.push("Activation report must include statusCounts.");
  } else {
    const computed = computedActivationStatusCounts(report);
    for (const status of FAME_POOL_ACTIVATION_STATUS_VALUES) {
      const expected = computed[status];
      const actual = report.statusCounts[status] ?? 0;
      if (actual !== expected) {
        errors.push(
          `Activation report statusCounts.${status} is ${actual.toString()}, expected ${expected.toString()}.`,
        );
      }
    }
  }

  return errors;
}

function buildActivationEvidence({
  input,
  quote,
}: {
  input: FameDeltaReplaySmokeInput;
  quote: NonNullable<FameDeltaReplaySmokeReport["quote"]> | null;
}): FameDeltaReplayActivationEvidence {
  const providerReadThreshold =
    input.providerReadThreshold ?? DEFAULT_PROVIDER_READ_THRESHOLD;
  const activationReport = input.activationReport;
  const selectedPoolId =
    activationReport?.selectedCandidatePoolId ??
    SELECTED_CL_ACTIVATION_CANDIDATE;
  const liveDependencyPoolId =
    activationReport?.liveRouteDependencyPoolId ?? LIVE_ROUTE_DEPENDENCY;
  const activationReportErrors =
    activationReportValidationErrors(activationReport);
  const selectedActivation = activationPool(activationReport, selectedPoolId);
  const routeDependency = selectedRouteDependency(
    routeLabRows(input.routeLab),
    selectedPoolId,
    liveDependencyPoolId,
  );
  const baseline = activationBaseline(activationReport, selectedPoolId);
  const nonPromotion = nonPromotionEvidence(activationReport);
  const selectedMaintenance =
    input.indexer.clReplayMaintenanceMetrics.find(
      (metric) => metric.poolId === selectedPoolId,
    ) ?? null;
  const selectedProviderReadMetrics = input.indexer.clReplayMetrics.filter(
    (metric) => metric.poolId === selectedPoolId,
  );
  const selectedProviderReadCount =
    selectedProviderReadMetrics.length === 0
      ? null
      : selectedProviderReadMetrics.reduce(
          (total, metric) => total + metric.providerReadCount,
          0,
        );
  const selectedCompactQuoteCount = selectedCompactClQuoteUsedCount(
    input.quoteResponse,
    routeDependency,
    selectedPoolId,
  );
  const reviewedActivationInputs = input.v4ReviewedActivations ?? [];
  const legacyV4ZoraInput =
    input.v4ZoraActivation ??
    reviewedActivationInputs.find(
      (activation) => activation.poolId === FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
    );
  const v4ZoraActivation = v4ZoraActivationEvidence(
    legacyV4ZoraInput,
    input.indexer.sourceRegistryId,
    providerReadThreshold,
    FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
    routeDependency,
  );
  const v4ReviewedActivations = [
    v4ZoraActivation,
    ...reviewedActivationInputs
      .filter(
        (activation) => activation.poolId !== FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
      )
      .map((activation) =>
        v4ZoraActivationEvidence(
          activation,
          input.indexer.sourceRegistryId,
          providerReadThreshold,
          activation.poolId,
        ),
      ),
  ];
  const sourceRegistryCompatible =
    input.quoteResponse?.sourceRegistryId === input.indexer.sourceRegistryId &&
    routeDependency.evidenceSourceRegistryId === input.indexer.sourceRegistryId;

  const selectedCandidate: FameSelectedCandidateEvidence = {
    poolId: selectedPoolId,
    reviewedActivationStatus: selectedActivation?.activationStatus ?? null,
    producerRegistryActivationStatus:
      selectedActivation?.producerRegistryEntry?.activationStatus ?? null,
    consumerQuoteCapability:
      selectedActivation?.consumerQuoteCapability ?? null,
    maintenanceStatus: selectedMaintenance?.status ?? null,
    maintenanceReason: safeReasonCode(selectedMaintenance?.reason),
    maintenanceRange: selectedMaintenance
      ? {
          fromBlock: selectedMaintenance.fromBlock,
          toBlock: selectedMaintenance.toBlock,
        }
      : null,
    appliedEventCount: selectedMaintenance?.appliedEventCount ?? null,
    scannedLogCount: selectedMaintenance?.scannedLogCount ?? null,
    candidateWritten: selectedMaintenance?.candidateWritten ?? null,
    stateHash: selectedMaintenance?.stateHash ?? null,
    providerReadCount: selectedProviderReadCount,
    compactQuoteUsedCount: selectedCompactQuoteCount,
  };

  const gates: FameEvidenceGate[] = [
    {
      name: "maintenance_trusted",
      passed: selectedMaintenance?.status === "trusted",
      detail: selectedMaintenance
        ? `${selectedMaintenance.poolId} ${selectedMaintenance.status}`
        : "missing selected pool maintenance row",
    },
    {
      name: "no_replay_gap_or_repair_status",
      passed:
        selectedMaintenance !== null &&
        !["event-gap", "repairing", "drift-failed"].includes(
          selectedMaintenance.status,
        ),
      detail:
        safeReasonCode(selectedMaintenance?.reason) ??
        selectedMaintenance?.status ??
        "missing",
    },
    {
      name: "provider_reads_within_threshold",
      passed:
        selectedProviderReadCount !== null &&
        selectedProviderReadCount <= providerReadThreshold,
      detail:
        selectedProviderReadCount === null
          ? "missing selected pool provider-read metric"
          : `${selectedProviderReadCount.toString()} <= ${providerReadThreshold.toString()}`,
    },
    {
      name: "route_lab_selection_present",
      passed: routeDependency.selectedRoutePresent,
      detail: routeDependency.routeLabRowId ?? "missing route-lab row",
    },
    {
      name: "v4_dependency_live",
      passed: routeDependency.liveDependencySource === "live",
      detail: routeDependency.liveDependencySource ?? "missing live dependency",
    },
    {
      name: "quote_api_selected_compact_quote_used",
      passed:
        selectedCompactQuoteCount > 0 &&
        ["compact-indexed", "raw-replay-indexed"].includes(
          routeDependency.selectedPoolSource ?? "",
        ),
      detail: `${selectedCompactQuoteCount.toString()} selected compact quote rows`,
    },
    {
      name: "exactly_one_additional_pool_claim",
      passed: baseline.exactlyOneAdditionalPoolClaim,
      detail: baseline.additionalCompactClPoolIds.join(", ") || "none",
    },
    {
      name: "source_registry_id_matches",
      passed: sourceRegistryCompatible,
      detail: input.indexer.sourceRegistryId,
    },
  ];

  const validationErrors: string[] = [...activationReportErrors];
  const activeV4Inputs = [
    ...(legacyV4ZoraInput?.status === "active" ? [v4ZoraActivation] : []),
    ...v4ReviewedActivations.filter(
      (activation) =>
        activation.poolId !== FAME_V4_ZORA_QUOTE_LANE_POOL_ID &&
        reviewedActivationInputs.some(
          (inputActivation) =>
            inputActivation.poolId === activation.poolId &&
            inputActivation.status === "active",
        ),
    ),
  ];
  for (const activation of activeV4Inputs) {
    if (!activation.poolQuoteGates.every((gate) => gate.passed)) {
      validationErrors.push(
        `${activation.poolId} V4 pool quote activation is active but one or more pool quote gates failed.`,
      );
    }
  }
  if (!selectedActivation?.activationStatus) {
    validationErrors.push(`Missing activation status for ${selectedPoolId}.`);
  } else if (
    selectedActivation.activationStatus !== "cl-compact-quote-active"
  ) {
    validationErrors.push(
      `${selectedPoolId} must be cl-compact-quote-active in the activation report.`,
    );
  }
  if (!baseline.exactlyOneAdditionalPoolClaim) {
    validationErrors.push(
      "Baseline validation must show exactly one additional compact CL pool claim.",
    );
  }
  if (!routeDependency.requestedRouteId || !routeDependency.routeArtifactId) {
    validationErrors.push(
      "Route lab evidence must include a route artifact id.",
    );
  } else if (
    routeDependency.requestedRouteId !== routeDependency.routeArtifactId
  ) {
    validationErrors.push(
      "Route lab requested route must match selected route artifact.",
    );
  }
  if (
    !routeDependency.selectedRoutePresent ||
    !["compact-indexed", "raw-replay-indexed"].includes(
      routeDependency.selectedPoolSource ?? "",
    ) ||
    routeDependency.liveDependencySource !== "live" ||
    ![
      "compact_quote_with_live_dependency",
      "raw_replay_with_live_dependency",
    ].includes(routeDependency.outcome ?? "")
  ) {
    validationErrors.push(
      "Route lab did not prove selected indexed leg with live V4 dependency.",
    );
  }
  if (!quote) {
    validationErrors.push(
      "Missing quote response with unavailable reason counts.",
    );
  }
  if (selectedCompactQuoteCount === 0) {
    validationErrors.push(
      `Quote API did not return a matching compact quote for ${selectedPoolId}.`,
    );
  }
  if (selectedMaintenance?.status !== "trusted") {
    validationErrors.push(
      `Selected pool maintenance must be trusted; saw ${selectedMaintenance?.status ?? "missing"}.`,
    );
  }
  if (selectedProviderReadCount === null) {
    validationErrors.push(
      `Missing provider-read metric for ${selectedPoolId}.`,
    );
  } else if (selectedProviderReadCount > providerReadThreshold) {
    validationErrors.push(
      `Provider reads ${selectedProviderReadCount.toString()} exceed threshold ${providerReadThreshold.toString()}.`,
    );
  }
  if (!sourceRegistryCompatible) {
    validationErrors.push("Evidence source registry ids do not match.");
  }

  return {
    status: validationErrors.length === 0 ? "ready" : "blocked",
    validationErrors,
    providerReadThreshold,
    selectedCandidate,
    v4ZoraActivation,
    v4ReviewedActivations,
    routeDependency,
    baseline,
    nonPromotion,
    operatorGates: gates,
  };
}

export function buildFameDeltaReplaySmokeReport(
  input: FameDeltaReplaySmokeInput,
): FameDeltaReplaySmokeReport {
  const providerReadCount = sumProviderReads(input.indexer.clReplayMetrics);
  const quote = quoteSummary(input.quoteResponse);
  return {
    sourceRegistryId: input.indexer.sourceRegistryId,
    observedThroughBlock: input.indexer.observedThroughBlock,
    replaySnapshotCount: input.indexer.clReplaySnapshots,
    providerReadCount,
    maintenance:
      input.indexer.clReplayMaintenanceMetrics.map(maintenanceReport),
    quote,
    activationEvidence: buildActivationEvidence({
      input,
      quote,
    }),
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
