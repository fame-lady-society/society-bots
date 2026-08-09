import { baseClient } from "@/viem.ts";
import {
  FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE,
  FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS,
  FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION,
  FAME_POOL_STATE_CONFIRMATION_BLOCKS,
  FAME_POOL_STATE_RPC_GET_LOGS_BLOCK_RANGE,
  FAME_POOL_STATE_TABLE_NAME,
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
import {
  logPoolStateIndexerResult,
  writePoolStateLog,
  type PoolStateLogFields,
} from "./logging.ts";

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
}: {
  client?: FamePoolStateIndexerClient;
  tableName: string;
  confirmationBlocks: number;
  clReplayMaintenanceMode?: FameClReplayMaintenanceMode;
  clReplayTrustPromotion?: boolean;
  clReplayMaxRangeBlocks?: number;
  v4ZoraProvenance?: FamePoolStateV4ZoraProvenanceEvidence;
  indexPools?: FamePoolStateIndexRunner;
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
}

export async function handler(): Promise<void> {
  await handleFamePoolStateIndexer({
    tableName: FAME_POOL_STATE_TABLE_NAME,
    confirmationBlocks: FAME_POOL_STATE_CONFIRMATION_BLOCKS,
    clReplayMaintenanceMode: FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE,
    clReplayTrustPromotion: FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION,
    clReplayMaxRangeBlocks: FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS,
  });
}
