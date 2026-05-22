import { describe, expect, test } from "@jest/globals";
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import type { Address } from "viem";
import { handleFamePoolStateBatchRequest } from "./api.ts";
import { poolStateRequestAuthorized } from "./auth.ts";
import {
  clReplayStateRowsFromSnapshot,
  latestClHeadStateFromSnapshot,
  latestPoolStateKey,
  latestStateFromReserves,
  sourceRegistryIdFor,
  type FameClHeadLatestState,
  type FameClHeadSnapshotRegistryEntry,
  type FameClReplayBitmapChunkState,
  type FameClReplayLatestState,
  type FameClReplayRegistryEntry,
  type FameClReplayTickChunkState,
  type FamePoolLatestState,
  type PoolStateDocumentClient,
  type PoolStateDynamoResponse,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type { FamePoolStateRegistryEntry } from "./types.ts";

type SentCommand = Parameters<PoolStateDocumentClient["send"]>[0];

class BatchStateDb implements PoolStateDocumentClient {
  public readCount = 0;
  private readonly items = new Map<string, Record<string, unknown>>();

  constructor(
    states: readonly (
      | FameClHeadLatestState
      | FameClReplayBitmapChunkState
      | FameClReplayLatestState
      | FameClReplayTickChunkState
      | FamePoolLatestState
    )[],
  ) {
    for (const state of states) {
      const record = recordFromState(state);
      this.items.set(keyFromRecord(record), record);
    }
  }

  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    if (!(command instanceof BatchGetCommand)) {
      throw new Error(`Unexpected command ${command.constructor.name}.`);
    }
    this.readCount += 1;
    const requestItems = parseObject(command.input.RequestItems);
    const responses: Record<string, Record<string, unknown>[]> = {};
    for (const [tableName, request] of Object.entries(requestItems)) {
      const keys = parseObject(request).Keys;
      if (!Array.isArray(keys)) {
        throw new Error("BatchGetCommand keys must be an array.");
      }
      responses[tableName] = keys
        .map((key) => this.items.get(keyFromRecord(parseObject(key))))
        .filter((item): item is Record<string, unknown> => item !== undefined);
    }
    return {
      Responses: responses,
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

function recordFromState(
  state:
    | FameClHeadLatestState
    | FameClReplayBitmapChunkState
    | FameClReplayLatestState
    | FameClReplayTickChunkState
    | FamePoolLatestState,
): Record<string, unknown> {
  return { ...state };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function keyFromRecord(record: Record<string, unknown>): string {
  const pk = record.pk;
  const sk = record.sk;
  if (typeof pk !== "string" || typeof sk !== "string") {
    throw new Error("Expected DynamoDB item key.");
  }
  return `${pk}\u0000${sk}`;
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

function clHeadPool(id: string): FameClHeadSnapshotRegistryEntry {
  const entry = famePoolStateRegistry.pools.find((pool) => pool.id === id);
  if (
    !entry ||
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.tickSpacing === null
  ) {
    throw new Error(`Missing CL head pool ${id}.`);
  }
  return {
    ...entry,
    stateSurface: entry.stateSurface,
    tickSpacing: entry.tickSpacing,
  };
}

function clReplayPool(): FameClReplayRegistryEntry {
  const entry = famePoolStateRegistry.pools.find(
    (pool) => pool.id === "slipstream-usdc-weth-100",
  );
  if (
    !entry ||
    entry.replaySurface !== "cl-replay-v1" ||
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.poolAddress === null ||
    entry.tickSpacing === null ||
    entry.venue !== "aerodrome-slipstream"
  ) {
    throw new Error("Missing CL replay pool.");
  }
  return {
    ...entry,
    replaySurface: entry.replaySurface,
    stateSurface: entry.stateSurface,
    poolAddress: entry.poolAddress,
    tickSpacing: entry.tickSpacing,
    venue: entry.venue,
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

function clHeadStateForPool(
  pool: FameClHeadSnapshotRegistryEntry,
  observedThroughBlock: number,
  sourceRegistryId = sourceRegistryIdFor(famePoolStateRegistry.source),
): FameClHeadLatestState {
  return latestClHeadStateFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: -11,
    liquidity: 555n,
    observedThroughBlock,
    source: pool.venue === "uniswap-v4" ? "v4-state-view" : "pool-slot0-liquidity",
    sourceRegistryId,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });
}

function clReplayRowsForPool(pool: FameClReplayRegistryEntry) {
  return clReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: 199_900,
    liquidity: 1_000n,
    fee: 100n,
    observedThroughBlock: 120,
    blockHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    parentHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    snapshotId: "unit-cl-replay",
    stateHash:
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
    updatedAt: "2026-05-20T00:00:00.000Z",
    bitmapWords: [
      { wordPosition: 7, bitmap: 1n },
      { wordPosition: 8, bitmap: 2n },
    ],
    initializedTicks: [
      { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      { tick: 200_000, liquidityGross: 50n, liquidityNet: -15n },
    ],
    bitmapChunkSize: 1,
    tickChunkSize: 1,
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

  test("returns fresh CL head state for CL-capable requests", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([clHeadStateForPool(pool, 120)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      stateKind: "cl-head-snapshot",
      poolId: pool.id,
      poolAddress: pool.poolAddress,
      poolKey: null,
      sqrtPriceX96: (2n ** 96n).toString(),
      tick: -11,
      liquidity: "555",
      observedThroughBlock: 120,
      source: "pool-slot0-liquidity",
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      maxFreshnessBlocks: 120,
    });
  });

  test("returns fresh CL replay state only when explicitly requested", async () => {
    const pool = clReplayPool();
    const rows = clReplayRowsForPool(pool);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      stateKind: "cl-replay-v1",
      poolId: pool.id,
      poolAddress: pool.poolAddress,
      sqrtPriceX96: (2n ** 96n).toString(),
      tick: 199_900,
      liquidity: "1000",
      fee: "100",
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      snapshotId: "unit-cl-replay",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      bitmapWordCount: 2,
      initializedTickCount: 2,
      bitmapChunkCount: 2,
      tickChunkCount: 2,
      maxFreshnessBlocks: 120,
    });
    expect(response.pools[0]).toMatchObject({
      bitmapWords: [
        {
          wordPosition: 7,
          bitmap:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
        {
          wordPosition: 8,
          bitmap:
            "0x0000000000000000000000000000000000000000000000000000000000000002",
        },
      ],
      initializedTicks: [
        { tick: 199_900, liquidityGross: "25", liquidityNet: "15" },
        { tick: 200_000, liquidityGross: "50", liquidityNet: "-15" },
      ],
    });
  });

  test("returns unknown for incomplete CL replay capsules", async () => {
    const pool = clReplayPool();
    const rows = clReplayRowsForPool(pool);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([rows.latest, ...rows.bitmapChunks]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toEqual({
      status: "unknown",
      requested: { poolId: pool.id },
      reason: "missing-indexed-state",
    });
  });

  test("does not expose CL replay arrays without replay opt-in", async () => {
    const pool = clReplayPool();
    const rows = clReplayRowsForPool(pool);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        clHeadStateForPool(pool, 120),
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      stateKind: "cl-head-snapshot",
      poolId: pool.id,
    });
    expect(response.pools[0]).not.toHaveProperty("bitmapWords");
    expect(response.pools[0]).not.toHaveProperty("initializedTicks");
  });

  test("returns unknown for CL head state from a different registry source", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([clHeadStateForPool(pool, 120, "stale-registry")]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toEqual({
      status: "unknown",
      requested: { poolId: pool.id },
      reason: "missing-indexed-state",
    });
  });

  test("returns unknown for CL head state whose metadata no longer matches the registry", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        {
          ...clHeadStateForPool(pool, 120),
          token1: pool.token0,
        },
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toEqual({
      status: "unknown",
      requested: { poolId: pool.id },
      reason: "missing-indexed-state",
    });
  });

  test("treats future CL head state as stale", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([clHeadStateForPool(pool, 130)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "stale",
      stateKind: "cl-head-snapshot",
      observedThroughBlock: 130,
    });
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
