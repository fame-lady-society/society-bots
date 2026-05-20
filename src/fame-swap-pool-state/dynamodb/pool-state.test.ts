import { describe, expect, test } from "@jest/globals";
import type { Address, Hex } from "viem";
import {
  batchGetLatestClHeadStates,
  batchGetLatestPoolStates,
  comparePoolStateEventVersions,
  getLatestClHeadState,
  getLatestPoolState,
  latestClHeadStateFromSnapshot,
  latestClHeadStateKey,
  latestPoolStateKey,
  latestStateFromReserves,
  putLatestClHeadState,
  putLatestPoolState,
  type FameClHeadSnapshotRegistryEntry,
  type PoolStateDocumentClient,
  type PoolStateDynamoResponse,
} from "./pool-state.ts";
import { famePoolStateRegistry } from "../registry/index.ts";
import type { FamePoolStateRegistryEntry } from "../types.ts";

type SentCommand = Parameters<PoolStateDocumentClient["send"]>[0];

class ConditionalFailureDb implements PoolStateDocumentClient {
  public readonly commands: SentCommand[] = [];

  async send(command: SentCommand): Promise<Record<string, never>> {
    this.commands.push(command);
    const error = new Error("conditional");
    error.name = "ConditionalCheckFailedException";
    throw error;
  }
}

class UnprocessedBatchDb implements PoolStateDocumentClient {
  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    if (command.constructor.name !== "BatchGetCommand") {
      throw new Error(`Unexpected command ${command.constructor.name}.`);
    }

    return {
      Responses: {
        PoolState: [],
      },
      UnprocessedKeys: {
        PoolState: {
          Keys: [
            {
              pk: "pool:8453:0x0000000000000000000000000000000000000001",
              sk: "latest",
            },
          ],
        },
      },
    };
  }
}

class ThrowingBatchDb implements PoolStateDocumentClient {
  public readCount = 0;

  async send(): Promise<PoolStateDynamoResponse> {
    this.readCount += 1;
    throw new Error("DynamoDB should not be called.");
  }
}

class MalformedLatestItemDb implements PoolStateDocumentClient {
  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    if (command.constructor.name !== "GetCommand") {
      throw new Error(`Unexpected command ${command.constructor.name}.`);
    }

    return {
      Item: {
        pk: "pool:8453:0x0000000000000000000000000000000000000001",
        sk: "latest",
        poolId: "unit",
        chainId: "8453",
      },
    };
  }
}

class ItemDb implements PoolStateDocumentClient {
  constructor(private readonly item: Record<string, unknown>) {}

  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    if (command.constructor.name !== "GetCommand") {
      throw new Error(`Unexpected command ${command.constructor.name}.`);
    }

    return {
      Item: this.item,
    };
  }
}

function quoteModelPool(id: string): FamePoolStateRegistryEntry & { poolAddress: Address } {
  const pool = famePoolStateRegistry.pools.find((entry) => entry.id === id);
  if (!pool || pool.poolAddress === null) {
    throw new Error(`Missing quote-model pool ${id}.`);
  }
  return {
    ...pool,
    poolAddress: pool.poolAddress,
  };
}

function clHeadPool(id: string): FameClHeadSnapshotRegistryEntry {
  const pool = famePoolStateRegistry.pools.find((entry) => entry.id === id);
  if (
    !pool ||
    pool.stateSurface !== "cl-head-snapshot" ||
    pool.tickSpacing === null
  ) {
    throw new Error(`Missing CL head pool ${id}.`);
  }
  return {
    ...pool,
    stateSurface: pool.stateSurface,
    tickSpacing: pool.tickSpacing,
  };
}

function firstV4ClHeadPool(): FameClHeadSnapshotRegistryEntry {
  const pool = famePoolStateRegistry.pools.find(
    (entry) => entry.venue === "uniswap-v4",
  );
  if (
    !pool ||
    pool.stateSurface !== "cl-head-snapshot" ||
    pool.tickSpacing === null
  ) {
    throw new Error("Missing V4 CL head pool.");
  }
  return {
    ...pool,
    stateSurface: pool.stateSurface,
    tickSpacing: pool.tickSpacing,
  };
}

describe("FAME pool-state DynamoDB mapping", () => {
  test("builds latest-state rows with token-ordered reserves and k", () => {
    const pool = quoteModelPool("uniswap-v2-fame-direct");
    const state = latestStateFromReserves({
      pool,
      reserve0: 100n,
      reserve1: 250n,
      observedThroughBlock: 123,
      version: {
        blockNumber: 120,
        transactionIndex: 2,
        logIndex: 7,
      },
      transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      source: "sync-event",
      sourceRegistryId: "unit",
      updatedAt: "2026-05-17T00:00:00.000Z",
    });

    expect(state).toMatchObject({
      ...latestPoolStateKey(pool.chainId, pool.poolAddress),
      poolId: "uniswap-v2-fame-direct",
      reserve0: "100",
      reserve1: "250",
      k: "25000",
      observedThroughBlock: 123,
      source: "sync-event",
    });
  });

  test("round-trips address-backed CL head rows", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const state = latestClHeadStateFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: -42,
      liquidity: 123_456n,
      observedThroughBlock: 456,
      source: "pool-slot0-liquidity",
      sourceRegistryId: "unit",
      updatedAt: "2026-05-19T00:00:00.000Z",
    });

    expect(state).toMatchObject({
      ...latestClHeadStateKey(pool),
      stateKind: "cl-head-snapshot",
      poolId: "uniswap-v3-usdc-weth-5bps",
      poolAddress: pool.poolAddress,
      poolKey: null,
      sqrtPriceX96: (2n ** 96n).toString(),
      tick: -42,
      liquidity: "123456",
      observedThroughBlock: 456,
      source: "pool-slot0-liquidity",
    });
    await expect(
      getLatestClHeadState({
        db: new ItemDb({ ...state }),
        tableName: "PoolState",
        pool,
      }),
    ).resolves.toEqual(state);
  });

  test("round-trips V4 CL head rows by pool key", async () => {
    const pool = firstV4ClHeadPool();
    const state = latestClHeadStateFromSnapshot({
      pool,
      sqrtPriceX96: 99n,
      tick: 7,
      liquidity: 1_000n,
      observedThroughBlock: 789,
      source: "v4-state-view",
      sourceRegistryId: "unit",
      updatedAt: "2026-05-19T00:00:00.000Z",
    });

    expect(state).toMatchObject({
      ...latestClHeadStateKey(pool),
      poolAddress: null,
      poolKey: pool.poolKey,
      stateViewAddress: pool.stateViewAddress,
      source: "v4-state-view",
    });
    await expect(
      getLatestClHeadState({
        db: new ItemDb({ ...state }),
        tableName: "PoolState",
        pool,
      }),
    ).resolves.toEqual(state);
  });

  test("orders event versions by block, transaction index, then log index", () => {
    expect(
      comparePoolStateEventVersions(
        { blockNumber: 1, transactionIndex: 1, logIndex: 2 },
        { blockNumber: 1, transactionIndex: 1, logIndex: 3 },
      ),
    ).toBeLessThan(0);
    expect(
      comparePoolStateEventVersions(
        { blockNumber: 2, transactionIndex: 0, logIndex: 0 },
        { blockNumber: 1, transactionIndex: 99, logIndex: 99 },
      ),
    ).toBeGreaterThan(0);
  });

  test("returns ignored for stale conditional writes", async () => {
    const db = new ConditionalFailureDb();
    const pool = quoteModelPool("uniswap-v2-fame-direct");
    const result = await putLatestPoolState({
      db,
      tableName: "PoolState",
      state: latestStateFromReserves({
        pool,
        reserve0: 100n,
        reserve1: 250n,
        observedThroughBlock: 123,
        version: {
          blockNumber: 120,
          transactionIndex: 2,
          logIndex: 7,
        },
        transactionHash: null,
        source: "sync-event",
        sourceRegistryId: "unit",
        updatedAt: "2026-05-17T00:00:00.000Z",
      }),
    });

    expect(result).toBe("ignored");
    expect(db.commands).toHaveLength(1);
  });

  test("rejects incomplete batch reads with unprocessed keys", async () => {
    const pool = quoteModelPool("uniswap-v2-fame-direct");

    await expect(
      batchGetLatestPoolStates({
        db: new UnprocessedBatchDb(),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/unprocessed keys/);
  });

  test("rejects incomplete CL head batch reads with unprocessed keys", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");

    await expect(
      batchGetLatestClHeadStates({
        db: new UnprocessedBatchDb(),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/unprocessed keys/);
  });

  test("returns an empty batch without reading DynamoDB", async () => {
    const db = new ThrowingBatchDb();

    await expect(
      batchGetLatestPoolStates({
        db,
        tableName: "PoolState",
        pools: [],
      }),
    ).resolves.toEqual([]);
    expect(db.readCount).toBe(0);
  });

  test("rejects malformed persisted latest-state items", async () => {
    const pool = quoteModelPool("uniswap-v2-fame-direct");

    await expect(
      getLatestPoolState({
        db: new MalformedLatestItemDb(),
        tableName: "PoolState",
        chainId: pool.chainId,
        poolAddress: pool.poolAddress,
      }),
    ).rejects.toThrow(/Invalid latest pool-state DynamoDB item/);
  });

  test("rejects malformed persisted CL head items", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const state = latestClHeadStateFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: -42,
      liquidity: 123_456n,
      observedThroughBlock: 456,
      source: "pool-slot0-liquidity",
      sourceRegistryId: "unit",
      updatedAt: "2026-05-19T00:00:00.000Z",
    });

    await expect(
      getLatestClHeadState({
        db: new ItemDb({
          ...state,
          liquidity: undefined,
        }),
        tableName: "PoolState",
        pool,
      }),
    ).rejects.toThrow(/Invalid latest CL head-state DynamoDB item/);
  });

  test("returns ignored for stale CL head conditional writes", async () => {
    const db = new ConditionalFailureDb();
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const result = await putLatestClHeadState({
      db,
      tableName: "PoolState",
      state: latestClHeadStateFromSnapshot({
        pool,
        sqrtPriceX96: 2n ** 96n,
        tick: 1,
        liquidity: 100n,
        observedThroughBlock: 123,
        source: "pool-slot0-liquidity",
        sourceRegistryId: "unit",
        updatedAt: "2026-05-19T00:00:00.000Z",
      }),
    });

    expect(result).toBe("ignored");
    expect(db.commands).toHaveLength(1);
  });
});
