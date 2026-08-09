import { describe, expect, jest, test } from "@jest/globals";
import type { Address } from "viem";
import {
  createFameLandingSnapshotDependencies,
  produceAndPublishFameLandingSnapshot,
  type FameLandingMulticallClient,
} from "./landing-snapshot-runtime.ts";
import { fameLandingAuthority } from "./landing-snapshot.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type { PoolStateDocumentClient } from "./dynamodb/pool-state.ts";
import type { FamePoolStateIndexerResult } from "./indexer.ts";

function indexerResult(): FamePoolStateIndexerResult {
  return {
    chainId: 8453,
    safeBlockHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    durationMs: 100,
    fromBlock: 100,
    observedThroughBlock: 120,
    syncEvents: 0,
    writtenEvents: 0,
    ignoredEvents: 0,
    seededPools: 0,
    reconciledPools: 0,
    observedPools: 0,
    clHeadSnapshots: 0,
    clHeadWrittenPools: 0,
    clHeadFailedPools: 0,
    clHeadFailures: [],
    clReplaySnapshots: 0,
    clReplayWrittenPools: 0,
    clReplayFailedPools: 0,
    clReplayFailures: [],
    clReplayMetrics: [],
    v4ClReplaySnapshots: 0,
    v4ClReplayWrittenPools: 0,
    v4ClReplayFailedPools: 0,
    v4ClReplayFailures: [],
    v4ClReplayMetrics: [],
    v4ClReplayMaintenanceMetrics: [],
    clReplayMaintenanceMetrics: [],
    sourceRegistryId: fameLandingAuthority.sourceRegistryId,
  };
}

describe("FAME landing production reads", () => {
  test("uses one block-pinned marketplace multicall and validates authority identities", async () => {
    const multicall = jest.fn<FameLandingMulticallClient["multicall"]>(
      async () => [
        fameLandingAuthority.fameToken,
        "0xBB5ED04dD7B207592429eb8d599d103CCad646c4",
        "0xC8268c2aa571F3C88044C2959F73DdB8eB9e139F",
        false,
        50n,
        2n,
        1n,
        3n,
        1_000_000n,
        888_000_000n,
        18,
      ],
    );
    const deps = createFameLandingSnapshotDependencies({
      tableName: "PoolState",
      rpc: { multicall },
    });

    await expect(deps.readMarketplace({ blockNumber: 123n })).resolves.toEqual({
      premium: 50n,
      unit: 1_000_000n,
      totalSupply: 888_000_000n,
      decimals: 18,
    });
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0]?.[0]).toMatchObject({
      allowFailure: false,
      blockNumber: 123n,
      contracts: expect.arrayContaining([
        expect.objectContaining({ functionName: "premium" }),
        expect.objectContaining({ functionName: "unit" }),
        expect.objectContaining({ functionName: "totalSupply" }),
      ]),
    });
  });

  test("reads concentrated balances in one block-pinned multicall", async () => {
    const multicall = jest.fn<FameLandingMulticallClient["multicall"]>(
      async () => [11n, 22n],
    );
    const deps = createFameLandingSnapshotDependencies({
      tableName: "PoolState",
      rpc: { multicall },
    });
    const tokens = [
      fameLandingAuthority.fameToken,
      "0x4200000000000000000000000000000000000006" as Address,
    ] as const;
    await expect(
      deps.readConcentratedPoolBalances({
        blockNumber: 456n,
        poolId: "slipstream-basedflick-fame",
        poolAddress: "0x1111111111111111111111111111111111111111",
        tokenAddresses: tokens,
      }),
    ).resolves.toEqual({
      poolId: "slipstream-basedflick-fame",
      balances: {
        [tokens[0].toLowerCase()]: 11n,
        [tokens[1].toLowerCase()]: 22n,
      },
    });
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0]?.[0]).toMatchObject({
      allowFailure: false,
      blockNumber: 456n,
    });
  });

  test("reads connector reserves once at the safe block without indexing them", async () => {
    const connector = famePoolStateRegistry.pools.find(
      ({ id }) => id === "aerodrome-v2-usdc-weth",
    );
    if (!connector?.poolAddress) throw new Error("Missing connector fixture.");
    const multicall = jest.fn<FameLandingMulticallClient["multicall"]>(
      async () => [[11n, 22n, 123]],
    );
    const deps = createFameLandingSnapshotDependencies({
      tableName: "PoolState",
      rpc: { multicall },
    });

    await expect(
      deps.readRuntimePoolReserves({
        blockNumber: 789n,
        pools: [
          {
            poolId: connector.id,
            poolAddress: connector.poolAddress,
          },
        ],
      }),
    ).resolves.toEqual([
      {
        poolId: connector.id,
        blockNumber: 789n,
        reserve0: 11n,
        reserve1: 22n,
      },
    ]);
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: false,
        blockNumber: 789n,
        contracts: [
          expect.objectContaining({
            address: connector.poolAddress,
            functionName: "getReserves",
          }),
        ],
      }),
    );
  });

  test("rejects runtime reserve pools outside the fixed landing authority", async () => {
    const unrelated = famePoolStateRegistry.pools.find(
      ({ id }) => id === "scale-equalizer-usdc-scale",
    );
    if (!unrelated?.poolAddress) {
      throw new Error("Missing unrelated tracked pool fixture.");
    }
    const multicall = jest.fn<FameLandingMulticallClient["multicall"]>();
    const deps = createFameLandingSnapshotDependencies({
      tableName: "PoolState",
      rpc: { multicall },
    });

    await expect(
      deps.readRuntimePoolReserves({
        blockNumber: 789n,
        pools: [
          {
            poolId: unrelated.id,
            poolAddress: unrelated.poolAddress,
          },
        ],
      }),
    ).rejects.toThrow(/outside authority/u);
    expect(multicall).not.toHaveBeenCalled();
  });

  test("validates final connector quotes in one safe-block batch with per-leaf failures", async () => {
    const connector = famePoolStateRegistry.pools.find(
      ({ id }) => id === "aerodrome-v2-usdc-weth",
    );
    if (!connector?.poolAddress) throw new Error("Missing connector fixture.");
    const multicall = jest.fn<FameLandingMulticallClient["multicall"]>(
      async () => [
        { status: "success", result: 22n },
        { status: "failure", error: new Error("single quote failed") },
      ],
    );
    const deps = createFameLandingSnapshotDependencies({
      tableName: "PoolState",
      rpc: { multicall },
    });
    const requests = [
      {
        quoteDefinitionId: "defi-buy-usdc-v1" as const,
        poolId: connector.id,
        poolAddress: connector.poolAddress,
        tokenIn: connector.token1,
        amountIn: 10n,
      },
      {
        quoteDefinitionId: "defi-sell-usdc-v1" as const,
        poolId: connector.id,
        poolAddress: connector.poolAddress,
        tokenIn: connector.token0,
        amountIn: 20n,
      },
    ];

    await expect(
      deps.readRuntimePoolQuotes({ blockNumber: 790n, requests }),
    ).resolves.toEqual([
      {
        quoteDefinitionId: "defi-buy-usdc-v1",
        status: "available",
        blockNumber: 790n,
        amountOut: 22n,
      },
      {
        quoteDefinitionId: "defi-sell-usdc-v1",
        status: "unavailable",
      },
    ]);
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        blockNumber: 790n,
        contracts: [
          expect.objectContaining({
            address: connector.poolAddress,
            functionName: "getAmountOut",
            args: [10n, connector.token1],
          }),
          expect.objectContaining({
            address: connector.poolAddress,
            functionName: "getAmountOut",
            args: [20n, connector.token0],
          }),
        ],
      }),
    );
  });

  test("rejects runtime quote requests outside the fixed definition and direction authority", async () => {
    const connector = famePoolStateRegistry.pools.find(
      ({ id }) => id === "aerodrome-v2-usdc-weth",
    );
    const unrelated = famePoolStateRegistry.pools.find(
      ({ id }) => id === "scale-equalizer-usdc-scale",
    );
    if (!connector?.poolAddress || !unrelated?.poolAddress) {
      throw new Error("Missing runtime authority fixtures.");
    }
    const multicall = jest.fn<FameLandingMulticallClient["multicall"]>();
    const deps = createFameLandingSnapshotDependencies({
      tableName: "PoolState",
      rpc: { multicall },
    });
    const valid = {
      quoteDefinitionId: "defi-buy-usdc-v1" as const,
      poolId: connector.id,
      poolAddress: connector.poolAddress,
      tokenIn: connector.token1,
      amountIn: 10n,
    };
    const invalidBatches = [
      [valid, { ...valid, amountIn: 11n }],
      [
        {
          ...valid,
          poolId: unrelated.id,
          poolAddress: unrelated.poolAddress,
          tokenIn: unrelated.token0,
        },
      ],
      [
        {
          ...valid,
          poolAddress: "0x1111111111111111111111111111111111111111" as Address,
        },
      ],
      [
        {
          ...valid,
          tokenIn: "0x2222222222222222222222222222222222222222" as Address,
        },
      ],
      [{ ...valid, amountIn: 0n }],
    ];

    for (const requests of invalidBatches) {
      await expect(
        deps.readRuntimePoolQuotes({ blockNumber: 790n, requests }),
      ).rejects.toThrow(/authority|unique/u);
    }
    expect(multicall).not.toHaveBeenCalled();
  });

  test("applies the run deadline to warm-start reads as well as production", async () => {
    jest.useFakeTimers();
    const db = {
      send: jest.fn(() => new Promise<never>(() => undefined)),
    } as unknown as PoolStateDocumentClient;

    try {
      const result = produceAndPublishFameLandingSnapshot({
        indexResult: indexerResult(),
        tableName: "PoolState",
        db,
        runTimeoutMs: 10,
        leafTimeoutMs: 5,
      });
      const rejection = expect(result).rejects.toThrow(
        "FAME landing snapshot run deadline exceeded",
      );
      await jest.advanceTimersByTimeAsync(11);
      await rejection;
    } finally {
      jest.useRealTimers();
    }
  });
});
