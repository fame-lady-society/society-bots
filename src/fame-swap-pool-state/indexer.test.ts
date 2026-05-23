import { describe, expect, test } from "@jest/globals";
import { decodeFunctionResult, encodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";
import {
  assertNoClReplaySnapshotFailures,
  FameClReplaySnapshotIndexingError,
  getSlipstreamClReplaySnapshot,
  indexFamePoolStates,
  SlipstreamTicksAbi,
  type FameClHeadSnapshotRead,
  type FameClReplaySnapshotRead,
  type FamePoolStateIndexerClient,
  type FamePoolStateSyncLog,
  type SlipstreamReplayReadClient,
} from "./indexer.ts";
import {
  cursorKey,
  latestClHeadStateKey,
  latestClReplayStateKey,
  latestPoolStateKey,
  type FameClHeadSnapshotRegistryEntry,
  type FameClReplayRegistryEntry,
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
          .filter(
            (item): item is Record<string, unknown> => item !== undefined,
          );
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
      if (
        condition ===
          "attribute_not_exists(pk) OR observedThroughBlock < :observedThroughBlock OR (observedThroughBlock = :observedThroughBlock AND sourceRegistryId = :sourceRegistryId)" &&
        existing
      ) {
        const values = parseItem(input.ExpressionAttributeValues);
        const currentBlock = numberField(existing, "observedThroughBlock");
        const incomingBlock = numberField(values, ":observedThroughBlock");
        const currentSourceRegistryId = stringField(
          existing,
          "sourceRegistryId",
        );
        const incomingSourceRegistryId = stringField(
          values,
          ":sourceRegistryId",
        );
        if (
          currentBlock > incomingBlock ||
          (currentBlock === incomingBlock &&
            currentSourceRegistryId !== incomingSourceRegistryId)
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

  getLatestClHead(pool: FameClHeadSnapshotRegistryEntry) {
    return this.items.get(keyFromValue(latestClHeadStateKey(pool)));
  }

  getLatestClReplay(pool: FameClReplayRegistryEntry) {
    return this.items.get(keyFromValue(latestClReplayStateKey(pool)));
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
  public clHeadSnapshotsByPoolId = new Map<string, FameClHeadSnapshotRead>();
  public clReplaySnapshotsByPoolId = new Map<
    string,
    FameClReplaySnapshotRead
  >();
  public failingReserveAddress: Address | null = null;
  public failingClHeadPoolId: string | null = null;
  public failingClReplayPoolId: string | null = null;

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

  async getClHeadSnapshot(options: {
    pool: FameClHeadSnapshotRegistryEntry;
  }): Promise<FameClHeadSnapshotRead> {
    if (options.pool.id === this.failingClHeadPoolId) {
      throw new Error("CL head read failed");
    }
    return (
      this.clHeadSnapshotsByPoolId.get(options.pool.id) ?? {
        sqrtPriceX96: 2n ** 96n,
        tick: 0,
        liquidity: 1_000n,
        source:
          options.pool.venue === "uniswap-v4"
            ? "v4-state-view"
            : "pool-slot0-liquidity",
      }
    );
  }

  async getClReplaySnapshot(options: {
    pool: FameClReplayRegistryEntry;
  }): Promise<FameClReplaySnapshotRead> {
    if (options.pool.id === this.failingClReplayPoolId) {
      throw new Error("CL replay read failed");
    }
    return (
      this.clReplaySnapshotsByPoolId.get(options.pool.id) ?? {
        sqrtPriceX96: 2n ** 96n,
        tick: 199_900,
        liquidity: 1_000n,
        fee: 100n,
        blockHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        parentHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        bitmapWords: [{ wordPosition: 7, bitmap: 1n }],
        initializedTicks: [
          { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
        ],
        providerReadCount: 5,
        durationMs: 12,
      }
    );
  }
}

class FakeSlipstreamReplayReadClient implements SlipstreamReplayReadClient {
  public readonly blockNumbers: bigint[] = [];
  public readonly tickBitmapWordPositions: number[] = [];
  public readonly tickIndexes: number[] = [];
  public blockHash: Hex =
    "0x1111111111111111111111111111111111111111111111111111111111111111";
  public parentHash: Hex =
    "0x2222222222222222222222222222222222222222222222222222222222222222";
  public readonly bitmaps = new Map<number, bigint>([
    [-1, 1n << 255n],
    [0, 1n << 2n],
  ]);
  public readonly tickStates = new Map<
    number,
    { liquidityGross: bigint; liquidityNet: bigint; initialized: boolean }
  >([
    [-100, { liquidityGross: 25n, liquidityNet: -10n, initialized: true }],
    [200, { liquidityGross: 50n, liquidityNet: 15n, initialized: true }],
  ]);

  async getBlock(options: {
    blockNumber: bigint;
  }): Promise<{ hash: Hex | null; parentHash: Hex }> {
    this.blockNumbers.push(options.blockNumber);
    return {
      hash: this.blockHash,
      parentHash: this.parentHash,
    };
  }

  async getSlot0(options: {
    blockNumber: bigint;
  }): Promise<readonly [bigint, number, number, number, number, boolean]> {
    this.blockNumbers.push(options.blockNumber);
    return [2n ** 96n, 100, 0, 0, 0, true] as const;
  }

  async getLiquidity(options: { blockNumber: bigint }): Promise<bigint> {
    this.blockNumbers.push(options.blockNumber);
    return 1_000n;
  }

  async getFee(options: { blockNumber: bigint }): Promise<bigint> {
    this.blockNumbers.push(options.blockNumber);
    return 100n;
  }

  async getTickBitmap(options: {
    wordPosition: number;
    blockNumber: bigint;
  }): Promise<bigint> {
    this.blockNumbers.push(options.blockNumber);
    this.tickBitmapWordPositions.push(options.wordPosition);
    return this.bitmaps.get(options.wordPosition) ?? 0n;
  }

  async getTick(options: {
    tick: number;
    blockNumber: bigint;
  }): Promise<
    readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      number,
      boolean,
    ]
  > {
    this.blockNumbers.push(options.blockNumber);
    this.tickIndexes.push(options.tick);
    const state = this.tickStates.get(options.tick);
    if (!state)
      throw new Error(`Missing fake tick ${options.tick.toString()}.`);
    return [
      state.liquidityGross,
      state.liquidityNet,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0,
      state.initialized,
    ] as const;
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

function clHeadPool(id: string): FameClHeadSnapshotRegistryEntry {
  const entry = registryEntry(id);
  if (entry.stateSurface !== "cl-head-snapshot" || entry.tickSpacing === null) {
    throw new Error(`${id} is not CL head-snapshot eligible.`);
  }
  return {
    ...entry,
    stateSurface: entry.stateSurface,
    tickSpacing: entry.tickSpacing,
  };
}

function clReplayPool(): FameClReplayRegistryEntry {
  const entry = registryEntry("slipstream-usdc-weth-100");
  if (
    entry.replaySurface !== "cl-replay-v1" ||
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.poolAddress === null ||
    entry.tickSpacing === null ||
    entry.venue !== "aerodrome-slipstream"
  ) {
    throw new Error("slipstream-usdc-weth-100 is not CL replay eligible.");
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

function registryFixture(): FamePoolStateRegistryFile {
  return {
    ...famePoolStateRegistry,
    pools: [
      quotePool("uniswap-v2-fame-direct"),
      quotePool("scale-equalizer-weth-fame"),
      clHeadPool("uniswap-v3-usdc-weth-5bps"),
      registryEntry("scale-equalizer-usdc-frxusd"),
    ],
  };
}

function registryWithPools(
  pools: readonly FamePoolStateRegistryEntry[],
  poolsJsonHash: Hex = famePoolStateRegistry.source.poolsJsonHash,
): FamePoolStateRegistryFile {
  return {
    ...famePoolStateRegistry,
    source: {
      ...famePoolStateRegistry.source,
      poolsJsonHash,
    },
    pools: [...pools],
  };
}

describe("FAME pool-state indexer", () => {
  test("decodes Aerodrome Slipstream tick state with staked and reward fields", () => {
    const result = decodeFunctionResult({
      abi: SlipstreamTicksAbi,
      functionName: "ticks",
      data: encodeAbiParameters(SlipstreamTicksAbi[0].outputs, [
        25n,
        15n,
        0n,
        101n,
        202n,
        303n,
        -404n,
        1_234_567n,
        88,
        true,
      ]),
    });

    expect(result[0]).toBe(25n);
    expect(result[1]).toBe(15n);
    expect(result[9]).toBe(true);
  });

  test("builds Slipstream replay snapshots from bitmap and tick reads at one block", async () => {
    const pool = clReplayPool();
    const client = new FakeSlipstreamReplayReadClient();

    const snapshot = await getSlipstreamClReplaySnapshot({
      client,
      pool,
      blockNumber: 118n,
    });

    expect(snapshot).toMatchObject({
      sqrtPriceX96: 2n ** 96n,
      tick: 100,
      liquidity: 1_000n,
      fee: 100n,
      blockHash: client.blockHash,
      parentHash: client.parentHash,
      bitmapWords: [
        { wordPosition: -1, bitmap: 1n << 255n },
        { wordPosition: 0, bitmap: 1n << 2n },
      ],
      initializedTicks: [
        { tick: -100, liquidityGross: 25n, liquidityNet: -10n },
        { tick: 200, liquidityGross: 50n, liquidityNet: 15n },
      ],
      providerReadCount: 77,
    });
    expect(client.tickBitmapWordPositions).toHaveLength(70);
    expect(client.tickBitmapWordPositions[0]).toBe(-35);
    expect(client.tickBitmapWordPositions.at(-1)).toBe(34);
    expect(client.tickIndexes).toEqual([-100, 200]);
    expect(
      client.blockNumbers.every((blockNumber) => blockNumber === 118n),
    ).toBe(true);
  });

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

  test("writes complete CL head snapshots at the safe block", async () => {
    const clPool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.clHeadSnapshotsByPoolId.set(clPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: -12,
      liquidity: 9_999n,
      source: "pool-slot0-liquidity",
    });

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryFixture(),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      clHeadSnapshots: 1,
      clHeadWrittenPools: 1,
      observedThroughBlock: 118,
    });
    expect(db.getLatestClHead(clPool)).toMatchObject({
      stateKind: "cl-head-snapshot",
      poolId: clPool.id,
      sqrtPriceX96: (2n ** 96n).toString(),
      tick: -12,
      liquidity: "9999",
      observedThroughBlock: 118,
      source: "pool-slot0-liquidity",
    });
  });

  test("writes complete CL replay snapshots for the one replay-capable pool", async () => {
    const replayPool = clReplayPool();
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 9_999n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [
        { wordPosition: 7, bitmap: 1n },
        { wordPosition: 8, bitmap: 2n },
      ],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
        { tick: 200_000, liquidityGross: 50n, liquidityNet: -15n },
      ],
      providerReadCount: 75,
      durationMs: 42,
    });

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      clReplaySnapshots: 1,
      clReplayWrittenPools: 1,
      clReplayFailedPools: 0,
      clReplayMetrics: [
        {
          poolId: replayPool.id,
          bitmapWordCount: 2,
          initializedTickCount: 2,
          bitmapChunkCount: 1,
          tickChunkCount: 1,
          providerReadCount: 75,
          durationMs: 42,
          stateHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        },
      ],
    });
    expect(db.getLatestClReplay(replayPool)).toMatchObject({
      stateKind: "cl-replay-v1",
      poolId: replayPool.id,
      tick: 199_900,
      liquidity: "9999",
      fee: "100",
      observedThroughBlock: 118,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      bitmapWordCount: 2,
      initializedTickCount: 2,
      minTick: 199_900,
      maxTick: 200_000,
    });
    expect(
      stringField(parseItem(db.getLatestClReplay(replayPool)), "snapshotId"),
    ).toContain(result.sourceRegistryId);
  });

  test("records CL replay failures without blocking CL head snapshots", async () => {
    const replayPool = clReplayPool();
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.failingClReplayPoolId = replayPool.id;
    client.clHeadSnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 123n,
      tick: 5,
      liquidity: 456n,
      source: "pool-slot0-liquidity",
    });

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      clHeadSnapshots: 1,
      clHeadWrittenPools: 1,
      clReplaySnapshots: 0,
      clReplayWrittenPools: 0,
      clReplayFailedPools: 1,
      clReplayFailures: [
        {
          poolId: replayPool.id,
          message: "CL replay read failed",
        },
      ],
    });
    expect(db.getLatestClHead(replayPool)).toMatchObject({
      tick: 5,
      liquidity: "456",
    });
    expect(db.getLatestClReplay(replayPool)).toBeUndefined();
  });

  test("throws an operational error when required CL replay snapshots fail", () => {
    expect(() =>
      assertNoClReplaySnapshotFailures({
        clReplayFailedPools: 1,
        clReplayFailures: [
          {
            poolId: "slipstream-usdc-weth-100",
            message: "CL replay read failed",
          },
        ],
      }),
    ).toThrow(FameClReplaySnapshotIndexingError);
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

  test("records failed CL head reads while writing successful snapshots", async () => {
    const quoteModelPool = quotePool("uniswap-v2-fame-direct");
    const failedClPool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const writtenClPool = clHeadPool("uniswap-v4-usdc-eth");
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.failingClHeadPoolId = failedClPool.id;
    client.clHeadSnapshotsByPoolId.set(writtenClPool.id, {
      sqrtPriceX96: 123n,
      tick: 5,
      liquidity: 456n,
      source: "v4-state-view",
    });

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([
        quoteModelPool,
        failedClPool,
        writtenClPool,
      ]),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      clHeadSnapshots: 1,
      clHeadWrittenPools: 1,
      clHeadFailedPools: 1,
      clHeadFailures: [
        {
          poolId: failedClPool.id,
          message: "CL head read failed",
        },
      ],
    });
    expect(db.getLatest(quoteModelPool)).toMatchObject({
      observedThroughBlock: 118,
    });
    expect(db.getCursor(8453)).toMatchObject({
      observedThroughBlock: 118,
    });
    expect(db.getLatestClHead(failedClPool)).toBeUndefined();
    expect(db.getLatestClHead(writtenClPool)).toMatchObject({
      tick: 5,
      liquidity: "456",
      source: "v4-state-view",
    });
  });

  test("does not overwrite same-block CL head state from a different registry source", async () => {
    const clPool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const db = new InMemoryPoolStateDb();
    const newerClient = new FakePoolStateClient([], 120n);
    newerClient.clHeadSnapshotsByPoolId.set(clPool.id, {
      sqrtPriceX96: 111n,
      tick: 1,
      liquidity: 222n,
      source: "pool-slot0-liquidity",
    });

    await indexFamePoolStates({
      client: newerClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools(
        [clPool],
        "0x2000000000000000000000000000000000000000000000000000000000000000",
      ),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const firstState = db.getLatestClHead(clPool);
    expect(firstState).toMatchObject({
      tick: 1,
      liquidity: "222",
    });
    const firstSourceRegistryId = stringField(
      parseItem(firstState),
      "sourceRegistryId",
    );

    const staleClient = new FakePoolStateClient([], 120n);
    staleClient.clHeadSnapshotsByPoolId.set(clPool.id, {
      sqrtPriceX96: 333n,
      tick: 9,
      liquidity: 444n,
      source: "pool-slot0-liquidity",
    });

    const result = await indexFamePoolStates({
      client: staleClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools(
        [clPool],
        "0x1000000000000000000000000000000000000000000000000000000000000000",
      ),
      now: new Date("2026-05-19T00:01:00.000Z"),
    });

    expect(result.clHeadWrittenPools).toBe(0);
    expect(db.getLatestClHead(clPool)).toMatchObject({
      sourceRegistryId: firstSourceRegistryId,
      tick: 1,
      liquidity: "222",
    });
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
