import { describe, expect, test } from "@jest/globals";
import type { Address } from "viem";
import { handleFamePoolStateBatchRequest } from "./api.ts";
import { poolStateRequestAuthorized } from "./auth.ts";
import {
  latestPoolStateKey,
  latestStateFromReserves,
  type FamePoolLatestState,
  type PoolStateDocumentClient,
  type PoolStateDynamoResponse,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type { FamePoolStateRegistryEntry } from "./types.ts";

type SentCommand = Parameters<PoolStateDocumentClient["send"]>[0];

class BatchStateDb implements PoolStateDocumentClient {
  public readCount = 0;

  constructor(private readonly states: readonly FamePoolLatestState[]) {}

  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    if (command.constructor.name !== "BatchGetCommand") {
      throw new Error(`Unexpected command ${command.constructor.name}.`);
    }
    this.readCount += 1;
    return {
      Responses: {
        PoolState: this.states.map(recordFromState),
      },
    };
  }
}

class IncompleteBatchStateDb implements PoolStateDocumentClient {
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

function recordFromState(state: FamePoolLatestState): Record<string, unknown> {
  return { ...state };
}

function quotePool(
  id: string,
): FamePoolStateRegistryEntry & { poolAddress: Address } {
  const entry = famePoolStateRegistry.pools.find((pool) => pool.id === id);
  if (!entry || entry.poolAddress === null) {
    throw new Error(`Missing quote pool ${id}.`);
  }
  return {
    ...entry,
    poolAddress: entry.poolAddress,
  };
}

function stateForPool(
  pool: FamePoolStateRegistryEntry & { poolAddress: Address },
  observedThroughBlock: number,
): FamePoolLatestState {
  return latestStateFromReserves({
    pool,
    reserve0: 100n,
    reserve1: 250n,
    observedThroughBlock,
    version: {
      blockNumber: observedThroughBlock - 1,
      transactionIndex: 0,
      logIndex: 0,
    },
    transactionHash: null,
    source: "getReserves",
    sourceRegistryId: "unit",
    updatedAt: "2026-05-17T00:00:00.000Z",
  });
}

describe("FAME pool-state API contract", () => {
  test("authorizes bearer tokens from the Authorization header", () => {
    expect(
      poolStateRequestAuthorized(
        { authorization: "Bearer unit-token" },
        "unit-token",
      ),
    ).toBe(true);
    expect(
      poolStateRequestAuthorized(
        { Authorization: "Bearer unit-token" },
        "unit-token",
      ),
    ).toBe(true);
    expect(
      poolStateRequestAuthorized(
        { "x-fame-pool-state-token": "unit-token" },
        "unit-token",
      ),
    ).toBe(false);
    expect(poolStateRequestAuthorized({}, "unit-token")).toBe(false);
  });

  test("returns fresh indexed reserve state for quote-model pools", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 120)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      poolId: pool.id,
      reserve0: "100",
      reserve1: "250",
      k: "25000",
      observedThroughBlock: 120,
      maxFreshnessBlocks: 120,
    });
  });

  test("returns unsupported for tracked-only stable and concentrated pools", async () => {
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [
          { poolId: "scale-equalizer-usdc-frxusd" },
          { poolId: "uniswap-v4-usdc-eth" },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([]),
    });

    expect(response.pools).toEqual([
      expect.objectContaining({
        status: "unsupported",
        poolId: "scale-equalizer-usdc-frxusd",
        unsupportedReason: "stable-pool",
      }),
      expect.objectContaining({
        status: "unsupported",
        poolId: "uniswap-v4-usdc-eth",
        unsupportedReason: "concentrated-liquidity",
      }),
    ]);
  });

  test("honors stricter caller freshness without loosening producer freshness", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        maxFreshnessBlocks: 3,
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 120)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.effectiveMaxFreshnessBlocks).toBe(3);
    expect(response.pools[0]).toMatchObject({
      status: "stale",
      maxFreshnessBlocks: 3,
    });
  });

  test("treats future observed-through state as stale", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 130)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "stale",
      observedThroughBlock: 130,
    });
  });

  test("rejects mixed poolId and chain-address request key shapes", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new BatchStateDb([]);

    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [
            {
              poolId: pool.id,
              chainId: pool.chainId,
              poolAddress: pool.poolAddress,
            },
          ],
        },
        tableName: "PoolState",
        db,
      }),
    ).rejects.toThrow(/expected exactly one key shape/);
    expect(db.readCount).toBe(0);
  });

  test("rejects extra fields on otherwise valid request key shapes", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new BatchStateDb([]);

    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [{ poolId: pool.id, extra: true }],
        },
        tableName: "PoolState",
        db,
      }),
    ).rejects.toThrow(/expected exactly one key shape/);
    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [
            {
              chainId: pool.chainId,
              poolAddress: pool.poolAddress,
              extra: true,
            },
          ],
        },
        tableName: "PoolState",
        db,
      }),
    ).rejects.toThrow(/expected exactly one key shape/);
    expect(db.readCount).toBe(0);
  });

  test("returns unknown for absent registry coverage or missing indexed state", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [
          { poolId: "missing-pool" },
          {
            chainId: pool.chainId,
            poolAddress: pool.poolAddress,
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([]),
    });

    expect(response.pools).toEqual([
      expect.objectContaining({
        status: "unknown",
        reason: "missing-registry-entry",
      }),
      expect.objectContaining({
        status: "unknown",
        reason: "missing-indexed-state",
      }),
    ]);
  });

  test("rejects batches larger than the configured maximum before DynamoDB access", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new BatchStateDb([stateForPool(pool, 120)]);

    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [{ poolId: pool.id }, { poolId: "uniswap-v2-usdc-weth" }],
        },
        tableName: "PoolState",
        db,
        maxBatchSize: 1,
      }),
    ).rejects.toThrow(/expected at most 1 pools/);
    expect(db.readCount).toBe(0);
  });

  test("can look up a quote-model pool by chain address", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [
          {
            chainId: pool.chainId,
            poolAddress: pool.poolAddress,
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 120)]),
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      poolId: pool.id,
    });
    expect(latestPoolStateKey(pool.chainId, pool.poolAddress).sk).toBe(
      "latest",
    );
  });

  test("matches fetched states by address when registry pool ids change", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const renamedPool = {
      ...pool,
      id: "renamed-uniswap-v2-fame-direct",
    };
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [{ poolId: renamedPool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 120)]),
      registry: {
        ...famePoolStateRegistry,
        pools: [renamedPool],
      },
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      poolId: renamedPool.id,
    });
  });

  test("rejects incomplete DynamoDB batch reads instead of returning missing state", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");

    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [{ poolId: pool.id }],
        },
        tableName: "PoolState",
        db: new IncompleteBatchStateDb(),
      }),
    ).rejects.toThrow(/unprocessed keys/);
  });

  test("returns an empty response batch without reading DynamoDB", async () => {
    const db = new BatchStateDb([]);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [],
      },
      tableName: "PoolState",
      db,
    });

    expect(response.pools).toEqual([]);
    expect(db.readCount).toBe(0);
  });
});
