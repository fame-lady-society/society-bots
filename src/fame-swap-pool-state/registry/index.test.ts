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
});
