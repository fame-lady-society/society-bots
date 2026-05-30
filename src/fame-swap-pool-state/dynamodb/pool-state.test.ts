import { describe, expect, test } from "@jest/globals";
import { BatchGetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Address, Hex } from "viem";
import {
  batchGetLatestClReplayStates,
  batchGetLatestClReplayCandidateStates,
  batchGetLatestClReplayMaintenanceStates,
  CL_REPLAY_CHUNK_TTL_SECONDS,
  batchGetLatestClHeadStates,
  batchGetLatestPoolStates,
  clReplayCandidateStateRowsFromSnapshot,
  clReplayStateRowsFromSnapshot,
  comparePoolStateEventVersions,
  getLatestClHeadState,
  getLatestPoolState,
  latestClHeadStateFromSnapshot,
  latestClHeadStateKey,
  latestClReplayStateKey,
  latestPoolStateKey,
  putLatestClReplayState,
  putLatestClReplayCandidateState,
  putLatestClReplayMaintenanceState,
  latestStateFromReserves,
  putLatestClHeadState,
  putLatestPoolState,
  sourceRegistryIdFor,
  type FameClReplayRegistryEntry,
  type FameClReplayMaintenanceState,
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

function keyFromItem(item: Record<string, unknown>): string {
  const pk = item.pk;
  const sk = item.sk;
  if (typeof pk !== "string" || typeof sk !== "string") {
    throw new Error("DynamoDB fixture item is missing pk/sk.");
  }
  return `${pk}\u0000${sk}`;
}

function keyFromKey(key: Record<string, unknown>): string {
  const pk = key.pk;
  const sk = key.sk;
  if (typeof pk !== "string" || typeof sk !== "string") {
    throw new Error("DynamoDB fixture key is missing pk/sk.");
  }
  return `${pk}\u0000${sk}`;
}

function stringField(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
}

function numberField(item: Record<string, unknown>, key: string): number {
  const value = item[key];
  if (typeof value !== "number") throw new Error(`${key} must be a number.`);
  return value;
}

function firstItem<T>(items: readonly T[], label: string): T {
  const item = items[0];
  if (!item) throw new Error(`Missing ${label}.`);
  return item;
}

class ReplayStateDb implements PoolStateDocumentClient {
  public readonly commands: SentCommand[] = [];
  public readonly items = new Map<string, Record<string, unknown>>();

  constructor(items: readonly Record<string, unknown>[] = []) {
    for (const item of items) this.items.set(keyFromItem(item), item);
  }

  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    this.commands.push(command);
    if (command instanceof PutCommand) {
      const item = command.input.Item;
      if (!item) throw new Error("PutCommand fixture is missing Item.");
      const condition = String(command.input.ConditionExpression ?? "");
      const existing = this.items.get(keyFromItem(item));
      if (
        condition ===
          "attribute_not_exists(pk) OR observedThroughBlock < :observedThroughBlock OR (observedThroughBlock = :observedThroughBlock AND sourceRegistryId = :sourceRegistryId)" &&
        existing
      ) {
        const values = command.input.ExpressionAttributeValues;
        if (!values) {
          throw new Error(
            "PutCommand fixture is missing ExpressionAttributeValues.",
          );
        }
        const incomingBlock = numberField(values, ":observedThroughBlock");
        const incomingSourceRegistryId = stringField(
          values,
          ":sourceRegistryId",
        );
        const currentBlock = numberField(existing, "observedThroughBlock");
        const currentSourceRegistryId = stringField(
          existing,
          "sourceRegistryId",
        );
        if (
          currentBlock > incomingBlock ||
          (currentBlock === incomingBlock &&
            currentSourceRegistryId !== incomingSourceRegistryId)
        ) {
          const error = new Error("conditional");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
      }
      if (
        condition ===
          "attribute_not_exists(pk) OR cursorBlock < :cursorBlock OR (cursorBlock = :cursorBlock AND cursorTransactionIndex < :cursorTransactionIndex) OR (cursorBlock = :cursorBlock AND cursorTransactionIndex = :cursorTransactionIndex AND cursorLogIndex < :cursorLogIndex) OR (cursorBlock = :cursorBlock AND cursorTransactionIndex = :cursorTransactionIndex AND cursorLogIndex = :cursorLogIndex AND sourceRegistryId = :sourceRegistryId)" &&
        existing
      ) {
        const values = command.input.ExpressionAttributeValues;
        if (!values) {
          throw new Error(
            "PutCommand fixture is missing ExpressionAttributeValues.",
          );
        }
        const incoming = {
          cursorBlock: numberField(values, ":cursorBlock"),
          cursorTransactionIndex: numberField(
            values,
            ":cursorTransactionIndex",
          ),
          cursorLogIndex: numberField(values, ":cursorLogIndex"),
          sourceRegistryId: stringField(values, ":sourceRegistryId"),
        };
        const current = {
          cursorBlock: numberField(existing, "cursorBlock"),
          cursorTransactionIndex: numberField(
            existing,
            "cursorTransactionIndex",
          ),
          cursorLogIndex: numberField(existing, "cursorLogIndex"),
          sourceRegistryId: stringField(existing, "sourceRegistryId"),
        };
        const incomingIsStale =
          current.cursorBlock > incoming.cursorBlock ||
          (current.cursorBlock === incoming.cursorBlock &&
            current.cursorTransactionIndex >
              incoming.cursorTransactionIndex) ||
          (current.cursorBlock === incoming.cursorBlock &&
            current.cursorTransactionIndex ===
              incoming.cursorTransactionIndex &&
            current.cursorLogIndex > incoming.cursorLogIndex) ||
          (current.cursorBlock === incoming.cursorBlock &&
            current.cursorTransactionIndex ===
              incoming.cursorTransactionIndex &&
            current.cursorLogIndex === incoming.cursorLogIndex &&
            current.sourceRegistryId !== incoming.sourceRegistryId);
        if (incomingIsStale) {
          const error = new Error("conditional");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
      }
      this.items.set(keyFromItem(item), item);
      return {};
    }
    if (!(command instanceof BatchGetCommand)) {
      throw new Error(`Unexpected command ${command.constructor.name}.`);
    }

    const request = command.input.RequestItems?.PoolState;
    const keys: Record<string, unknown>[] = request?.Keys ?? [];
    return {
      Responses: {
        PoolState: keys.flatMap((key) => {
          const item = this.items.get(keyFromKey(key));
          return item ? [item] : [];
        }),
      },
    };
  }
}

function quoteModelPool(
  id: string,
): FamePoolStateRegistryEntry & { poolAddress: Address } {
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

function clReplayPool(): FameClReplayRegistryEntry {
  const pool = famePoolStateRegistry.pools.find(
    (entry) => entry.id === "slipstream-usdc-weth-100",
  );
  if (
    !pool ||
    pool.replaySurface !== "cl-replay-v1" ||
    pool.stateSurface !== "cl-head-snapshot" ||
    pool.poolAddress === null ||
    pool.tickSpacing === null ||
    pool.venue !== "aerodrome-slipstream"
  ) {
    throw new Error("Missing replay-capable Slipstream pool.");
  }
  return {
    ...pool,
    replaySurface: pool.replaySurface,
    stateSurface: pool.stateSurface,
    poolAddress: pool.poolAddress,
    tickSpacing: pool.tickSpacing,
    venue: pool.venue,
  };
}

describe("FAME pool-state DynamoDB mapping", () => {
  test("includes the helper registry contract version in source registry ids", () => {
    expect(sourceRegistryIdFor(famePoolStateRegistry.source)).toMatch(
      /^pool-state-registry-v3:0x[0-9a-f]{64}:0x[0-9a-f]{64}$/,
    );
  });

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
      transactionHash:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
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

  test("round-trips complete CL replay capsules with chunked bitmap and ticks", async () => {
    const pool = clReplayPool();
    const rows = clReplayStateRowsFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 123_456_789n,
      fee: 100n,
      observedThroughBlock: 321,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      snapshotId: "unit-snapshot-321",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:00:00.000Z",
      bitmapWords: [
        { wordPosition: 7, bitmap: 1n },
        { wordPosition: 8, bitmap: 2n ** 255n },
      ],
      initializedTicks: [
        { tick: 199_800, liquidityGross: 10n, liquidityNet: -10n },
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
        { tick: 200_000, liquidityGross: 35n, liquidityNet: -5n },
      ],
      bitmapChunkSize: 1,
      tickChunkSize: 2,
    });
    const db = new ReplayStateDb();

    await expect(
      putLatestClReplayState({
        db,
        tableName: "PoolState",
        rows,
      }),
    ).resolves.toBe("written");
    await expect(
      batchGetLatestClReplayStates({
        db,
        tableName: "PoolState",
        pools: [pool],
      }),
    ).resolves.toEqual([
      {
        latest: rows.latest,
        bitmapWords: rows.bitmapChunks.flatMap((chunk) => chunk.bitmapWords),
        initializedTicks: rows.tickChunks.flatMap(
          (chunk) => chunk.initializedTicks,
        ),
      },
    ]);
    expect(db.commands.map((command) => command.constructor.name)).toEqual([
      "PutCommand",
      "PutCommand",
      "PutCommand",
      "PutCommand",
      "PutCommand",
      "BatchGetCommand",
      "BatchGetCommand",
    ]);
    expect(rows.latest).toMatchObject({
      ...latestClReplayStateKey(pool),
      stateKind: "cl-replay-v1",
      fee: "100",
      bitmapWordCount: 2,
      initializedTickCount: 3,
      bitmapChunkCount: 2,
      tickChunkCount: 2,
      minWordPosition: 7,
      maxWordPosition: 8,
      minTick: 199_800,
      maxTick: 200_000,
    });
    expect(rows.latest).not.toHaveProperty("expiresAt");
    expect(rows.bitmapChunks[0]?.expiresAt).toBe(
      Math.floor(Date.parse("2026-05-20T00:00:00.000Z") / 1_000) +
        CL_REPLAY_CHUNK_TTL_SECONDS,
    );
    expect(rows.tickChunks[0]?.expiresAt).toBe(rows.bitmapChunks[0]?.expiresAt);
  });

  test("round-trips replay maintenance rows independently from published replay state", async () => {
    const pool = clReplayPool();
    const trustedState: FameClReplayMaintenanceState = {
      pk: `pool:${pool.chainId.toString()}:address:${pool.poolAddress.toLowerCase()}`,
      sk: "cl-replay-maintenance-v1",
      stateKind: "cl-replay-maintenance-v1",
      poolId: pool.id,
      chainId: pool.chainId,
      poolAddress: pool.poolAddress,
      status: "trusted",
      cursorBlock: 321,
      cursorBlockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      cursorTransactionIndex: 4,
      cursorLogIndex: 9,
      targetBlock: 325,
      targetBlockHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:00:00.000Z",
      lastCheckpointBlock: 300,
      lastCheckpointBlockHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      reason: null,
      candidateId: "candidate-321",
    };
    const db = new ReplayStateDb();

    await expect(
      putLatestClReplayMaintenanceState({
        db,
        tableName: "PoolState",
        state: trustedState,
      }),
    ).resolves.toBe("written");
    await expect(
      batchGetLatestClReplayMaintenanceStates({
        db,
        tableName: "PoolState",
        pools: [pool],
      }),
    ).resolves.toEqual([trustedState]);
    await expect(
      batchGetLatestClReplayStates({
        db,
        tableName: "PoolState",
        pools: [pool],
      }),
    ).resolves.toEqual([]);
  });

  test("persists warming replay maintenance rows without a replay pointer", async () => {
    const pool = clReplayPool();
    const warmingState: FameClReplayMaintenanceState = {
      pk: `pool:${pool.chainId.toString()}:address:${pool.poolAddress.toLowerCase()}`,
      sk: "cl-replay-maintenance-v1",
      stateKind: "cl-replay-maintenance-v1",
      poolId: pool.id,
      chainId: pool.chainId,
      poolAddress: pool.poolAddress,
      status: "warming",
      cursorBlock: 0,
      cursorBlockHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      cursorTransactionIndex: 0,
      cursorLogIndex: 0,
      targetBlock: 0,
      targetBlockHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      stateHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:00:00.000Z",
      lastCheckpointBlock: null,
      lastCheckpointBlockHash: null,
      reason: "seed-required",
      candidateId: null,
    };
    const db = new ReplayStateDb();

    await expect(
      putLatestClReplayMaintenanceState({
        db,
        tableName: "PoolState",
        state: warmingState,
      }),
    ).resolves.toBe("written");
    expect(db.items.get(`${warmingState.pk}\u0000cl-replay-v1`)).toBeUndefined();
  });

  test("rejects stale replay maintenance cursor writes", async () => {
    const pool = clReplayPool();
    const baseState: FameClReplayMaintenanceState = {
      pk: `pool:${pool.chainId.toString()}:address:${pool.poolAddress.toLowerCase()}`,
      sk: "cl-replay-maintenance-v1",
      stateKind: "cl-replay-maintenance-v1",
      poolId: pool.id,
      chainId: pool.chainId,
      poolAddress: pool.poolAddress,
      status: "event-gap",
      cursorBlock: 321,
      cursorBlockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      cursorTransactionIndex: 4,
      cursorLogIndex: 9,
      targetBlock: 325,
      targetBlockHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "registry-a",
      updatedAt: "2026-05-20T00:00:00.000Z",
      lastCheckpointBlock: null,
      lastCheckpointBlockHash: null,
      reason: "cursor-block-hash-mismatch",
      candidateId: null,
    };
    const db = new ReplayStateDb();

    await expect(
      putLatestClReplayMaintenanceState({
        db,
        tableName: "PoolState",
        state: baseState,
      }),
    ).resolves.toBe("written");
    await expect(
      putLatestClReplayMaintenanceState({
        db,
        tableName: "PoolState",
        state: {
          ...baseState,
          cursorLogIndex: 8,
          updatedAt: "2026-05-20T00:01:00.000Z",
        },
      }),
    ).resolves.toBe("ignored");
    await expect(
      putLatestClReplayMaintenanceState({
        db,
        tableName: "PoolState",
        state: {
          ...baseState,
          status: "trusted",
          reason: null,
          updatedAt: "2026-05-20T00:02:00.000Z",
        },
      }),
    ).resolves.toBe("written");
  });

  test("rejects malformed replay maintenance rows", async () => {
    const pool = clReplayPool();
    const state: FameClReplayMaintenanceState = {
      pk: `pool:${pool.chainId.toString()}:address:${pool.poolAddress.toLowerCase()}`,
      sk: "cl-replay-maintenance-v1",
      stateKind: "cl-replay-maintenance-v1",
      poolId: pool.id,
      chainId: pool.chainId,
      poolAddress: pool.poolAddress,
      status: "trusted",
      cursorBlock: 321,
      cursorBlockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      cursorTransactionIndex: 4,
      cursorLogIndex: 9,
      targetBlock: 325,
      targetBlockHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:00:00.000Z",
      lastCheckpointBlock: 300,
      lastCheckpointBlockHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      reason: null,
      candidateId: "candidate-321",
    };

    await expect(
      batchGetLatestClReplayMaintenanceStates({
        db: new ReplayStateDb([{ ...state, status: "ready" }]),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/Invalid CL replay maintenance DynamoDB item/);
    await expect(
      batchGetLatestClReplayMaintenanceStates({
        db: new ReplayStateDb([{ ...state, cursorBlockHash: "0x1" }]),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/Invalid CL replay maintenance DynamoDB item/);
    await expect(
      batchGetLatestClReplayMaintenanceStates({
        db: new ReplayStateDb([{ ...state, sourceRegistryId: "" }]),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/Invalid CL replay maintenance DynamoDB item/);
  });

  test("writes candidate replay chunks before candidate pointer and keeps candidates invisible to quote reads", async () => {
    const pool = clReplayPool();
    const rows = clReplayCandidateStateRowsFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 123_456_789n,
      fee: 100n,
      observedThroughBlock: 321,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      candidateId: "unit-candidate-321",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:00:00.000Z",
      bitmapWords: [
        { wordPosition: 7, bitmap: 1n },
        { wordPosition: 8, bitmap: 2n ** 255n },
      ],
      initializedTicks: [
        { tick: 199_800, liquidityGross: 10n, liquidityNet: -10n },
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      bitmapChunkSize: 1,
      tickChunkSize: 1,
    });
    const db = new ReplayStateDb();

    await expect(
      putLatestClReplayCandidateState({
        db,
        tableName: "PoolState",
        rows,
      }),
    ).resolves.toBe("written");
    await expect(
      batchGetLatestClReplayCandidateStates({
        db,
        tableName: "PoolState",
        pools: [pool],
      }),
    ).resolves.toEqual([
      {
        latest: rows.latest,
        bitmapWords: rows.bitmapChunks.flatMap((chunk) => chunk.bitmapWords),
        initializedTicks: rows.tickChunks.flatMap(
          (chunk) => chunk.initializedTicks,
        ),
      },
    ]);
    await expect(
      batchGetLatestClReplayStates({
        db,
        tableName: "PoolState",
        pools: [pool],
      }),
    ).resolves.toEqual([]);
    expect(db.commands.map((command) => command.constructor.name)).toEqual([
      "PutCommand",
      "PutCommand",
      "PutCommand",
      "PutCommand",
      "PutCommand",
      "BatchGetCommand",
      "BatchGetCommand",
      "BatchGetCommand",
    ]);
    expect(rows.latest).toMatchObject({
      sk: "cl-replay-candidate-v1",
      stateKind: "cl-replay-candidate-v1",
      candidateId: "unit-candidate-321",
    });
  });

  test("keeps the published replay capsule when a same-block registry write is ignored", async () => {
    const pool = clReplayPool();
    const publishedRows = clReplayStateRowsFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      observedThroughBlock: 321,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      snapshotId: "unit-snapshot-321:registry-a",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "registry-a",
      updatedAt: "2026-05-20T00:00:00.000Z",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
    });
    const rejectedRows = clReplayStateRowsFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      observedThroughBlock: 321,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      snapshotId: "unit-snapshot-321:registry-b",
      stateHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      sourceRegistryId: "registry-b",
      updatedAt: "2026-05-20T00:01:00.000Z",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 50n, liquidityNet: 30n },
      ],
    });
    const db = new ReplayStateDb();

    await expect(
      putLatestClReplayState({
        db,
        tableName: "PoolState",
        rows: publishedRows,
      }),
    ).resolves.toBe("written");
    await expect(
      putLatestClReplayState({
        db,
        tableName: "PoolState",
        rows: rejectedRows,
      }),
    ).resolves.toBe("ignored");

    await expect(
      batchGetLatestClReplayStates({
        db,
        tableName: "PoolState",
        pools: [pool],
      }),
    ).resolves.toEqual([
      {
        latest: publishedRows.latest,
        bitmapWords: publishedRows.bitmapChunks.flatMap(
          (chunk) => chunk.bitmapWords,
        ),
        initializedTicks: publishedRows.tickChunks.flatMap(
          (chunk) => chunk.initializedTicks,
        ),
      },
    ]);
  });

  test("returns no CL replay capsule when an expected chunk is missing", async () => {
    const pool = clReplayPool();
    const rows = clReplayStateRowsFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      observedThroughBlock: 321,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      snapshotId: "unit-snapshot-321",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:00:00.000Z",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      bitmapChunkSize: 1,
      tickChunkSize: 1,
    });
    const db = new ReplayStateDb([rows.latest, ...rows.bitmapChunks]);

    await expect(
      batchGetLatestClReplayStates({
        db,
        tableName: "PoolState",
        pools: [pool],
      }),
    ).resolves.toEqual([]);
  });

  test("returns no CL replay capsule when a chunk identity differs from the pointer", async () => {
    const pool = clReplayPool();
    const rows = clReplayStateRowsFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      observedThroughBlock: 321,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      snapshotId: "unit-snapshot-321",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:00:00.000Z",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      bitmapChunkSize: 1,
      tickChunkSize: 1,
    });
    const mismatchedTickChunk = {
      ...rows.tickChunks[0],
      stateHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
    };
    const db = new ReplayStateDb([
      rows.latest,
      ...rows.bitmapChunks,
      mismatchedTickChunk,
    ]);

    await expect(
      batchGetLatestClReplayStates({
        db,
        tableName: "PoolState",
        pools: [pool],
      }),
    ).resolves.toEqual([]);
  });

  test("rejects malformed CL replay fee, bitmap, and tick liquidity values", async () => {
    const pool = clReplayPool();
    const rows = clReplayStateRowsFromSnapshot({
      pool,
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      observedThroughBlock: 321,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      snapshotId: "unit-snapshot-321",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:00:00.000Z",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      bitmapChunkSize: 1,
      tickChunkSize: 1,
    });

    await expect(
      batchGetLatestClReplayStates({
        db: new ReplayStateDb([
          { ...rows.latest, fee: "0100" },
          ...rows.bitmapChunks,
          ...rows.tickChunks,
        ]),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/Invalid latest CL replay-state DynamoDB item/);
    await expect(
      batchGetLatestClReplayStates({
        db: new ReplayStateDb([
          rows.latest,
          {
            ...rows.bitmapChunks[0],
            bitmapWords: [{ wordPosition: 7, bitmap: "0x1" }],
          },
          ...rows.tickChunks,
        ]),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/Invalid CL replay bitmap chunk DynamoDB item/);
    await expect(
      batchGetLatestClReplayStates({
        db: new ReplayStateDb([
          rows.latest,
          ...rows.bitmapChunks,
          {
            ...firstItem(rows.tickChunks, "CL replay tick chunk"),
            initializedTicks: [
              { tick: 199_900, liquidityGross: "25", liquidityNet: 15 },
            ],
          },
        ]),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/Invalid CL replay tick chunk DynamoDB item/);

    const {
      expiresAt: _expiresAt,
      ...tickChunkWithoutExpiresAt
    } = firstItem(rows.tickChunks, "CL replay tick chunk");
    await expect(
      batchGetLatestClReplayStates({
        db: new ReplayStateDb([
          rows.latest,
          ...rows.bitmapChunks,
          tickChunkWithoutExpiresAt,
        ]),
        tableName: "PoolState",
        pools: [pool],
      }),
    ).rejects.toThrow(/Invalid CL replay tick chunk DynamoDB item/);
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
