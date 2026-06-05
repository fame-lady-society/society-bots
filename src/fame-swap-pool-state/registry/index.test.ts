import { describe, expect, test } from "@jest/globals";
import {
  FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
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
      "aerodrome-v2-usdc-weth",
      "scale-equalizer-frxusd-fame",
      "scale-equalizer-scale-fame",
      "scale-equalizer-usdc-scale",
      "scale-equalizer-weth-fame",
      "uniswap-v2-fame-direct",
      "uniswap-v2-usdc-weth",
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

  test("keeps stable Solidly pools tracked but unsupported", () => {
    const stable = getFamePoolStateRegistryEntry({
      poolId: "scale-equalizer-usdc-frxusd",
    });

    expect(stable?.capability).toBe("tracked-only");
    expect(stable?.activationStatus).toBe("tracked-only");
    expect(stable?.unsupportedReason).toBe("stable-pool");
    expect(stable?.stateSurface).toBeNull();
  });

  test("keeps CL head-snapshot pools eligible for market state", () => {
    const uniswapV3 = getFamePoolStateRegistryEntry({
      poolId: "uniswap-v3-usdc-weth-5bps",
    });
    const slipstream = famePoolStateRegistry.pools.find(
      (pool) => pool.venue === "aerodrome-slipstream",
    );
    const slipstream2 = famePoolStateRegistry.pools.find(
      (pool) => pool.venue === "aerodrome-slipstream2",
    );
    const uniswapV4 = famePoolStateRegistry.pools.find(
      (pool) => pool.venue === "uniswap-v4",
    );
    const candidate = getFamePoolStateRegistryEntry({
      poolId: "slipstream-basedflick-fame",
    });
    const v4Dependency = getFamePoolStateRegistryEntry({
      poolId: "uniswap-v4-basedflick-zora",
    });

    expect(uniswapV3?.capability).toBe("market-state");
    expect(uniswapV3?.activationStatus).toBe("cl-head-only");
    expect(uniswapV3?.stateSurface).toBe("cl-head-snapshot");
    expect(uniswapV3?.poolAddress).not.toBeNull();
    expect(uniswapV3?.tickSpacing).not.toBeNull();
    expect(slipstream?.capability).toBe("market-state");
    expect(slipstream?.stateSurface).toBe("cl-head-snapshot");
    if (slipstream2) {
      expect(slipstream2.capability).toBe("market-state");
      expect(slipstream2.stateSurface).toBe("cl-head-snapshot");
    }
    expect(uniswapV4?.capability).toBe("market-state");
    expect(uniswapV4?.stateSurface).toBe("cl-head-snapshot");
    expect(uniswapV4?.poolAddress).toBeNull();
    expect(uniswapV4?.poolKey).not.toBeNull();
    expect(uniswapV4?.stateViewAddress).not.toBeNull();
    expect(candidate?.capability).toBe("market-state");
    expect(candidate?.activationStatus).toBe("cl-compact-quote-active");
    expect(candidate?.factoryAddress).toBe(
      "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a",
    );
    expect(candidate?.replaySurface).toBe("cl-replay-v1");
    expect(v4Dependency?.capability).toBe("market-state");
    expect(v4Dependency?.activationStatus).toBe("unsupported");
    expect(v4Dependency?.replaySurface).toBeNull();
  });

  test("classifies only BASEDFLICK/ZORA as the reviewed V4 Zora quote lane", () => {
    const target = getFamePoolStateRegistryEntry({
      poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
    });
    const otherV4 = getFamePoolStateRegistryEntry({
      poolId: "uniswap-v4-usdc-eth",
    });
    if (!target || !otherV4) {
      throw new Error("Generated registry missing V4 fixtures.");
    }

    expect(classifyV4ZoraQuoteLane(target)).toMatchObject({
      status: "target-blocked",
      reason: "missing-provenance",
    });
    expect(
      classifyV4ZoraQuoteLane(target, VERIFIED_V4_ZORA_PROVENANCE),
    ).toMatchObject({
      status: "target-eligible",
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
      "slipstream-usdc-weth-100",
    ]);
    const baseline = replayPools.find(
      (pool) => pool.id === "slipstream-usdc-weth-100",
    );
    expect(baseline?.activationStatus).toBe("cl-compact-quote-active");
    expect(baseline?.stateSurface).toBe("cl-head-snapshot");
    expect(baseline?.venue).toBe("aerodrome-slipstream");
    expect(baseline?.tickSpacing).toBe(100);
    expect(baseline?.poolAddress).toBe(
      "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59",
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
    const broken = registryWithFirstPool({
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
      (pool) => pool.id === "slipstream-usdc-weth-100",
    );
    const otherClPool = famePoolStateRegistry.pools.find(
      (pool) =>
        pool.id !== "slipstream-usdc-weth-100" &&
        pool.id !== "slipstream-basedflick-fame" &&
        pool.capability === "market-state" &&
        pool.venue === "aerodrome-slipstream",
    );
    if (!replayPool || !otherClPool) {
      throw new Error("Generated registry missing CL replay fixtures.");
    }
    const broken = {
      ...famePoolStateRegistry,
      pools: [{ ...otherClPool, replaySurface: "cl-replay-v1" }, replayPool],
    };

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /replaySurface requires cl-compact-quote-active activationStatus/,
    );
  });

  test("rejects Slipstream2 replay inheritance", () => {
    const replayPool = famePoolStateRegistry.pools.find(
      (pool) => pool.id === "slipstream-usdc-weth-100",
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
      (pool) => pool.id === "slipstream-usdc-weth-100",
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
