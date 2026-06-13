import type { Address } from "viem";
import type {
  FameClReplayRegistryEntry,
  FameClReplaySource,
} from "./dynamodb/pool-state.ts";
import type { FamePoolStateRegistryEntry } from "./types.ts";

export const FAME_CL_REPLAY_REDUCER_MANIFEST_VERSION = 1;
export const FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID =
  "slipstream-basedflick-fame";

export type FameClReplayReducerEvent = "Swap" | "Mint" | "Burn" | "Collect";

export interface FameClReplayReducerManifest {
  version: typeof FAME_CL_REPLAY_REDUCER_MANIFEST_VERSION;
  poolId: typeof FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID;
  chainId: 8453;
  venue: "aerodrome-slipstream";
  venueFamily: "Slipstream";
  router: Address;
  factoryAddress: Address;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  feeSource: "pool-fee";
  tickSpacing: 2000;
  source: FameClReplaySource;
  activationStatuses: readonly [
    "cl-replay-candidate",
    "cl-compact-quote-active",
  ];
  supportedEvents: readonly FameClReplayReducerEvent[];
  requiresCompleteSnapshotSeed: true;
  requiresBitmapCompleteness: true;
  requiresInitializedTickCompleteness: true;
  maxMaintenanceRangeBlocks: 1_000;
  quoteRange: {
    minTick: -887_272;
    maxTick: 887_272;
  };
}

export type FameClReplayReducerRegistryEntry = FameClReplayRegistryEntry & {
  activationStatus: "cl-replay-candidate" | "cl-compact-quote-active";
  stateSurface: "cl-head-snapshot";
  venue: "aerodrome-slipstream";
  factoryAddress: Address;
  poolAddress: Address;
  tickSpacing: number;
};

const SELECTED_CL_REPLAY_CANDIDATE_MANIFEST = {
  version: FAME_CL_REPLAY_REDUCER_MANIFEST_VERSION,
  poolId: FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
  chainId: 8453,
  venue: "aerodrome-slipstream",
  venueFamily: "Slipstream",
  router: "0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5",
  factoryAddress: "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a",
  poolAddress: "0xbd7e5bb5a6251f6dde2cf56afa50ed0c8b4c2cdb",
  token0: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
  token1: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
  feeSource: "pool-fee",
  tickSpacing: 2000,
  source: "slipstream-pool-state",
  activationStatuses: ["cl-replay-candidate", "cl-compact-quote-active"],
  supportedEvents: ["Swap", "Mint", "Burn", "Collect"],
  requiresCompleteSnapshotSeed: true,
  requiresBitmapCompleteness: true,
  requiresInitializedTickCompleteness: true,
  maxMaintenanceRangeBlocks: 1_000,
  quoteRange: {
    minTick: -887_272,
    maxTick: 887_272,
  },
} as const satisfies FameClReplayReducerManifest;

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isSelectedManifestActivationStatus(
  status: FamePoolStateRegistryEntry["activationStatus"],
): status is FameClReplayReducerRegistryEntry["activationStatus"] {
  return (
    status === "cl-replay-candidate" || status === "cl-compact-quote-active"
  );
}

function assertSelectedCandidateManifest(
  pool: FamePoolStateRegistryEntry,
): FameClReplayReducerRegistryEntry {
  const manifest = SELECTED_CL_REPLAY_CANDIDATE_MANIFEST;
  if (pool.chainId !== manifest.chainId) {
    throw new Error(`${pool.id} must be on Base mainnet.`);
  }
  if (pool.venue !== manifest.venue) {
    throw new Error(`${pool.id} must be Aerodrome Slipstream v1.`);
  }
  if (pool.venueFamily !== manifest.venueFamily) {
    throw new Error(`${pool.id} must use Slipstream venue family.`);
  }
  if (!sameAddress(pool.router, manifest.router)) {
    throw new Error(`${pool.id} router does not match manifest.`);
  }
  if (pool.factoryAddress === null) {
    throw new Error(`${pool.id} must have a factory address.`);
  }
  if (!sameAddress(pool.factoryAddress, manifest.factoryAddress)) {
    throw new Error(`${pool.id} factory address does not match manifest.`);
  }
  if (!sameAddress(pool.token0, manifest.token0)) {
    throw new Error(`${pool.id} token0 does not match manifest.`);
  }
  if (!sameAddress(pool.token1, manifest.token1)) {
    throw new Error(`${pool.id} token1 does not match manifest.`);
  }
  if (!isSelectedManifestActivationStatus(pool.activationStatus)) {
    throw new Error(
      `${pool.id} must be a CL replay candidate or compact quote active.`,
    );
  }
  if (pool.poolAddress === null) {
    throw new Error(`${pool.id} must have a pool address.`);
  }
  if (!sameAddress(pool.poolAddress, manifest.poolAddress)) {
    throw new Error(`${pool.id} pool address does not match manifest.`);
  }
  if (pool.tickSpacing !== manifest.tickSpacing) {
    throw new Error(`${pool.id} tick spacing does not match manifest.`);
  }
  if (pool.fee.status !== "available") {
    throw new Error(`${pool.id} must have reviewed fee metadata.`);
  }
  if (pool.fee.feeBps !== 100 || pool.fee.source !== "pool-metadata") {
    throw new Error(`${pool.id} fee metadata does not match manifest.`);
  }
  if (pool.stateSurface !== "cl-head-snapshot") {
    throw new Error(`${pool.id} must keep CL head snapshot state.`);
  }
  if (
    pool.activationStatus === "cl-replay-candidate" &&
    pool.replaySurface !== null
  ) {
    throw new Error(`${pool.id} manifest candidate cannot be quote active.`);
  }
  if (
    pool.activationStatus === "cl-compact-quote-active" &&
    pool.replaySurface !== "cl-replay-v1"
  ) {
    throw new Error(
      `${pool.id} compact quote activation requires replaySurface.`,
    );
  }

  return {
    ...pool,
    activationStatus: pool.activationStatus,
    stateSurface: pool.stateSurface,
    venue: pool.venue,
    factoryAddress: pool.factoryAddress,
    poolAddress: pool.poolAddress,
    tickSpacing: pool.tickSpacing,
  };
}

export function clReplayReducerManifestForPool(
  pool: FamePoolStateRegistryEntry,
): FameClReplayReducerManifest | null {
  if (pool.id !== FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID) return null;
  assertSelectedCandidateManifest(pool);
  return SELECTED_CL_REPLAY_CANDIDATE_MANIFEST;
}

export function isClReplayReducerManifestPool(
  pool: FamePoolStateRegistryEntry,
): pool is FameClReplayReducerRegistryEntry {
  return clReplayReducerManifestForPool(pool) !== null;
}
