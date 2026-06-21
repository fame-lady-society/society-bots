import { describe, expect, test } from "@jest/globals";
import {
  FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
  clReplayReducerManifestForPool,
  isClReplayReducerManifestPool,
} from "./cl-reducer-manifests.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type { FamePoolStateRegistryEntry } from "./types.ts";

function registryEntry(id: string): FamePoolStateRegistryEntry {
  const pool = famePoolStateRegistry.pools.find((entry) => entry.id === id);
  if (!pool) throw new Error(`Missing registry entry ${id}.`);
  return pool;
}

describe("FAME CL reducer manifests", () => {
  test("reviews the selected Slipstream candidate identity and event surface", () => {
    const pool = registryEntry(FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID);
    const manifest = clReplayReducerManifestForPool(pool);

    expect(isClReplayReducerManifestPool(pool)).toBe(true);
    expect(manifest).toMatchObject({
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
      activationStatuses: ["cl-replay-candidate", "cl-compact-quote-active"],
      supportedEvents: ["Swap", "Mint", "Burn", "Collect"],
      requiresCompleteSnapshotSeed: true,
      requiresBitmapCompleteness: true,
      requiresInitializedTickCompleteness: true,
      maxMaintenanceRangeBlocks: 1000,
      quoteRange: {
        minTick: -887272,
        maxTick: 887272,
      },
    });
  });

  test("keeps the selected manifest compatible with candidate and active phases", () => {
    const active = registryEntry(FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID);
    const candidate = {
      ...active,
      activationStatus: "cl-replay-candidate" as const,
      replaySurface: null,
    };
    expect(clReplayReducerManifestForPool(candidate)).not.toBeNull();
    expect(clReplayReducerManifestForPool(active)).not.toBeNull();
    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        replaySurface: "cl-replay-v1",
      }),
    ).toThrow(/manifest candidate cannot be quote active/);
    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        activationStatus: "cl-compact-quote-active",
      }),
    ).toThrow(/requires replaySurface/);
  });

  test("keeps non-selected Slipstream, Slipstream2, and V4 pools unmanifested", () => {
    expect(
      clReplayReducerManifestForPool(registryEntry("slipstream-usdc-weth-100")),
    ).toBeNull();
    expect(
      clReplayReducerManifestForPool(
        registryEntry("uniswap-v4-basedflick-zora"),
      ),
    ).toBeNull();

    const slipstream2 = {
      ...registryEntry(FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID),
      id: "slipstream2-unit-usdc",
      venue: "aerodrome-slipstream2",
      venueFamily: "Slipstream2",
    } satisfies FamePoolStateRegistryEntry;
    expect(clReplayReducerManifestForPool(slipstream2)).toBeNull();
  });

  test("rejects selected candidate manifest drift", () => {
    const candidate = registryEntry(FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID);

    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        venue: "aerodrome-slipstream2",
        venueFamily: "Slipstream2",
      }),
    ).toThrow(/Aerodrome Slipstream v1/);
    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        router: "0x0000000000000000000000000000000000000001",
      }),
    ).toThrow(/router does not match manifest/);
    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        factoryAddress: "0x0000000000000000000000000000000000000001",
      }),
    ).toThrow(/factory address does not match manifest/);
    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        token0: candidate.token1,
        token1: candidate.token0,
      }),
    ).toThrow(/token0 does not match manifest/);
    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        tickSpacing: 100,
      }),
    ).toThrow(/tick spacing does not match manifest/);
    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        poolAddress: "0x0000000000000000000000000000000000000001",
      }),
    ).toThrow(/pool address does not match manifest/);
    expect(() =>
      clReplayReducerManifestForPool({
        ...candidate,
        fee: { status: "unavailable", reason: "unit" },
      }),
    ).toThrow(/fee metadata/);
  });
});
