import { baseClient } from "@/viem.ts";
import type { Context } from "aws-lambda";
import {
  FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE,
  FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS,
  FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION,
  FAME_POOL_STATE_CONFIRMATION_BLOCKS,
  FAME_POOL_STATE_RPC_GET_LOGS_BLOCK_RANGE,
  FAME_POOL_STATE_TABLE_NAME,
  FAME_LANDING_SNAPSHOT_LEAF_TIMEOUT_MS,
  FAME_LANDING_SNAPSHOT_RUN_TIMEOUT_MS,
  FAME_LANDING_SNAPSHOT_TTL_SECONDS,
} from "../config.ts";
import {
  assertNoClReplaySnapshotFailures,
  createViemPoolStateIndexerClient,
  indexFamePoolStates,
  type FamePoolStateIndexerClient,
  type FameClReplayMaintenanceMode,
  type FamePoolStateIndexerResult,
} from "../indexer.ts";
import { FAME_V4_ZORA_APPROVED_PROVENANCE } from "../v4-zora-manifests.ts";
import type { FamePoolStateV4ZoraProvenanceEvidence } from "../types.ts";
import { produceAndPublishFameLandingSnapshot } from "../landing-snapshot-runtime.ts";
import {
  logFameLandingSnapshotProduced,
  logPoolStateIndexerResult,
  writePoolStateLog,
  type PoolStateLogFields,
} from "./logging.ts";

export type FameLandingSnapshotPublishRunner = (options: {
  indexResult: FamePoolStateIndexerResult;
  tableName: string;
  runTimeoutMs: number;
}) => Promise<void>;

async function defaultPublishLandingSnapshot(options: {
  indexResult: FamePoolStateIndexerResult;
  tableName: string;
  runTimeoutMs: number;
}): Promise<void> {
  const published = await produceAndPublishFameLandingSnapshot({
    ...options,
    leafTimeoutMs: FAME_LANDING_SNAPSHOT_LEAF_TIMEOUT_MS,
    ttlSeconds: FAME_LANDING_SNAPSHOT_TTL_SECONDS,
  });
  logFameLandingSnapshotProduced(published.snapshot, published.publication);
}

export type FamePoolStateIndexRunner = (options: {
  client?: FamePoolStateIndexerClient;
  tableName: string;
  confirmationBlocks: number;
  clReplayMaintenanceMode: FameClReplayMaintenanceMode;
  clReplayTrustPromotion: boolean;
  clReplayMaxRangeBlocks: number;
  v4ZoraProvenance?: FamePoolStateV4ZoraProvenanceEvidence;
}) => Promise<FamePoolStateIndexerResult>;

function defaultIndexPools({
  client,
  tableName,
  confirmationBlocks,
  clReplayMaintenanceMode,
  clReplayTrustPromotion,
  clReplayMaxRangeBlocks,
  v4ZoraProvenance,
}: {
  client?: FamePoolStateIndexerClient;
  tableName: string;
  confirmationBlocks: number;
  clReplayMaintenanceMode: FameClReplayMaintenanceMode;
  clReplayTrustPromotion: boolean;
  clReplayMaxRangeBlocks: number;
  v4ZoraProvenance?: FamePoolStateV4ZoraProvenanceEvidence;
}): Promise<FamePoolStateIndexerResult> {
  return indexFamePoolStates({
    client:
      client ??
      createViemPoolStateIndexerClient(baseClient, {
        getLogsBlockRange: FAME_POOL_STATE_RPC_GET_LOGS_BLOCK_RANGE,
      }),
    tableName,
    confirmationBlocks,
    clReplayMaintenanceMode,
    clReplayTrustPromotion,
    clReplayMaxRangeBlocks,
    v4ZoraProvenance,
  });
}

function safeErrorClass(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.name
      : typeof error === "object" && error !== null
        ? Reflect.get(error, "name")
        : undefined;
  if (typeof candidate !== "string") return "UnknownError";
  const trimmed = candidate.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(trimmed)) {
    return "UnknownError";
  }
  return trimmed;
}

function safeErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  for (const key of ["status", "statusCode"]) {
    const value = Reflect.get(error, key);
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 100 &&
      value <= 599
    ) {
      return value;
    }
  }
  return undefined;
}

function indexerCrashLogFields(error: unknown): PoolStateLogFields {
  const fields: PoolStateLogFields = {
    errorType: "indexer-crash",
    errorClass: safeErrorClass(error),
  };
  const statusCode = safeErrorStatusCode(error);
  if (statusCode !== undefined) fields.statusCode = statusCode;
  return fields;
}

export async function handleFamePoolStateIndexer({
  client,
  tableName,
  confirmationBlocks,
  clReplayMaintenanceMode,
  clReplayTrustPromotion,
  clReplayMaxRangeBlocks,
  v4ZoraProvenance = FAME_V4_ZORA_APPROVED_PROVENANCE,
  indexPools = defaultIndexPools,
  publishLandingSnapshot = defaultPublishLandingSnapshot,
  landingSnapshotRunBudget = () => FAME_LANDING_SNAPSHOT_RUN_TIMEOUT_MS,
}: {
  client?: FamePoolStateIndexerClient;
  tableName: string;
  confirmationBlocks: number;
  clReplayMaintenanceMode?: FameClReplayMaintenanceMode;
  clReplayTrustPromotion?: boolean;
  clReplayMaxRangeBlocks?: number;
  v4ZoraProvenance?: FamePoolStateV4ZoraProvenanceEvidence;
  indexPools?: FamePoolStateIndexRunner;
  publishLandingSnapshot?: FameLandingSnapshotPublishRunner;
  landingSnapshotRunBudget?: () => number;
}): Promise<void> {
  let result: FamePoolStateIndexerResult;
  try {
    result = await indexPools({
      client,
      tableName,
      confirmationBlocks,
      clReplayMaintenanceMode:
        clReplayMaintenanceMode ?? FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE,
      clReplayTrustPromotion:
        clReplayTrustPromotion ?? FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION,
      clReplayMaxRangeBlocks:
        clReplayMaxRangeBlocks ?? FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS,
      v4ZoraProvenance,
    });
  } catch (error) {
    writePoolStateLog(
      "error",
      "fame-pool-state-indexed",
      indexerCrashLogFields(error),
    );
    throw new Error("FAME pool-state indexer failed");
  }

  logPoolStateIndexerResult(result);
  assertNoClReplaySnapshotFailures(result);
  try {
    await publishLandingSnapshot({
      indexResult: result,
      tableName,
      runTimeoutMs: landingSnapshotRunBudget(),
    });
  } catch (error) {
    writePoolStateLog("error", "fame-landing-snapshot-produced", {
      errorType: "snapshot-publication-failed",
      errorClass: safeErrorClass(error),
    });
    throw new Error("FAME landing snapshot publication failed");
  }
}

export const FAME_LANDING_SNAPSHOT_SHUTDOWN_MARGIN_MS = 5_000;

export function landingSnapshotRunBudgetMs(
  remainingTimeMs: number,
  configuredTimeoutMs = FAME_LANDING_SNAPSHOT_RUN_TIMEOUT_MS,
): number {
  if (
    !Number.isSafeInteger(remainingTimeMs) ||
    !Number.isSafeInteger(configuredTimeoutMs) ||
    configuredTimeoutMs <= 0
  ) {
    throw new Error("FAME landing snapshot Lambda budget is invalid");
  }
  const availableTimeMs =
    remainingTimeMs - FAME_LANDING_SNAPSHOT_SHUTDOWN_MARGIN_MS;
  if (availableTimeMs <= 0) {
    throw new Error("FAME landing snapshot Lambda budget is exhausted");
  }
  return Math.min(configuredTimeoutMs, availableTimeMs);
}

export async function handler(
  _event: unknown,
  context: Context,
): Promise<void> {
  await handleFamePoolStateIndexer({
    tableName: FAME_POOL_STATE_TABLE_NAME,
    confirmationBlocks: FAME_POOL_STATE_CONFIRMATION_BLOCKS,
    clReplayMaintenanceMode: FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE,
    clReplayTrustPromotion: FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION,
    clReplayMaxRangeBlocks: FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS,
    landingSnapshotRunBudget: () =>
      landingSnapshotRunBudgetMs(context.getRemainingTimeInMillis()),
  });
}
