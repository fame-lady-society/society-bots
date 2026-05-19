import { describe, expect, test } from "@jest/globals";
import type { Address } from "viem";
import {
  indexFamePoolStates,
  type FamePoolStateIndexerClient,
  type FamePoolStateSyncLog,
} from "./indexer.ts";
import {
  cursorKey,
  latestPoolStateKey,
  type PoolStateDocumentClient,
  type PoolStateDynamoResponse,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
} from "./types.ts";

type SentCommand = Parameters<PoolStateDocumentClient["send"]>[0];

class InMemoryPoolStateDb implements PoolStateDocumentClient {
  private readonly items = new Map<string, Record<string, unknown>>();

  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    const input = command.input as Record<string, unknown>;
    if (command.constructor.name === "GetCommand") {
      const key = keyFromValue(input.Key);
      return { Item: this.items.get(key) };
    }
    if (command.constructor.name === "BatchGetCommand") {
      const requestItems = parseItem(input.RequestItems);
      const responses: Record<string, Record<string, unknown>[]> = {};
      for (const [tableName, request] of Object.entries(requestItems)) {
        const keys = parseItem(request).Keys;
        if (!Array.isArray(keys)) {
          throw new Error("BatchGetCommand keys must be an array.");
        }
        responses[tableName] = keys
          .map((key) => this.items.get(keyFromValue(key)))
          .filter((item): item is Record<string, unknown> => item !== undefined);
      }
      return { Responses: responses };
    }
    if (command.constructor.name === "PutCommand") {
      const item = parseItem(input.Item);
      const key = keyFromItem(item);
      const existing = this.items.get(key);
      const condition = String(input.ConditionExpression ?? "");
      if (condition === "attribute_not_exists(pk)" && existing) {
        throwConditionalFailure();
      }
      if (
        condition ===
          "attribute_not_exists(pk) OR observedThroughBlock < :observedThroughBlock" &&
        existing
      ) {
        const values = parseItem(input.ExpressionAttributeValues);
        if (
          numberField(existing, "observedThroughBlock") >=
          numberField(values, ":observedThroughBlock")
        ) {
          throwConditionalFailure();
        }
      }
      if (condition.includes("lastReserveChangeBlock") && existing) {
        const values = parseItem(input.ExpressionAttributeValues);
        if (
          numberField(existing, "observedThroughBlock") >
          numberField(values, ":observedThroughBlock")
        ) {
          throwConditionalFailure();
        }
        const incoming = eventVersion(item);
        const current = eventVersion(existing);
        if (compareVersions(incoming, current) <= 0) throwConditionalFailure();
      }
      this.items.set(key, item);
      return {};
    }
    if (command.constructor.name === "UpdateCommand") {
      const key = keyFromValue(input.Key);
      const existing = this.items.get(key);
      if (!existing) throwConditionalFailure();
      const values = parseItem(input.ExpressionAttributeValues);
      const observedThroughBlock = numberField(values, ":observedThroughBlock");
      if (
        typeof existing.observedThroughBlock === "number" &&
        existing.observedThroughBlock >= observedThroughBlock
      ) {
        throwConditionalFailure();
      }
      this.items.set(key, {
        ...existing,
        observedThroughBlock,
        sourceRegistryId: stringField(values, ":sourceRegistryId"),
        updatedAt: stringField(values, ":updatedAt"),
      });
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}.`);
  }

  getLatest(pool: FamePoolStateRegistryEntry & { poolAddress: Address }) {
    return this.items.get(
      keyFromValue(latestPoolStateKey(pool.chainId, pool.poolAddress)),
    );
  }

  getCursor(chainId: number) {
    return this.items.get(keyFromValue(cursorKey(chainId)));
  }
}

class FakePoolStateClient implements FamePoolStateIndexerClient {
  public requestedAddresses: Address[] = [];
  public reservesByAddress = new Map<
    string,
    readonly [bigint, bigint, number]
  >();
  public failingReserveAddress: Address | null = null;

  constructor(
    private readonly logs: readonly FamePoolStateSyncLog[],
    private readonly latestBlock: bigint,
  ) {}

  chain = {
    id: 8453,
  };

  async getBlockNumber(): Promise<bigint> {
    return this.latestBlock;
  }

  async getSyncLogs(options: {
    pools: readonly (FamePoolStateRegistryEntry & { poolAddress: Address })[];
  }): Promise<readonly FamePoolStateSyncLog[]> {
    this.requestedAddresses = options.pools.map((pool) => pool.poolAddress);
    return this.logs;
  }

  async getReserves(options: {
    poolAddress: Address;
  }): Promise<readonly [bigint, bigint, number]> {
    if (
      this.failingReserveAddress &&
      options.poolAddress.toLowerCase() ===
        this.failingReserveAddress.toLowerCase()
    ) {
      throw new Error("getReserves failed");
    }
    return (
      this.reservesByAddress.get(options.poolAddress.toLowerCase()) ?? [
        1_000n,
        2_000n,
        0,
      ]
    );
  }
}

function parseItem(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object item.");
  }
  return value as Record<string, unknown>;
}

function keyFromValue(value: unknown): string {
  const key = parseItem(value);
  return `${stringField(key, "pk")}:${stringField(key, "sk")}`;
}

function keyFromItem(item: Record<string, unknown>): string {
  return `${stringField(item, "pk")}:${stringField(item, "sk")}`;
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

function eventVersion(item: Record<string, unknown>) {
  return {
    blockNumber: numberField(item, "lastReserveChangeBlock"),
    transactionIndex: numberField(item, "lastEventTransactionIndex"),
    logIndex: numberField(item, "lastEventLogIndex"),
  };
}

function compareVersions(
  left: ReturnType<typeof eventVersion>,
  right: ReturnType<typeof eventVersion>,
): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber - right.blockNumber;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

function throwConditionalFailure(): never {
  const error = new Error("conditional");
  error.name = "ConditionalCheckFailedException";
  throw error;
}

function registryEntry(id: string): FamePoolStateRegistryEntry {
  const entry = famePoolStateRegistry.pools.find((pool) => pool.id === id);
  if (!entry) throw new Error(`Missing registry entry ${id}.`);
  return entry;
}

function quotePool(
  id: string,
): FamePoolStateRegistryEntry & { poolAddress: Address } {
  const entry = registryEntry(id);
  if (entry.poolAddress === null) {
    throw new Error(`${id} has no pool address.`);
  }
  return {
    ...entry,
    poolAddress: entry.poolAddress,
  };
}

function registryFixture(): FamePoolStateRegistryFile {
  return {
    ...famePoolStateRegistry,
    pools: [
      quotePool("uniswap-v2-fame-direct"),
      quotePool("scale-equalizer-weth-fame"),
      registryEntry("scale-equalizer-usdc-frxusd"),
    ],
  };
}

describe("FAME pool-state indexer", () => {
  test("writes Sync reserves, k, observed-through block, and cursor", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient(
      [
        {
          address: pool.poolAddress,
          blockNumber: 118n,
          transactionIndex: 3,
          logIndex: 5,
          transactionHash:
            "0x0000000000000000000000000000000000000000000000000000000000000005",
          args: {
            reserve0: 10n,
            reserve1: 50n,
          },
        },
      ],
      120n,
    );
    client.reservesByAddress.set(pool.poolAddress.toLowerCase(), [10n, 50n, 0]);

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      durationMs: expect.any(Number),
      fromBlock: 118,
      observedThroughBlock: 118,
      syncEvents: 1,
      writtenEvents: 1,
      seededPools: 1,
      reconciledPools: 0,
    });
    expect(db.getLatest(pool)).toMatchObject({
      reserve0: "10",
      reserve1: "50",
      k: "500",
      lastReserveChangeBlock: 118,
      observedThroughBlock: 118,
      source: "sync-event",
    });
    expect(db.getCursor(8453)).toMatchObject({
      observedThroughBlock: 118,
    });
  });

  test("seeds quiet quote-model pools from getReserves and skips stable tracked-only pools", async () => {
    const uniswapPool = quotePool("uniswap-v2-fame-direct");
    const solidlyPool = quotePool("scale-equalizer-weth-fame");
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:00:00.000Z"),
    });

    expect(result.seededPools).toBe(2);
    expect(client.requestedAddresses).toEqual([
      uniswapPool.poolAddress,
      solidlyPool.poolAddress,
    ]);
    expect(db.getLatest(uniswapPool)).toMatchObject({
      reserve0: "1000",
      reserve1: "2000",
      k: "2000000",
      source: "getReserves",
      observedThroughBlock: 118,
    });
    expect(db.getLatest(solidlyPool)).toMatchObject({
      reserve0: "1000",
      reserve1: "2000",
      k: "2000000",
      source: "getReserves",
      observedThroughBlock: 118,
    });
  });

  test("repairs reserve drift from getReserves before advancing freshness", async () => {
    const uniswapPool = quotePool("uniswap-v2-fame-direct");
    const db = new InMemoryPoolStateDb();

    await indexFamePoolStates({
      client: new FakePoolStateClient([], 120n),
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:00:00.000Z"),
    });

    const client = new FakePoolStateClient([], 121n);
    client.reservesByAddress.set(uniswapPool.poolAddress.toLowerCase(), [
      1_111n,
      2_222n,
      0,
    ]);

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:01:00.000Z"),
    });

    expect(result.reconciledPools).toBe(1);
    expect(result.seededPools).toBe(0);
    expect(db.getLatest(uniswapPool)).toMatchObject({
      reserve0: "1111",
      reserve1: "2222",
      k: "2468642",
      source: "getReserves",
      observedThroughBlock: 119,
    });
    expect(db.getCursor(8453)).toMatchObject({
      observedThroughBlock: 119,
    });
  });

  test("does not advance observed-through state or cursor when reconciliation fails", async () => {
    const uniswapPool = quotePool("uniswap-v2-fame-direct");
    const db = new InMemoryPoolStateDb();

    await indexFamePoolStates({
      client: new FakePoolStateClient([], 120n),
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:00:00.000Z"),
    });

    const client = new FakePoolStateClient([], 121n);
    client.failingReserveAddress = uniswapPool.poolAddress;

    await expect(
      indexFamePoolStates({
        client,
        db,
        tableName: "PoolState",
        registry: registryFixture(),
        now: new Date("2026-05-17T00:01:00.000Z"),
      }),
    ).rejects.toThrow(/getReserves failed/);

    expect(db.getLatest(uniswapPool)).toMatchObject({
      observedThroughBlock: 118,
    });
    expect(db.getCursor(8453)).toMatchObject({
      observedThroughBlock: 118,
    });
  });

  test("does not write Sync rows when later reconciliation reads fail", async () => {
    const uniswapPool = quotePool("uniswap-v2-fame-direct");
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient(
      [
        {
          address: uniswapPool.poolAddress,
          blockNumber: 118n,
          transactionIndex: 0,
          logIndex: 0,
          transactionHash:
            "0x0000000000000000000000000000000000000000000000000000000000000076",
          args: {
            reserve0: 300n,
            reserve1: 400n,
          },
        },
      ],
      120n,
    );
    client.failingReserveAddress = quotePool(
      "scale-equalizer-weth-fame",
    ).poolAddress;

    await expect(
      indexFamePoolStates({
        client,
        db,
        tableName: "PoolState",
        registry: registryFixture(),
        now: new Date("2026-05-17T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/getReserves failed/);

    expect(db.getLatest(uniswapPool)).toBeUndefined();
    expect(db.getCursor(8453)).toBeUndefined();
  });

  test("rewrites quiet rows when registry identity changes", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new InMemoryPoolStateDb();

    await indexFamePoolStates({
      client: new FakePoolStateClient([], 120n),
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:00:00.000Z"),
    });

    const renamedPool = {
      ...pool,
      id: "renamed-uniswap-v2-fame-direct",
    };
    const renamedRegistry: FamePoolStateRegistryFile = {
      ...famePoolStateRegistry,
      source: {
        ...famePoolStateRegistry.source,
        poolsJsonHash:
          "0x1000000000000000000000000000000000000000000000000000000000000000",
      },
      pools: [renamedPool],
    };

    await indexFamePoolStates({
      client: new FakePoolStateClient([], 121n),
      db,
      tableName: "PoolState",
      registry: renamedRegistry,
      now: new Date("2026-05-17T00:01:00.000Z"),
    });

    expect(db.getLatest(pool)).toMatchObject({
      poolId: renamedPool.id,
      source: "getReserves",
      observedThroughBlock: 119,
    });
  });

  test("rejects unknown Sync logs before advancing the cursor", async () => {
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient(
      [
        {
          address: "0x0000000000000000000000000000000000000bad",
          blockNumber: 118n,
          transactionIndex: 0,
          logIndex: 0,
          transactionHash:
            "0x0000000000000000000000000000000000000000000000000000000000000006",
          args: {
            reserve0: 10n,
            reserve1: 50n,
          },
        },
      ],
      120n,
    );

    await expect(
      indexFamePoolStates({
        client,
        db,
        tableName: "PoolState",
        registry: registryFixture(),
        now: new Date("2026-05-17T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/unregistered pool/);
    expect(db.getCursor(8453)).toBeUndefined();
  });

  test("does not rewind the cursor when an older overlapping run finishes later", async () => {
    const db = new InMemoryPoolStateDb();

    await indexFamePoolStates({
      client: new FakePoolStateClient([], 130n),
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:00:00.000Z"),
    });
    expect(db.getCursor(8453)).toMatchObject({
      observedThroughBlock: 128,
    });

    await indexFamePoolStates({
      client: new FakePoolStateClient([], 120n),
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:01:00.000Z"),
    });
    expect(db.getCursor(8453)).toMatchObject({
      observedThroughBlock: 128,
    });
  });

  test("does not lower latest-state freshness when an older run finds a newer event", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new InMemoryPoolStateDb();
    const firstClient = new FakePoolStateClient(
      [
        {
          address: pool.poolAddress,
          blockNumber: 100n,
          transactionIndex: 0,
          logIndex: 0,
          transactionHash:
            "0x0000000000000000000000000000000000000000000000000000000000000064",
          args: {
            reserve0: 100n,
            reserve1: 200n,
          },
        },
      ],
      130n,
    );
    firstClient.reservesByAddress.set(pool.poolAddress.toLowerCase(), [
      100n,
      200n,
      0,
    ]);

    await indexFamePoolStates({
      client: firstClient,
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:00:00.000Z"),
    });
    expect(db.getLatest(pool)).toMatchObject({
      lastReserveChangeBlock: 100,
      observedThroughBlock: 128,
    });

    const result = await indexFamePoolStates({
      client: new FakePoolStateClient(
        [
          {
            address: pool.poolAddress,
            blockNumber: 118n,
            transactionIndex: 0,
            logIndex: 0,
            transactionHash:
              "0x0000000000000000000000000000000000000000000000000000000000000076",
            args: {
              reserve0: 300n,
              reserve1: 400n,
            },
          },
        ],
        120n,
      ),
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-17T00:01:00.000Z"),
    });

    expect(result.ignoredEvents).toBe(1);
    expect(db.getLatest(pool)).toMatchObject({
      reserve0: "100",
      reserve1: "200",
      lastReserveChangeBlock: 100,
      observedThroughBlock: 128,
    });
    expect(db.getCursor(8453)).toMatchObject({
      observedThroughBlock: 128,
    });
  });
});
