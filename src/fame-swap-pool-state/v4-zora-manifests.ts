import type { Address, Hex } from "viem";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateV4ZoraProvenanceEvidence,
  FamePoolStateV4ZoraQuoteLaneStatus,
} from "./types.ts";

export const FAME_V4_ZORA_QUOTE_LANE_MANIFEST_VERSION = 1;
export const FAME_V4_ZORA_QUOTE_LANE_POOL_ID = "uniswap-v4-basedflick-zora";
export const UNISWAP_V4_DYNAMIC_FEE_FLAG = 0x800000;
export const UNISWAP_V4_MAX_LP_FEE = 1_000_000;

export interface FameV4HookPermissions {
  beforeInitialize: boolean;
  afterInitialize: boolean;
  beforeAddLiquidity: boolean;
  afterAddLiquidity: boolean;
  beforeRemoveLiquidity: boolean;
  afterRemoveLiquidity: boolean;
  beforeSwap: boolean;
  afterSwap: boolean;
  beforeDonate: boolean;
  afterDonate: boolean;
  beforeSwapReturnDelta: boolean;
  afterSwapReturnDelta: boolean;
  afterAddLiquidityReturnDelta: boolean;
  afterRemoveLiquidityReturnDelta: boolean;
}

export interface FameV4ZoraReviewedPoolShape {
  poolId: typeof FAME_V4_ZORA_QUOTE_LANE_POOL_ID;
  chainId: 8453;
  venue: "uniswap-v4";
  venueFamily: "UniswapV4";
  router: Address;
  poolManager: Address;
  stateViewAddress: Address;
  poolKey: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: 200;
  hooks: Address;
  hookData: Hex;
}

export interface FameV4ZoraQuoteLaneManifest {
  version: typeof FAME_V4_ZORA_QUOTE_LANE_MANIFEST_VERSION;
  poolId: typeof FAME_V4_ZORA_QUOTE_LANE_POOL_ID;
  provenanceRequired: true;
  reviewedPoolShape: FameV4ZoraReviewedPoolShape;
  allowedHookPermissions: Pick<
    FameV4HookPermissions,
    "afterInitialize" | "afterSwap"
  >;
  forbiddenSwapHookPermissions: readonly (
    | "beforeSwap"
    | "beforeSwapReturnDelta"
    | "afterSwapReturnDelta"
  )[];
  activationStatuses: readonly ["unsupported"];
}

export type FameV4ZoraQuoteLaneBlockReason =
  | "not-uniswap-v4"
  | "non-target-v4-pool"
  | "chain-mismatch"
  | "venue-mismatch"
  | "venue-family-mismatch"
  | "router-mismatch"
  | "pool-address-present"
  | "factory-address-present"
  | "pool-key-mismatch"
  | "token0-mismatch"
  | "token1-mismatch"
  | "state-view-mismatch"
  | "capability-mismatch"
  | "activation-status-mismatch"
  | "state-surface-mismatch"
  | "replay-surface-present"
  | "quote-model-present"
  | "unsupported-reason-present"
  | "missing-fee-metadata"
  | "invalid-fee"
  | "dynamic-fee"
  | "fee-mismatch"
  | "tick-spacing-mismatch"
  | "pool-manager-mismatch"
  | "currency0-mismatch"
  | "currency1-mismatch"
  | "hook-data-mismatch"
  | "unsafe-hook-permissions"
  | "hook-address-mismatch"
  | "missing-provenance"
  | "provenance-chain-mismatch"
  | "provenance-coin-mismatch"
  | "provenance-pool-key-mismatch"
  | "provenance-pool-id-mismatch";

export type FameV4ZoraQuoteLaneClassification =
  | {
      status: "target-eligible";
      poolId: typeof FAME_V4_ZORA_QUOTE_LANE_POOL_ID;
      manifest: FameV4ZoraQuoteLaneManifest;
      hookPermissions: FameV4HookPermissions;
      provenance: Extract<
        FamePoolStateV4ZoraProvenanceEvidence,
        { status: "verified" }
      >;
    }
  | {
      status: "target-blocked";
      poolId: string;
      reason: FameV4ZoraQuoteLaneBlockReason;
      hookPermissions?: FameV4HookPermissions;
      unsafeHookPermissions?: readonly string[];
    }
  | {
      status: "non-target-v4-unsupported";
      poolId: string;
      reason: "non-target-v4-pool";
    }
  | {
      status: "not-uniswap-v4";
      poolId: string;
      reason: "not-uniswap-v4";
    };

const HOOK_FLAGS = {
  beforeInitialize: 1n << 13n,
  afterInitialize: 1n << 12n,
  beforeAddLiquidity: 1n << 11n,
  afterAddLiquidity: 1n << 10n,
  beforeRemoveLiquidity: 1n << 9n,
  afterRemoveLiquidity: 1n << 8n,
  beforeSwap: 1n << 7n,
  afterSwap: 1n << 6n,
  beforeDonate: 1n << 5n,
  afterDonate: 1n << 4n,
  beforeSwapReturnDelta: 1n << 3n,
  afterSwapReturnDelta: 1n << 2n,
  afterAddLiquidityReturnDelta: 1n << 1n,
  afterRemoveLiquidityReturnDelta: 1n << 0n,
} as const satisfies Record<keyof FameV4HookPermissions, bigint>;

export const FAME_V4_ZORA_REVIEWED_POOL_SHAPE = {
  poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
  chainId: 8453,
  venue: "uniswap-v4",
  venueFamily: "UniswapV4",
  router: "0x6ff5693b99212da76ad316178a184ab56d299b43",
  poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
  stateViewAddress: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  poolKey: "0x0fe6333346fcd0ffa4be3fda91f271bda52c6755f604b06483b709666d363628",
  currency0: "0x1111111111166b7fe7bd91427724b487980afc69",
  currency1: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
  fee: 30_000,
  tickSpacing: 200,
  hooks: "0xd61a675f8a0c67a73dc3b54fb7318b4d91409040",
  hookData: "0x",
} as const satisfies FameV4ZoraReviewedPoolShape;

export const FAME_V4_ZORA_QUOTE_LANE_MANIFEST = {
  version: FAME_V4_ZORA_QUOTE_LANE_MANIFEST_VERSION,
  poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
  provenanceRequired: true,
  reviewedPoolShape: FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
  allowedHookPermissions: {
    afterInitialize: true,
    afterSwap: true,
  },
  forbiddenSwapHookPermissions: [
    "beforeSwap",
    "beforeSwapReturnDelta",
    "afterSwapReturnDelta",
  ],
  activationStatuses: ["unsupported"],
} as const satisfies FameV4ZoraQuoteLaneManifest;

export const FAME_V4_ZORA_APPROVED_PROVENANCE = {
  status: "verified",
  source: "zora-factory-event",
  chainId: 8453,
  factoryAddress: "0x777777751622c0d3258f214f9df38e35bf45baf3",
  coinAddress: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.currency1,
  poolKey: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolKey,
  poolId: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolKey,
  transactionHash:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  eventName: "OperatorApprovedZoraProtocolPool",
} as const satisfies FamePoolStateV4ZoraProvenanceEvidence;

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function block(
  poolId: string,
  reason: FameV4ZoraQuoteLaneBlockReason,
  extra: Omit<
    Extract<FameV4ZoraQuoteLaneClassification, { status: "target-blocked" }>,
    "status" | "poolId" | "reason"
  > = {},
): FameV4ZoraQuoteLaneClassification {
  return {
    status: "target-blocked",
    poolId,
    reason,
    ...extra,
  };
}

function feeBpsToV4LpFee(feeBps: number): number | null {
  const scaled = feeBps * 100;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(scaled) || Math.abs(scaled - rounded) > 1e-9) {
    return null;
  }
  return rounded;
}

export function isUniswapV4DynamicFee(fee: number): boolean {
  return fee === UNISWAP_V4_DYNAMIC_FEE_FLAG;
}

export function decodeUniswapV4HookPermissions(
  hooks: Address,
): FameV4HookPermissions {
  const hookBits = BigInt(hooks);
  return {
    beforeInitialize: (hookBits & HOOK_FLAGS.beforeInitialize) !== 0n,
    afterInitialize: (hookBits & HOOK_FLAGS.afterInitialize) !== 0n,
    beforeAddLiquidity: (hookBits & HOOK_FLAGS.beforeAddLiquidity) !== 0n,
    afterAddLiquidity: (hookBits & HOOK_FLAGS.afterAddLiquidity) !== 0n,
    beforeRemoveLiquidity: (hookBits & HOOK_FLAGS.beforeRemoveLiquidity) !== 0n,
    afterRemoveLiquidity: (hookBits & HOOK_FLAGS.afterRemoveLiquidity) !== 0n,
    beforeSwap: (hookBits & HOOK_FLAGS.beforeSwap) !== 0n,
    afterSwap: (hookBits & HOOK_FLAGS.afterSwap) !== 0n,
    beforeDonate: (hookBits & HOOK_FLAGS.beforeDonate) !== 0n,
    afterDonate: (hookBits & HOOK_FLAGS.afterDonate) !== 0n,
    beforeSwapReturnDelta: (hookBits & HOOK_FLAGS.beforeSwapReturnDelta) !== 0n,
    afterSwapReturnDelta: (hookBits & HOOK_FLAGS.afterSwapReturnDelta) !== 0n,
    afterAddLiquidityReturnDelta:
      (hookBits & HOOK_FLAGS.afterAddLiquidityReturnDelta) !== 0n,
    afterRemoveLiquidityReturnDelta:
      (hookBits & HOOK_FLAGS.afterRemoveLiquidityReturnDelta) !== 0n,
  };
}

function unsafeSwapHookPermissions(
  permissions: FameV4HookPermissions,
): string[] {
  return FAME_V4_ZORA_QUOTE_LANE_MANIFEST.forbiddenSwapHookPermissions.filter(
    (name) => permissions[name],
  );
}

function registryShapeBlockReason(
  pool: FamePoolStateRegistryEntry,
  manifest: FameV4ZoraQuoteLaneManifest,
): FameV4ZoraQuoteLaneBlockReason | null {
  const shape = manifest.reviewedPoolShape;
  if (pool.chainId !== shape.chainId) return "chain-mismatch";
  if (pool.venue !== shape.venue) return "venue-mismatch";
  if (pool.venueFamily !== shape.venueFamily) {
    return "venue-family-mismatch";
  }
  if (!sameAddress(pool.router, shape.router)) return "router-mismatch";
  if (pool.factoryAddress !== null) return "factory-address-present";
  if (pool.poolAddress !== null) return "pool-address-present";
  if (pool.poolKey === null || !sameHex(pool.poolKey, shape.poolKey)) {
    return "pool-key-mismatch";
  }
  if (!sameAddress(pool.token0, shape.currency0)) return "token0-mismatch";
  if (!sameAddress(pool.token1, shape.currency1)) return "token1-mismatch";
  if (
    pool.stateViewAddress === null ||
    !sameAddress(pool.stateViewAddress, shape.stateViewAddress)
  ) {
    return "state-view-mismatch";
  }
  if (pool.capability !== "market-state") return "capability-mismatch";
  if (
    !manifest.activationStatuses.some(
      (status) => status === pool.activationStatus,
    )
  ) {
    return "activation-status-mismatch";
  }
  if (pool.stateSurface !== "cl-head-snapshot") {
    return "state-surface-mismatch";
  }
  if (pool.replaySurface !== null) return "replay-surface-present";
  if (pool.quoteModel !== null) return "quote-model-present";
  if (pool.unsupportedReason !== null) return "unsupported-reason-present";
  if (pool.fee.status !== "available") return "missing-fee-metadata";
  const v4Fee = feeBpsToV4LpFee(pool.fee.feeBps);
  if (v4Fee === null) return "invalid-fee";
  if (isUniswapV4DynamicFee(v4Fee)) return "dynamic-fee";
  if (v4Fee > UNISWAP_V4_MAX_LP_FEE) return "invalid-fee";
  if (v4Fee !== shape.fee) return "fee-mismatch";
  if (pool.tickSpacing !== shape.tickSpacing) return "tick-spacing-mismatch";
  return null;
}

export function classifyV4ZoraReviewedPoolShape(
  shape: FameV4ZoraReviewedPoolShape,
  provenance?: FamePoolStateV4ZoraProvenanceEvidence,
): FameV4ZoraQuoteLaneClassification {
  const manifest = FAME_V4_ZORA_QUOTE_LANE_MANIFEST;
  const expected = manifest.reviewedPoolShape;
  if (shape.poolId !== expected.poolId) {
    return {
      status: "non-target-v4-unsupported",
      poolId: shape.poolId,
      reason: "non-target-v4-pool",
    };
  }
  if (shape.chainId !== expected.chainId) {
    return block(shape.poolId, "chain-mismatch");
  }
  if (shape.venue !== expected.venue)
    return block(shape.poolId, "venue-mismatch");
  if (shape.venueFamily !== expected.venueFamily) {
    return block(shape.poolId, "venue-family-mismatch");
  }
  if (!sameAddress(shape.router, expected.router)) {
    return block(shape.poolId, "router-mismatch");
  }
  if (!sameAddress(shape.poolManager, expected.poolManager)) {
    return block(shape.poolId, "pool-manager-mismatch");
  }
  if (!sameAddress(shape.stateViewAddress, expected.stateViewAddress)) {
    return block(shape.poolId, "state-view-mismatch");
  }
  if (!sameHex(shape.poolKey, expected.poolKey)) {
    return block(shape.poolId, "pool-key-mismatch");
  }
  if (!sameAddress(shape.currency0, expected.currency0)) {
    return block(shape.poolId, "currency0-mismatch");
  }
  if (!sameAddress(shape.currency1, expected.currency1)) {
    return block(shape.poolId, "currency1-mismatch");
  }
  if (isUniswapV4DynamicFee(shape.fee)) {
    return block(shape.poolId, "dynamic-fee");
  }
  if (shape.fee > UNISWAP_V4_MAX_LP_FEE) {
    return block(shape.poolId, "invalid-fee");
  }
  if (shape.fee !== expected.fee) return block(shape.poolId, "fee-mismatch");
  if (shape.tickSpacing !== expected.tickSpacing) {
    return block(shape.poolId, "tick-spacing-mismatch");
  }
  if (shape.hookData.toLowerCase() !== "0x") {
    return block(shape.poolId, "hook-data-mismatch");
  }

  const hookPermissions = decodeUniswapV4HookPermissions(shape.hooks);
  const unsafePermissions = unsafeSwapHookPermissions(hookPermissions);
  if (
    !hookPermissions.afterInitialize ||
    !hookPermissions.afterSwap ||
    unsafePermissions.length > 0
  ) {
    return block(shape.poolId, "unsafe-hook-permissions", {
      hookPermissions,
      unsafeHookPermissions: unsafePermissions,
    });
  }
  if (!sameAddress(shape.hooks, expected.hooks)) {
    return block(shape.poolId, "hook-address-mismatch", { hookPermissions });
  }

  if (!provenance || provenance.status === "missing") {
    return block(shape.poolId, "missing-provenance", { hookPermissions });
  }
  if (provenance.chainId !== shape.chainId) {
    return block(shape.poolId, "provenance-chain-mismatch", {
      hookPermissions,
    });
  }
  if (!sameAddress(provenance.coinAddress, shape.currency1)) {
    return block(shape.poolId, "provenance-coin-mismatch", {
      hookPermissions,
    });
  }
  if (!sameHex(provenance.poolKey, shape.poolKey)) {
    return block(shape.poolId, "provenance-pool-key-mismatch", {
      hookPermissions,
    });
  }
  if (!sameHex(provenance.poolId, shape.poolKey)) {
    return block(shape.poolId, "provenance-pool-id-mismatch", {
      hookPermissions,
    });
  }

  return {
    status: "target-eligible",
    poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
    manifest,
    hookPermissions,
    provenance,
  };
}

export function classifyV4ZoraQuoteLane(
  pool: FamePoolStateRegistryEntry,
  provenance?: FamePoolStateV4ZoraProvenanceEvidence,
): FameV4ZoraQuoteLaneClassification {
  if (pool.venue !== "uniswap-v4") {
    return {
      status: "not-uniswap-v4",
      poolId: pool.id,
      reason: "not-uniswap-v4",
    };
  }
  if (pool.id !== FAME_V4_ZORA_QUOTE_LANE_POOL_ID) {
    return {
      status: "non-target-v4-unsupported",
      poolId: pool.id,
      reason: "non-target-v4-pool",
    };
  }

  const manifest = FAME_V4_ZORA_QUOTE_LANE_MANIFEST;
  const blockedReason = registryShapeBlockReason(pool, manifest);
  if (blockedReason !== null) return block(pool.id, blockedReason);
  return classifyV4ZoraReviewedPoolShape(
    manifest.reviewedPoolShape,
    provenance,
  );
}

export function fameV4ZoraQuoteLaneStatus(
  pool: FamePoolStateRegistryEntry,
  provenance?: FamePoolStateV4ZoraProvenanceEvidence,
): FamePoolStateV4ZoraQuoteLaneStatus {
  return classifyV4ZoraQuoteLane(pool, provenance).status;
}
