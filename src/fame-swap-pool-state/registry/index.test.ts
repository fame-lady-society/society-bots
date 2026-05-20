import { describe, expect, test } from "@jest/globals";
import {
  famePoolStateRegistry,
  getFamePoolStateRegistryEntry,
  parseFamePoolStateRegistry,
} from "./index.ts";

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
      (pool) => pool.capability === "quote-model"
    );
    const trackedOnlyPools = famePoolStateRegistry.pools.filter(
      (pool) => pool.capability === "tracked-only"
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

    expect(uniswapV3?.capability).toBe("market-state");
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
  });

  test("rejects malformed generated registry rows", () => {
    const broken = registryWithFirstPool({
      poolAddress: "not-an-address",
    });

    expect(() => parseFamePoolStateRegistry(broken)).toThrow(
      /poolAddress: must be an EVM address/
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
      /quote-model pool must have fee metadata/
    );
  });

  test("rejects market-state rows without complete reader metadata", () => {
    const clPool = famePoolStateRegistry.pools.find(
      (pool) => pool.capability === "market-state" && pool.venue !== "uniswap-v4",
    );
    if (!clPool) throw new Error("Generated registry has no address-backed CL pool.");
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
});
