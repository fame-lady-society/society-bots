import { describe, expect, jest, test } from "@jest/globals";
import type { Address } from "viem";
import {
  createFameLandingSnapshotDependencies,
  produceAndPublishFameLandingSnapshot,
  type FameLandingMulticallClient,
} from "./landing-snapshot-runtime.ts";
import { fameLandingAuthority } from "./landing-snapshot.ts";
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
