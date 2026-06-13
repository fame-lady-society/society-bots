import { describe, expect, test } from "@jest/globals";
import {
  FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
  FAME_V4_ZORA_ETH_QUOTE_LANE_POOL_ID,
  classifyV4ZoraQuoteLane,
  famePoolStateRegistry,
  getFamePoolStateRegistryEntry,
  parseFamePoolStateRegistry,
} from "./index.ts";
import type { FamePoolStateV4ZoraProvenanceEvidence } from "../types.ts";

const VERIFIED_V4_ZORA_PROVENANCE = {
  status: "verified",
  source: "zora-factory-event",
  chainId: 8453,
  factoryAddress: "0x0000000000000000000000000000000000000001",
  coinAddress: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
  poolKey:
    "0x0fe6333346fcd0ffa4be3fda91f271bda52c6755f604b06483b709666d363628",
  poolId:
    "0x0fe6333346fcd0ffa4be3fda91f271bda52c6755f604b06483b709666d363628",
  transactionHash:
    "0x2222222222222222222222222222222222222222222222222222222222222222",
  eventName: "CoinCreatedV4",
} as const satisfies FamePoolStateV4ZoraProvenanceEvidence;

function registryWithFirstPool(overrides: Record<string, unknown>): unknown {
  const [firstPool, ...remainingPools] = famePoolStateRegistry.pools;
  if (!firstPool) throw new Error("Generated registry has no pools.");

  return {
    ...famePoolStateRegistry,
    pools: [{ ...firstPool, ...overrides }, ...remainingPools],
  };
}

function registryWithPool(
  poolId: string,
  overrides: Record<string, unknown>,
): unknown {
  const pool = famePoolStateRegistry.pools.find((entry) => entry.id === poolId);
  if (!pool) throw new Error(`Generated registry missing ${poolId}.`);

  return {
    ...famePoolStateRegistry,
    pools: [{ ...pool, ...overrides }],
  };
}

describe("FAME swap pool-state registry", () => {
  test("loads the generated www registry with quote-model and tracked-only pools", () => {
    const quoteModelPools = famePoolStateRegistry.pools.filter(
      (pool) => pool.capability === "quote-model",
    );
    const trackedOnlyPools = famePoolStateRegistry.pools.filter(
      (pool) => pool.capability === "tracked-only",
    );

    expect(famePoolStateRegistry.source.repo).toBe("www");
    expect(quoteModelPools.map((pool) => pool.id)).toEqual([
      "scale-equalizer-frxusd-fame",
      "scale-equalizer-scale-fame",
      "scale-equalizer-weth-fame",
      "uniswap-v2-fame-direct",
    ]);
    expect(trackedOnlyPools.length).toBeGreaterThan(0);
    expect(
      quoteModelPools.every(
        (pool) =>
          pool.stateSurface === "constant-product-reserves" &&
          pool.activationStatus === "reserve-compact-quote-active" &&
          pool.replaySurface === null &&
          pool.quoteModel === "constant-product-reserves" &&
          pool.unsupportedReason === null,
      ),
    ).toBe(true);
  });

  test("looks up entries by pool id and chain pool address", () => {
    const byId = getFamePoolStateRegistryEntry({
      poolId: "uniswap-v2-fame-direct",
    });
    const byAddress = getFamePoolStateRegistryEntry({
      chainId: 8453,
      poolAddress: "0x3e2cab55bebf41719148b4e6b63f6644b18ae49c",
    });

    expect(byId).toBeDefined();
    expect(byAddress).toBeDefined();
    expect(byAddress).toBe(byId);
  });

  test("keeps non-direct pools tracked but unsupported", () => {
    const stable = getFamePoolStateRegistryEntry({
      poolId: "scale-equalizer-usdc-frxusd",
    });

    expect(stable?.capability).toBe("tracked-only");
    expect(stable?.activationStatus).toBe("tracked-only");
    expect(stable?.unsupportedReason).toBe("non-direct-fame-pool");
    expect(stable?.stateSurface).toBeNull();
  });

  test("keeps only direct FAME CL pools eligible for market state", () => {
    const marketState = famePoolStateRegistry.pools.filter(
      (pool) => pool.capability === "market-state",
    );
    const candidate = getFamePoolStateRegistryEntry({
      poolId: "slipstream-basedflick-fame",
    });
    const v4Dependency = getFamePoolStateRegistryEntry({
      poolId: "uniswap-v4-basedflick-zora",
    });

    expect(marketState.map((pool) => pool.id)).toEqual([
      "slipstream-basedflick-fame",
    ]);
    expect(candidate?.capability).toBe("market-state");
    expect(candidate?.activationStatus).toBe("cl-compact-quote-active");
    expect(candidate?.factoryAddress).toBe(
      "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a",
    );
    expect(candidate?.replaySurface).toBe("cl-replay-v1");
    expect(v4Dependency?.capability).toBe("tracked-only");
    expect(v4Dependency?.activationStatus).toBe("tracked-only");
    expect(v4Dependency?.stateSurface).toBeNull();
    expect(v4Dependency?.replaySurface).toBeNull();
    expect(v4Dependency?.unsupportedReason).toBe("non-direct-fame-pool");
  });

  test("classifies only reviewed named V4 Zora quote lanes as eligible", () => {
    const target = getFamePoolStateRegistryEntry({
      poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
    });
    const zoraEth = getFamePoolStateRegistryEntry({
      poolId: FAME_V4_ZORA_ETH_QUOTE_LANE_POOL_ID,
    });
    const otherV4 = getFamePoolStateRegistryEntry({
      poolId: "uniswap-v4-usdc-eth",
    });
    if (!target || !zoraEth || !otherV4) {
      throw new Error("Generated registry missing V4 fixtures.");
    }

    expect(classifyV4ZoraQuoteLane(target)).toMatchObject({
      status: "target-blocked",
      reason: "capability-mismatch",
    });
    expect(
      classifyV4ZoraQuoteLane(target, VERIFIED_V4_ZORA_PROVENANCE),
    ).toMatchObject({
      status: "target-blocked",
      reason: "capability-mismatch",
    });
    expect(classifyV4ZoraQuoteLane(zoraEth)).toMatchObject({
      status: "target-blocked",
      reason: "capability-mismatch",
    });
    expect(
      classifyV4ZoraQuoteLane(otherV4, VERIFIED_V4_ZORA_PROVENANCE),
    ).toMatchObject({
      status: "non-target-v4-unsupported",
      reason: "non-target-v4-pool",
    });
  });

  test("marks only activation-approved Slipstream v1 rows as replay-capable", () => {
    const replayPools = famePoolStateRegistry.pools.filter(
      (pool) => pool.replaySurface === "cl-replay-v1",
    );

    expect(replayPools.map((pool) => pool.id).sort()).toEqual([
      "slipstream-basedflick-fame",
    ]);
    const baseline = replayPools.find(
      (pool) => pool.id === "slipstream-basedflick-fame",
    );
    expect(baseline?.activationStatus).toBe("cl-compact-quote-active");
    expect(baseline?.stateSurface).toBe("cl-head-snapshot");
    expect(baseline?.venue).toBe("aerodrome-slipstream");
    expect(baseline?.tickSpacing).toBe(2000);
    expect(baseline?.poolAddress).toBe(
      "0xbd7e5bb5a6251f6dde2cf56afa50ed0c8b4c2cdb",
    );
  });

  test("rejects malformed generated registry rows", () => {
    const broken = registryWithFirstPool({
      poolAddress: "not-an-address",
    });

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /poolAddress: must be an EVM address/,
    );
  });

  test("requires explicit replaySurface fields in schema v4 rows", () => {
    const [firstPool, ...remainingPools] = famePoolStateRegistry.pools;
    if (!firstPool) throw new Error("Generated registry has no pools.");
    const poolWithoutReplaySurface: Record<string, unknown> = { ...firstPool };
    delete poolWithoutReplaySurface.replaySurface;

    const broken = {
      ...famePoolStateRegistry,
      pools: [poolWithoutReplaySurface, ...remainingPools],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /replaySurface: missing required field/,
    );
  });

  test("requires explicit activationStatus fields in schema v4 rows", () => {
    const [firstPool, ...remainingPools] = famePoolStateRegistry.pools;
    if (!firstPool) throw new Error("Generated registry has no pools.");
    const poolWithoutActivationStatus: Record<string, unknown> = {
      ...firstPool,
    };
    delete poolWithoutActivationStatus.activationStatus;

    const broken = {
      ...famePoolStateRegistry,
      pools: [poolWithoutActivationStatus, ...remainingPools],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /activationStatus: missing required field/,
    );
  });

  test("requires explicit factoryAddress fields in schema v4 rows", () => {
    const [firstPool, ...remainingPools] = famePoolStateRegistry.pools;
    if (!firstPool) throw new Error("Generated registry has no pools.");
    const poolWithoutFactoryAddress: Record<string, unknown> = {
      ...firstPool,
    };
    delete poolWithoutFactoryAddress.factoryAddress;

    const broken = {
      ...famePoolStateRegistry,
      pools: [poolWithoutFactoryAddress, ...remainingPools],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /factoryAddress: missing required field/,
    );
  });

  test("rejects quote-model rows without fee metadata", () => {
    const broken = registryWithPool("uniswap-v2-fame-direct", {
      fee: {
        status: "unavailable",
        reason: "unit test",
      },
    });

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /quote-model pool must have fee metadata/,
    );
  });

  test("rejects market-state rows without complete reader metadata", () => {
    const clPool = famePoolStateRegistry.pools.find(
      (pool) =>
        pool.capability === "market-state" && pool.venue !== "uniswap-v4",
    );
    if (!clPool)
      throw new Error("Generated registry has no address-backed CL pool.");
    const broken = {
      ...famePoolStateRegistry,
      pools: [
        {
          ...clPool,
          poolAddress: null,
        },
      ],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /address-backed market-state pool must have poolAddress/,
    );
  });

  test("rejects Slipstream market-state rows without factory identity", () => {
    const clPool = famePoolStateRegistry.pools.find(
      (pool) =>
        pool.capability === "market-state" &&
        pool.venue === "aerodrome-slipstream",
    );
    if (!clPool)
      throw new Error(
        "Generated registry has no Slipstream market-state pool.",
      );
    const broken = {
      ...famePoolStateRegistry,
      pools: [
        {
          ...clPool,
          factoryAddress: null,
        },
      ],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /Slipstream market-state pool must have factoryAddress/,
    );
  });

  test("rejects replay-surface rows without compact quote activation", () => {
    const replayPool = famePoolStateRegistry.pools.find(
      (pool) => pool.id === "slipstream-basedflick-fame",
    );
    if (!replayPool) {
      throw new Error("Generated registry missing CL replay fixtures.");
    }
    const broken = {
      ...famePoolStateRegistry,
      pools: [
        {
          ...replayPool,
          activationStatus: "cl-head-only",
          replaySurface: "cl-replay-v1",
        },
      ],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /replaySurface requires cl-compact-quote-active activationStatus/,
    );
  });

  test("rejects Slipstream2 replay inheritance", () => {
    const replayPool = famePoolStateRegistry.pools.find(
      (pool) => pool.id === "slipstream-basedflick-fame",
    );
    if (!replayPool) {
      throw new Error("Generated registry missing CL replay fixture.");
    }
    const broken = {
      ...famePoolStateRegistry,
      pools: [
        {
          ...replayPool,
          id: "slipstream2-test",
          venue: "aerodrome-slipstream2",
          venueFamily: "Slipstream2",
          activationStatus: "cl-compact-quote-active",
          replaySurface: "cl-replay-v1",
        },
      ],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /replaySurface pool must be Slipstream v1/,
    );
  });

  test("rejects active CL compact quote rows without replay surface", () => {
    const replayPool = famePoolStateRegistry.pools.find(
      (pool) => pool.id === "slipstream-basedflick-fame",
    );
    if (!replayPool) {
      throw new Error("Generated registry missing CL replay fixture.");
    }
    const broken = {
      ...famePoolStateRegistry,
      pools: [{ ...replayPool, replaySurface: null }],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /cl-compact-quote-active pool must have cl-replay-v1/,
    );
  });
});
