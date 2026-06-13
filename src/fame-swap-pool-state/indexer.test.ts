import { describe, expect, test } from "@jest/globals";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeEventTopics,
  isHex,
} from "viem";
import type { Address, Hex } from "viem";
import {
  assertNoClReplaySnapshotFailures,
  ClReplayBurnEventAbi,
  ClReplayCollectEventAbi,
  ClReplayMintEventAbi,
  ClReplaySwapEventAbi,
  V4ClReplayModifyLiquidityEventAbi,
  V4ClReplaySwapEventAbi,
  applyClReplayDeltas,
  applyV4ClReplayDeltas,
  FameClReplayLogNormalizationError,
  FameClReplaySnapshotIndexingError,
  getSlipstreamClReplaySnapshot,
  getUniswapV4ClReplaySnapshot,
  indexFamePoolStates,
  normalizeClReplayLogs,
  normalizeV4ClReplayLogs,
  SlipstreamTicksAbi,
  type FameClReplayRawLog,
  type FameClHeadSnapshotRead,
  type FameClReplaySnapshotRead,
  type FameV4ClReplaySnapshotRead,
  type FamePoolStateIndexerClient,
  type FamePoolStateSyncLog,
  type FameV4ClReplayRawLog,
  type SlipstreamReplayReadClient,
  type UniswapV4ReplayReadClient,
} from "./indexer.ts";
import {
  clReplayStateRowsFromSnapshot,
  cursorKey,
  latestClHeadStateKey,
  latestClReplayCandidateStateKey,
  latestClReplayMaintenanceStateKey,
  latestClReplayStateKey,
  latestV4ClReplayCandidateStateKey,
  latestV4ClReplayMaintenanceStateKey,
  latestV4ClReplayStateKey,
  latestPoolStateKey,
  putLatestClReplayMaintenanceState,
  putLatestClReplayState,
  sourceRegistryIdFor,
  v4ClReplayStateRowsFromSnapshot,
  type FameClHeadSnapshotRegistryEntry,
  type FameClReplayRegistryEntry,
  type FameV4ClReplayRegistryEntry,
  type FameV4ReviewedPoolEvidence,
  type FameV4ZoraVerifiedProvenance,
  type PoolStateDocumentClient,
  type PoolStateDynamoResponse,
} from "./dynamodb/pool-state.ts";
import {
  FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
  type FameClReplayReducerRegistryEntry,
} from "./cl-reducer-manifests.ts";
import {
  FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
  fameV4ZoraQuoteLaneManifestForPool,
} from "./v4-zora-manifests.ts";
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

  getLatestV4ClReplay(pool: FameV4ClReplayRegistryEntry) {
    return this.items.get(keyFromValue(latestV4ClReplayStateKey(pool)));
  }

  getLatestV4ClReplayCandidate(pool: FameV4ClReplayRegistryEntry) {
    return this.items.get(
      keyFromValue(latestV4ClReplayCandidateStateKey(pool)),
    );
  }

  getLatestV4ClReplayMaintenance(pool: FameV4ClReplayRegistryEntry) {
    return this.items.get(
      keyFromValue(latestV4ClReplayMaintenanceStateKey(pool)),
    );
  }

  getLatestClReplayCandidate(pool: FameClReplayRegistryEntry) {
    return this.items.get(keyFromValue(latestClReplayCandidateStateKey(pool)));
  }

  getLatestClReplayMaintenance(pool: FameClReplayRegistryEntry) {
    return this.items.get(
      keyFromValue(latestClReplayMaintenanceStateKey(pool)),
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
  public clHeadSnapshotsByPoolId = new Map<string, FameClHeadSnapshotRead>();
  public clReplaySnapshotsByPoolId = new Map<
    string,
    FameClReplaySnapshotRead
  >();
  public v4ClReplaySnapshotsByPoolId = new Map<
    string,
    FameV4ClReplaySnapshotRead
  >();
  public v4ClReplayLogs: readonly FameV4ClReplayRawLog[] = [];
  public v4ClReplaySnapshotReadCount = 0;
  public clReplayFeesByPoolId = new Map<string, bigint>();
  public clReplayLogs: readonly FameClReplayRawLog[] = [];
  public blockIdentitiesByNumber = new Map<
    number,
    { hash: Hex | null; parentHash: Hex }
  >();
  public failingReserveAddress: Address | null = null;
  public failingClHeadPoolId: string | null = null;
  public failingClReplayPoolId: string | null = null;
  public failingV4ClReplayPoolId: string | null = null;
  public failingClHeadError: unknown = new Error("CL head read failed");
  public failingClReplayError: unknown = new Error("CL replay read failed");
  public failingV4ClReplayError: unknown = new Error(
    "V4 CL replay read failed",
  );

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

  async getBlock(options?: {
    blockNumber: bigint;
  }): Promise<{ hash: Hex | null; parentHash: Hex }> {
    return (
      this.blockIdentitiesByNumber.get(
        options ? Number(options.blockNumber) : Number(this.latestBlock),
      ) ?? {
        hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
        parentHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
      }
    );
  }

  async getSyncLogs(options: {
    pools: readonly (FamePoolStateRegistryEntry & { poolAddress: Address })[];
  }): Promise<readonly FamePoolStateSyncLog[]> {
    this.requestedAddresses = options.pools.map((pool) => pool.poolAddress);
    return this.logs;
  }

  async getClReplayLogs(): Promise<readonly FameClReplayRawLog[]> {
    return this.clReplayLogs;
  }

  async getV4ClReplayLogs(): Promise<readonly FameV4ClReplayRawLog[]> {
    return this.v4ClReplayLogs;
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
      throw this.failingClHeadError;
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
      throw this.failingClReplayError;
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

  async getV4ClReplaySnapshot(options: {
    pool: FameV4ClReplayRegistryEntry;
  }): Promise<FameV4ClReplaySnapshotRead> {
    this.v4ClReplaySnapshotReadCount += 1;
    if (options.pool.id === this.failingV4ClReplayPoolId) {
      throw this.failingV4ClReplayError;
    }
    return (
      this.v4ClReplaySnapshotsByPoolId.get(options.pool.id) ?? {
        sqrtPriceX96: 2n ** 96n,
        tick: -17_400,
        liquidity: 1_000n,
        lpFee: 30_000n,
        protocolFee: 0n,
        blockHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        parentHash:
          "0x2222222222222222222222222222222222222222222222222222222222222222",
        bitmapWords: [{ wordPosition: 0, bitmap: 1n << 3n }],
        initializedTicks: [
          { tick: -17_400, liquidityGross: 30n, liquidityNet: 10n },
        ],
        providerReadCount: 6,
        durationMs: 13,
      }
    );
  }

  async getClReplayFee(options: {
    pool: FameClReplayRegistryEntry;
  }): Promise<bigint> {
    return (
      this.clReplayFeesByPoolId.get(options.pool.id) ??
      this.clReplaySnapshotsByPoolId.get(options.pool.id)?.fee ??
      100n
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

class FakeUniswapV4ReplayReadClient implements UniswapV4ReplayReadClient {
  public readonly blockNumbers: bigint[] = [];
  public readonly stateViewAddresses: Address[] = [];
  public readonly poolKeys: Hex[] = [];
  public readonly tickBitmapWordPositions: number[] = [];
  public readonly tickIndexes: number[] = [];
  public blockHash: Hex =
    "0x3333333333333333333333333333333333333333333333333333333333333333";
  public parentHash: Hex =
    "0x4444444444444444444444444444444444444444444444444444444444444444";
  public readonly bitmaps = new Map<number, bigint>([
    [-1, (1n << 168n) | (1n << 169n)],
  ]);
  public readonly tickStates = new Map<
    number,
    { liquidityGross: bigint; liquidityNet: bigint }
  >([
    [-17_600, { liquidityGross: 20n, liquidityNet: -20n }],
    [-17_400, { liquidityGross: 30n, liquidityNet: 10n }],
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
    stateViewAddress: Address;
    poolKey: Hex;
    blockNumber: bigint;
  }): Promise<readonly [bigint, number, number, number]> {
    this.stateViewAddresses.push(options.stateViewAddress);
    this.poolKeys.push(options.poolKey);
    this.blockNumbers.push(options.blockNumber);
    return [2n ** 96n, -17_400, 0, 30_000] as const;
  }

  async getLiquidity(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    blockNumber: bigint;
  }): Promise<bigint> {
    this.stateViewAddresses.push(options.stateViewAddress);
    this.poolKeys.push(options.poolKey);
    this.blockNumbers.push(options.blockNumber);
    return 1_000n;
  }

  async getTickBitmap(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    wordPosition: number;
    blockNumber: bigint;
  }): Promise<bigint> {
    this.stateViewAddresses.push(options.stateViewAddress);
    this.poolKeys.push(options.poolKey);
    this.blockNumbers.push(options.blockNumber);
    this.tickBitmapWordPositions.push(options.wordPosition);
    return this.bitmaps.get(options.wordPosition) ?? 0n;
  }

  async getTickInfo(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    tick: number;
    blockNumber: bigint;
  }): Promise<readonly [bigint, bigint, bigint, bigint]> {
    this.stateViewAddresses.push(options.stateViewAddress);
    this.poolKeys.push(options.poolKey);
    this.blockNumbers.push(options.blockNumber);
    this.tickIndexes.push(options.tick);
    const state = this.tickStates.get(options.tick);
    if (!state) {
      throw new Error(`Missing fake V4 tick ${options.tick.toString()}.`);
    }
    return [state.liquidityGross, state.liquidityNet, 0n, 0n] as const;
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
  if (entry.tickSpacing === null) {
    throw new Error(`${id} is not CL head-snapshot eligible.`);
  }
  return {
    ...entry,
    capability: "market-state",
    activationStatus:
      entry.activationStatus === "tracked-only"
        ? "cl-head-only"
        : entry.activationStatus,
    stateSurface: "cl-head-snapshot",
    tickSpacing: entry.tickSpacing,
    unsupportedReason: null,
  };
}

function clReplayPool(): FameClReplayReducerRegistryEntry {
  const entry = registryEntry("slipstream-usdc-weth-100");
  if (
    entry.poolAddress === null ||
    entry.factoryAddress === null ||
    entry.tickSpacing === null ||
    entry.venue !== "aerodrome-slipstream"
  ) {
    throw new Error("slipstream-usdc-weth-100 is not CL replay eligible.");
  }
  return {
    ...entry,
    capability: "market-state",
    activationStatus: "cl-compact-quote-active",
    replaySurface: "cl-replay-v1",
    stateSurface: "cl-head-snapshot",
    poolAddress: entry.poolAddress,
    factoryAddress: entry.factoryAddress,
    tickSpacing: entry.tickSpacing,
    venue: entry.venue,
    unsupportedReason: null,
  };
}

function clReplayCandidatePool(): FameClReplayReducerRegistryEntry {
  const entry = registryEntry(FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID);
  if (
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.poolAddress === null ||
    entry.factoryAddress === null ||
    entry.tickSpacing === null ||
    entry.venue !== "aerodrome-slipstream"
  ) {
    throw new Error(
      "slipstream-basedflick-fame is not CL replay candidate eligible.",
    );
  }
  return {
    ...entry,
    capability: "market-state",
    activationStatus: "cl-replay-candidate",
    replaySurface: null,
    stateSurface: entry.stateSurface,
    poolAddress: entry.poolAddress,
    factoryAddress: entry.factoryAddress,
    tickSpacing: entry.tickSpacing,
    venue: entry.venue,
    unsupportedReason: null,
  };
}

function clReplayPromotedCandidatePool(): FameClReplayReducerRegistryEntry {
  const candidate = clReplayCandidatePool();
  return {
    ...candidate,
    activationStatus: "cl-compact-quote-active",
    replaySurface: "cl-replay-v1",
  };
}

function v4ClReplayPool(
  poolId = "uniswap-v4-basedflick-zora",
): FameV4ClReplayRegistryEntry {
  const entry = registryEntry(poolId);
  if (
    entry.venue !== "uniswap-v4" ||
    entry.venueFamily !== "UniswapV4" ||
    entry.poolAddress !== null ||
    entry.poolKey === null ||
    entry.stateViewAddress === null ||
    entry.tickSpacing === null
  ) {
    throw new Error(`${poolId} is not V4 replay eligible.`);
  }
  return {
    ...entry,
    capability: "market-state",
    activationStatus: "unsupported",
    venue: entry.venue,
    venueFamily: entry.venueFamily,
    stateSurface: "cl-head-snapshot",
    poolAddress: entry.poolAddress,
    poolKey: entry.poolKey,
    stateViewAddress: entry.stateViewAddress,
    tickSpacing: entry.tickSpacing,
    unsupportedReason: null,
  };
}

function verifiedV4ZoraProvenance(
  pool: FameV4ClReplayRegistryEntry,
): FameV4ZoraVerifiedProvenance {
  return {
    status: "verified",
    source: "zora-factory-event",
    chainId: 8453,
    factoryAddress: "0x0000000000000000000000000000000000000003",
    coinAddress: pool.token1,
    poolKey: pool.poolKey,
    poolId: pool.poolKey,
    transactionHash:
      "0x7777777777777777777777777777777777777777777777777777777777777777",
    eventName: "CoinCreatedV4",
  };
}

function reviewedV4PoolEvidence(
  pool: FameV4ClReplayRegistryEntry,
): FameV4ReviewedPoolEvidence {
  const manifest = fameV4ZoraQuoteLaneManifestForPool(pool.id);
  if (manifest === null) {
    throw new Error(`Missing reviewed V4 manifest for ${pool.id}.`);
  }
  const shape = manifest.reviewedPoolShape;
  return {
    status: "verified",
    source: "reviewed-v4-manifest",
    kind: manifest.provenanceRequired
      ? "zora-protocol-pool"
      : "zero-hook-static-fee",
    manifestVersion: manifest.version,
    poolId: manifest.poolId,
    poolKey: shape.poolKey,
    staticFee: shape.fee.toString(),
    hookAddress: shape.hooks,
    hookData: shape.hookData,
    protocolFeeStatus: "zero",
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

const UNIT_ADDRESS_1 = "0x0000000000000000000000000000000000000001";
const UNIT_ADDRESS_2 = "0x0000000000000000000000000000000000000002";

function strictTopics(topics: ReturnType<typeof encodeEventTopics>): Hex[] {
  if (!Array.isArray(topics)) {
    throw new Error("Encoded event topics must be an array.");
  }
  return topics.map((topic) => {
    if (typeof topic !== "string" || !isHex(topic)) {
      throw new Error("Encoded event topic must be hex.");
    }
    return topic;
  });
}

function replayLogFixture(
  pool: FameClReplayRegistryEntry,
  options: {
    blockNumber: bigint;
    transactionIndex: number;
    logIndex: number;
    topics: readonly Hex[];
    data: Hex;
    address?: Address;
    blockHash?: Hex | null;
    removed?: boolean;
  },
): FameClReplayRawLog {
  return {
    address: options.address ?? pool.poolAddress,
    blockNumber: options.blockNumber,
    blockHash:
      options.blockHash ??
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    transactionHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    transactionIndex: options.transactionIndex,
    logIndex: options.logIndex,
    removed: options.removed ?? false,
    topics: options.topics,
    data: options.data,
  };
}

function swapReplayLog(
  pool: FameClReplayRegistryEntry,
  order: { blockNumber: bigint; transactionIndex: number; logIndex: number },
): FameClReplayRawLog {
  return replayLogFixture(pool, {
    ...order,
    topics: strictTopics(
      encodeEventTopics({
        abi: [ClReplaySwapEventAbi],
        eventName: "Swap",
        args: {
          sender: UNIT_ADDRESS_1,
          recipient: UNIT_ADDRESS_2,
        },
      }),
    ),
    data: encodeAbiParameters(
      [
        { name: "amount0", type: "int256" },
        { name: "amount1", type: "int256" },
        { name: "sqrtPriceX96", type: "uint160" },
        { name: "liquidity", type: "uint128" },
        { name: "tick", type: "int24" },
      ],
      [-10n, 20n, 2n ** 96n, 1_234n, 101],
    ),
  });
}

function mintReplayLog(
  pool: FameClReplayRegistryEntry,
  order: { blockNumber: bigint; transactionIndex: number; logIndex: number },
): FameClReplayRawLog {
  return replayLogFixture(pool, {
    ...order,
    topics: strictTopics(
      encodeEventTopics({
        abi: [ClReplayMintEventAbi],
        eventName: "Mint",
        args: {
          owner: UNIT_ADDRESS_2,
          tickLower: -200,
          tickUpper: 300,
        },
      }),
    ),
    data: encodeAbiParameters(
      [
        { name: "sender", type: "address" },
        { name: "amount", type: "uint128" },
        { name: "amount0", type: "uint256" },
        { name: "amount1", type: "uint256" },
      ],
      [UNIT_ADDRESS_1, 50n, 60n, 70n],
    ),
  });
}

function burnReplayLog(
  pool: FameClReplayRegistryEntry,
  order: { blockNumber: bigint; transactionIndex: number; logIndex: number },
): FameClReplayRawLog {
  return replayLogFixture(pool, {
    ...order,
    topics: strictTopics(
      encodeEventTopics({
        abi: [ClReplayBurnEventAbi],
        eventName: "Burn",
        args: {
          owner: UNIT_ADDRESS_2,
          tickLower: -200,
          tickUpper: 300,
        },
      }),
    ),
    data: encodeAbiParameters(
      [
        { name: "amount", type: "uint128" },
        { name: "amount0", type: "uint256" },
        { name: "amount1", type: "uint256" },
      ],
      [25n, 30n, 35n],
    ),
  });
}

function collectReplayLog(
  pool: FameClReplayRegistryEntry,
  order: { blockNumber: bigint; transactionIndex: number; logIndex: number },
): FameClReplayRawLog {
  return replayLogFixture(pool, {
    ...order,
    topics: strictTopics(
      encodeEventTopics({
        abi: [ClReplayCollectEventAbi],
        eventName: "Collect",
        args: {
          owner: UNIT_ADDRESS_1,
          tickLower: -200,
          tickUpper: 300,
        },
      }),
    ),
    data: encodeAbiParameters(
      [
        { name: "recipient", type: "address" },
        { name: "amount0", type: "uint128" },
        { name: "amount1", type: "uint128" },
      ],
      [UNIT_ADDRESS_2, 10n, 20n],
    ),
  });
}

function v4ReplayLogFixture(
  pool: FameV4ClReplayRegistryEntry,
  options: {
    blockNumber: bigint;
    transactionIndex: number;
    logIndex: number;
    topics: readonly Hex[];
    data: Hex;
    address?: Address;
    blockHash?: Hex | null;
    removed?: boolean;
  },
): FameV4ClReplayRawLog {
  return {
    address: options.address ?? FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolManager,
    blockNumber: options.blockNumber,
    blockHash:
      options.blockHash ??
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    transactionHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    transactionIndex: options.transactionIndex,
    logIndex: options.logIndex,
    removed: options.removed ?? false,
    topics: options.topics,
    data: options.data,
  };
}

function swapV4ReplayLog(
  pool: FameV4ClReplayRegistryEntry,
  order: { blockNumber: bigint; transactionIndex: number; logIndex: number },
  overrides: {
    sqrtPriceX96?: bigint;
    tick?: number;
    liquidity?: bigint;
    lpFee?: bigint;
  } = {},
): FameV4ClReplayRawLog {
  return v4ReplayLogFixture(pool, {
    ...order,
    topics: strictTopics(
      encodeEventTopics({
        abi: [V4ClReplaySwapEventAbi],
        eventName: "Swap",
        args: {
          id: pool.poolKey,
          sender: UNIT_ADDRESS_1,
        },
      }),
    ),
    data: encodeAbiParameters(
      [
        { name: "amount0", type: "int128" },
        { name: "amount1", type: "int128" },
        { name: "sqrtPriceX96", type: "uint160" },
        { name: "liquidity", type: "uint128" },
        { name: "tick", type: "int24" },
        { name: "fee", type: "uint24" },
      ],
      [
        -10n,
        20n,
        overrides.sqrtPriceX96 ?? 2n ** 96n,
        overrides.liquidity ?? 2_345n,
        overrides.tick ?? -17_200,
        Number(overrides.lpFee ?? 30_000n),
      ],
    ),
  });
}

function modifyLiquidityV4ReplayLog(
  pool: FameV4ClReplayRegistryEntry,
  order: { blockNumber: bigint; transactionIndex: number; logIndex: number },
  options: {
    tickLower?: number;
    tickUpper?: number;
    liquidityDelta?: bigint;
  } = {},
): FameV4ClReplayRawLog {
  return v4ReplayLogFixture(pool, {
    ...order,
    topics: strictTopics(
      encodeEventTopics({
        abi: [V4ClReplayModifyLiquidityEventAbi],
        eventName: "ModifyLiquidity",
        args: {
          id: pool.poolKey,
          sender: UNIT_ADDRESS_1,
        },
      }),
    ),
    data: encodeAbiParameters(
      [
        { name: "tickLower", type: "int24" },
        { name: "tickUpper", type: "int24" },
        { name: "liquidityDelta", type: "int256" },
        { name: "salt", type: "bytes32" },
      ],
      [
        options.tickLower ?? -17_600,
        options.tickUpper ?? -17_200,
        options.liquidityDelta ?? 50n,
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    ),
  });
}

function clReplaySeedCapsule(pool: FameClReplayRegistryEntry) {
  const rows = clReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: 100,
    liquidity: 1_000n,
    fee: 100n,
    observedThroughBlock: 120,
    blockHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    parentHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    snapshotId: "seed-120",
    stateHash:
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    sourceRegistryId: "unit-registry",
    updatedAt: "2026-05-20T00:00:00.000Z",
    bitmapWords: [
      { wordPosition: -1, bitmap: 1n << 254n },
      { wordPosition: 0, bitmap: 1n << 3n },
    ],
    initializedTicks: [
      { tick: -200, liquidityGross: 500n, liquidityNet: 500n },
      { tick: 300, liquidityGross: 500n, liquidityNet: -500n },
    ],
  });
  return {
    latest: rows.latest,
    bitmapWords: rows.bitmapChunks.flatMap((chunk) => chunk.bitmapWords),
    initializedTicks: rows.tickChunks.flatMap(
      (chunk) => chunk.initializedTicks,
    ),
  };
}

function v4ClReplaySeedCapsule(pool: FameV4ClReplayRegistryEntry) {
  const rows = v4ClReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: -17_400,
    liquidity: 1_000n,
    lpFee: 30_000n,
    protocolFee: 0n,
    observedThroughBlock: 120,
    blockHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    parentHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    snapshotId: "v4-seed-120",
    stateHash:
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    reviewedPoolEvidence: reviewedV4PoolEvidence(pool),
    zoraProvenance: verifiedV4ZoraProvenance(pool),
    sourceRegistryId: "unit-registry",
    updatedAt: "2026-05-20T00:00:00.000Z",
    bitmapWords: [{ wordPosition: -1, bitmap: (1n << 168n) | (1n << 170n) }],
    initializedTicks: [
      { tick: -17_600, liquidityGross: 500n, liquidityNet: 500n },
      { tick: -17_200, liquidityGross: 500n, liquidityNet: -500n },
    ],
  });
  return {
    latest: rows.latest,
    bitmapWords: rows.bitmapChunks.flatMap((chunk) => chunk.bitmapWords),
    initializedTicks: rows.tickChunks.flatMap(
      (chunk) => chunk.initializedTicks,
    ),
  };
}

function normalizedEventBase(pool: FameClReplayRegistryEntry) {
  return {
    poolId: pool.id,
    venue: pool.venue,
    poolAddress: pool.poolAddress,
    blockNumber: 121,
    blockHash:
      "0x4444444444444444444444444444444444444444444444444444444444444444",
    transactionHash:
      "0x5555555555555555555555555555555555555555555555555555555555555555",
    transactionIndex: 1,
    logIndex: 1,
  } as const;
}

function normalizedV4EventBase(pool: FameV4ClReplayRegistryEntry) {
  return {
    poolId: pool.id,
    venue: pool.venue,
    poolKey: pool.poolKey,
    poolManager: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolManager,
    blockNumber: 121,
    blockHash:
      "0x4444444444444444444444444444444444444444444444444444444444444444",
    transactionHash:
      "0x5555555555555555555555555555555555555555555555555555555555555555",
    transactionIndex: 1,
    logIndex: 1,
  } as const;
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

  test("builds V4 replay snapshots from StateView bitmap and tick reads at one block", async () => {
    const pool = v4ClReplayPool();
    const client = new FakeUniswapV4ReplayReadClient();

    const snapshot = await getUniswapV4ClReplaySnapshot({
      client,
      pool,
      blockNumber: 118n,
    });

    expect(snapshot).toMatchObject({
      sqrtPriceX96: 2n ** 96n,
      tick: -17_400,
      liquidity: 1_000n,
      lpFee: 30_000n,
      protocolFee: 0n,
      blockHash: client.blockHash,
      parentHash: client.parentHash,
      initializedTicks: [
        { tick: -17_600, liquidityGross: 20n, liquidityNet: -20n },
        { tick: -17_400, liquidityGross: 30n, liquidityNet: 10n },
      ],
      providerReadCount: 42,
    });
    expect(snapshot.bitmapWords).toHaveLength(36);
    expect(snapshot.bitmapWords.filter((word) => word.bitmap !== 0n)).toEqual([
      { wordPosition: -1, bitmap: (1n << 168n) | (1n << 169n) },
    ]);
    expect(client.tickBitmapWordPositions).toHaveLength(36);
    expect(client.tickBitmapWordPositions[0]).toBe(-18);
    expect(client.tickBitmapWordPositions.at(-1)).toBe(17);
    expect(client.tickIndexes).toEqual([-17_600, -17_400]);
    expect(
      client.stateViewAddresses.every(
        (address) => address === pool.stateViewAddress,
      ),
    ).toBe(true);
    expect(client.poolKeys.every((poolKey) => poolKey === pool.poolKey)).toBe(
      true,
    );
    expect(
      client.blockNumbers.every((blockNumber) => blockNumber === 118n),
    ).toBe(true);
  });

  test("preserves V4 zero-bitmap coverage for empty initialized tick snapshots", async () => {
    const pool = v4ClReplayPool();
    const client = new FakeUniswapV4ReplayReadClient();
    client.bitmaps.clear();

    const snapshot = await getUniswapV4ClReplaySnapshot({
      client,
      pool,
      blockNumber: 118n,
    });

    expect(snapshot.initializedTicks).toHaveLength(0);
    expect(snapshot.bitmapWords).toHaveLength(36);
    expect(snapshot.bitmapWords.every((word) => word.bitmap === 0n)).toBe(true);
    expect(client.tickIndexes).toHaveLength(0);
  });

  test("normalizes CL replay Swap, Mint, Burn, and no-op Collect logs in chain order", () => {
    const pool = clReplayPool();

    const events = normalizeClReplayLogs({
      pool,
      logs: [
        burnReplayLog(pool, {
          blockNumber: 123n,
          transactionIndex: 1,
          logIndex: 2,
        }),
        collectReplayLog(pool, {
          blockNumber: 123n,
          transactionIndex: 1,
          logIndex: 3,
        }),
        swapReplayLog(pool, {
          blockNumber: 122n,
          transactionIndex: 9,
          logIndex: 9,
        }),
        mintReplayLog(pool, {
          blockNumber: 123n,
          transactionIndex: 1,
          logIndex: 1,
        }),
      ],
    });

    expect(events.map((event) => event.kind)).toEqual([
      "swap",
      "mint",
      "burn",
      "collect",
    ]);
    expect(events[0]).toMatchObject({
      poolId: pool.id,
      venue: "aerodrome-slipstream",
      blockNumber: 122,
      sqrtPriceX96: 2n ** 96n,
      liquidity: 1_234n,
      tick: 101,
    });
    expect(events[1]).toMatchObject({
      kind: "mint",
      tickLower: -200,
      tickUpper: 300,
      amount: 50n,
    });
    expect(events[2]).toMatchObject({
      kind: "burn",
      tickLower: -200,
      tickUpper: 300,
      amount: 25n,
    });
  });

  test("normalizes and applies V4 PoolManager replay logs for the approved pool", () => {
    const pool = v4ClReplayPool();
    const events = normalizeV4ClReplayLogs({
      pool,
      logs: [
        swapV4ReplayLog(pool, {
          blockNumber: 122n,
          transactionIndex: 2,
          logIndex: 2,
        }),
        modifyLiquidityV4ReplayLog(pool, {
          blockNumber: 122n,
          transactionIndex: 2,
          logIndex: 1,
        }),
      ],
    });

    expect(events.map((event) => event.kind)).toEqual([
      "modify-liquidity",
      "swap",
    ]);

    const result = applyV4ClReplayDeltas({
      pool,
      seed: v4ClReplaySeedCapsule(pool),
      events,
      observedThroughBlock: 122,
      blockHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      parentHash:
        "0x5555555555555555555555555555555555555555555555555555555555555555",
      candidateId: "unit-v4-candidate",
      reviewedPoolEvidence: reviewedV4PoolEvidence(pool),
      zoraProvenance: verifiedV4ZoraProvenance(pool),
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:01:00.000Z",
    });

    expect(result).toMatchObject({
      status: "candidate",
      appliedEventCount: 2,
      rows: {
        latest: {
          poolId: pool.id,
          stateKind: "v4-cl-replay-candidate-v1",
          tick: -17_200,
          liquidity: "2345",
          lpFee: "30000",
          protocolFee: "0",
          candidateId: "unit-v4-candidate",
        },
      },
    });
  });

  test("fails closed for invalid V4 replay delta inputs", () => {
    const pool = v4ClReplayPool();
    const base = normalizedV4EventBase(pool);
    const seed = v4ClReplaySeedCapsule(pool);
    const highGrossSeed = {
      ...seed,
      latest: {
        ...seed.latest,
        liquidity: "100",
      },
      initializedTicks: seed.initializedTicks.map((tick) => ({
        ...tick,
        liquidityGross: "2000",
      })),
    };
    const swap = {
      ...base,
      kind: "swap",
      sqrtPriceX96: 2n ** 96n,
      tick: -17_200,
      liquidity: 2_345n,
      lpFee: 30_000n,
    } as const;
    const modify = {
      ...base,
      kind: "modify-liquidity",
      tickLower: -17_600,
      tickUpper: -17_200,
      liquidityDelta: 50n,
    } as const;

    const cases = [
      {
        reason: "seed-required",
        seed: null,
        events: [],
      },
      {
        reason: "source-registry-mismatch",
        seed,
        sourceRegistryId: "other-registry",
        events: [],
      },
      {
        reason: "pool-mismatch",
        seed,
        events: [{ ...swap, poolId: "other-pool" }],
      },
      {
        reason: "lp-fee-mismatch",
        seed,
        events: [{ ...swap, lpFee: 10_000n }],
      },
      {
        reason: "pool-shape-mismatch",
        seed,
        events: [
          {
            ...base,
            kind: "initialize",
            sqrtPriceX96: 2n ** 96n,
            tick: -17_400,
            lpFee: 30_000n,
            tickSpacing: 1,
          } as const,
        ],
      },
      {
        reason: "invalid-tick-range",
        seed,
        events: [{ ...modify, tickLower: -17_200, tickUpper: -17_600 }],
      },
      {
        reason: "invalid-tick-spacing",
        seed,
        events: [{ ...modify, tickLower: -17_601 }],
      },
      {
        reason: "liquidity-underflow",
        seed,
        events: [{ ...modify, liquidityDelta: -1_000n }],
      },
      {
        reason: "active-liquidity-underflow",
        seed: highGrossSeed,
        events: [{ ...modify, liquidityDelta: -500n }],
      },
    ] as const;

    for (const testCase of cases) {
      const sourceRegistryId =
        "sourceRegistryId" in testCase
          ? testCase.sourceRegistryId
          : "unit-registry";
      const result = applyV4ClReplayDeltas({
        pool,
        seed: testCase.seed,
        events: testCase.events,
        observedThroughBlock: 122,
        blockHash:
          "0x4444444444444444444444444444444444444444444444444444444444444444",
        parentHash:
          "0x5555555555555555555555555555555555555555555555555555555555555555",
        candidateId: "unit-v4-candidate",
        reviewedPoolEvidence: reviewedV4PoolEvidence(pool),
        zoraProvenance: verifiedV4ZoraProvenance(pool),
        sourceRegistryId,
        updatedAt: "2026-05-20T00:01:00.000Z",
      });

      expect(result).toMatchObject({
        reason: testCase.reason,
      });
      expect(result.status).not.toBe("candidate");
    }
  });

  test("rejects unsupported, removed, and ambiguous CL replay logs", () => {
    const pool = clReplayPool();
    const unsupported = replayLogFixture(pool, {
      blockNumber: 122n,
      transactionIndex: 0,
      logIndex: 0,
      topics: [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      data: "0x",
    });

    expect(() => normalizeClReplayLogs({ pool, logs: [unsupported] })).toThrow(
      FameClReplayLogNormalizationError,
    );
    expect(() =>
      normalizeClReplayLogs({
        pool,
        logs: [
          {
            ...swapReplayLog(pool, {
              blockNumber: 122n,
              transactionIndex: 0,
              logIndex: 0,
            }),
            removed: true,
          },
        ],
      }),
    ).toThrow(FameClReplayLogNormalizationError);
    expect(() =>
      normalizeClReplayLogs({
        pool,
        logs: [
          {
            ...swapReplayLog(pool, {
              blockNumber: 122n,
              transactionIndex: 0,
              logIndex: 0,
            }),
            blockHash: null,
          },
        ],
      }),
    ).toThrow(FameClReplayLogNormalizationError);
  });

  test("applies swap and mint deltas into a deterministic candidate capsule", () => {
    const pool = clReplayPool();
    const seed = clReplaySeedCapsule(pool);
    const base = normalizedEventBase(pool);

    const result = applyClReplayDeltas({
      pool,
      seed,
      events: [
        {
          ...base,
          kind: "swap",
          sqrtPriceX96: 2n ** 96n + 1n,
          tick: 100,
          liquidity: 1_000n,
        },
        {
          ...base,
          kind: "mint",
          logIndex: 2,
          tickLower: -200,
          tickUpper: 300,
          amount: 50n,
        },
      ],
      observedThroughBlock: 121,
      blockHash: base.blockHash,
      parentHash:
        "0x6666666666666666666666666666666666666666666666666666666666666666",
      candidateId: "candidate-121",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:01:00.000Z",
    });

    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") throw new Error("Expected candidate.");
    expect(result.appliedEventCount).toBe(2);
    expect(result.rows.latest).toMatchObject({
      sqrtPriceX96: (2n ** 96n + 1n).toString(),
      tick: 100,
      liquidity: "1050",
      candidateId: "candidate-121",
      observedThroughBlock: 121,
    });
    expect(
      result.rows.tickChunks.flatMap((chunk) => chunk.initializedTicks),
    ).toEqual([
      { tick: -200, liquidityGross: "550", liquidityNet: "550" },
      { tick: 300, liquidityGross: "550", liquidityNet: "-550" },
    ]);
  });

  test("applies burn deltas by removing empty initialized ticks and bitmap words", () => {
    const pool = clReplayPool();
    const base = normalizedEventBase(pool);

    const result = applyClReplayDeltas({
      pool,
      seed: clReplaySeedCapsule(pool),
      events: [
        {
          ...base,
          kind: "burn",
          tickLower: -200,
          tickUpper: 300,
          amount: 500n,
        },
      ],
      observedThroughBlock: 121,
      blockHash: base.blockHash,
      parentHash:
        "0x6666666666666666666666666666666666666666666666666666666666666666",
      candidateId: "candidate-121",
      sourceRegistryId: "unit-registry",
      updatedAt: "2026-05-20T00:01:00.000Z",
    });

    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") throw new Error("Expected candidate.");
    expect(result.rows.latest).toMatchObject({
      liquidity: "500",
      bitmapWordCount: 0,
      initializedTickCount: 0,
      bitmapChunkCount: 0,
      tickChunkCount: 0,
    });
    expect(result.rows.bitmapChunks).toEqual([]);
    expect(result.rows.tickChunks).toEqual([]);
  });

  test("fails closed when replay reducer has no seed or underflows liquidity", () => {
    const pool = clReplayPool();
    const base = normalizedEventBase(pool);

    expect(
      applyClReplayDeltas({
        pool,
        seed: null,
        events: [],
        observedThroughBlock: 121,
        blockHash: base.blockHash,
        parentHash:
          "0x6666666666666666666666666666666666666666666666666666666666666666",
        candidateId: "candidate-121",
        sourceRegistryId: "unit-registry",
        updatedAt: "2026-05-20T00:01:00.000Z",
      }),
    ).toMatchObject({ status: "warming", reason: "seed-required" });
    expect(
      applyClReplayDeltas({
        pool,
        seed: clReplaySeedCapsule(pool),
        events: [
          {
            ...base,
            kind: "burn",
            tickLower: -200,
            tickUpper: 300,
            amount: 501n,
          },
        ],
        observedThroughBlock: 121,
        blockHash: base.blockHash,
        parentHash:
          "0x6666666666666666666666666666666666666666666666666666666666666666",
        candidateId: "candidate-121",
        sourceRegistryId: "unit-registry",
        updatedAt: "2026-05-20T00:01:00.000Z",
      }),
    ).toMatchObject({ status: "event-gap", reason: "liquidity-underflow" });
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
      clReplayMaintenanceMetrics: [
        {
          poolId: replayPool.id,
          status: "warming",
          reason: "shadow-not-promoted",
          fromBlock: 118,
          toBlock: 118,
          scannedLogCount: 0,
          appliedEventCount: 0,
          candidateWritten: true,
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
    expect(db.getLatestClReplayCandidate(replayPool)).toMatchObject({
      stateKind: "cl-replay-candidate-v1",
      candidateId: expect.stringContaining(replayPool.id),
      observedThroughBlock: 118,
    });
    expect(db.getLatestClReplayMaintenance(replayPool)).toMatchObject({
      stateKind: "cl-replay-maintenance-v1",
      status: "warming",
      reason: "shadow-not-promoted",
      candidateId: expect.stringContaining(replayPool.id),
    });
  });

  test("writes V4 replay snapshots only with verified Zora provenance", async () => {
    const v4Pool = v4ClReplayPool();
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.v4ClReplaySnapshotsByPoolId.set(v4Pool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: -17_400,
      liquidity: 8_888n,
      lpFee: 30_000n,
      protocolFee: 0n,
      blockHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      parentHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      bitmapWords: [{ wordPosition: -1, bitmap: 1n << 169n }],
      initializedTicks: [
        { tick: -17_400, liquidityGross: 30n, liquidityNet: 10n },
      ],
      providerReadCount: 42,
      durationMs: 24,
    });

    const missingProofResult = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([v4Pool]),
      now: new Date("2026-05-21T00:00:00.000Z"),
    });

    expect(missingProofResult).toMatchObject({
      v4ClReplaySnapshots: 0,
      v4ClReplayWrittenPools: 0,
      v4ClReplayFailedPools: 0,
      v4ClReplayMetrics: [],
    });
    expect(db.getLatestV4ClReplay(v4Pool)).toBeUndefined();

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([v4Pool]),
      v4ZoraProvenance: verifiedV4ZoraProvenance(v4Pool),
      now: new Date("2026-05-21T00:01:00.000Z"),
    });

    expect(result).toMatchObject({
      v4ClReplaySnapshots: 1,
      v4ClReplayWrittenPools: 1,
      v4ClReplayFailedPools: 0,
      v4ClReplayMetrics: [
        {
          poolId: v4Pool.id,
          bitmapWordCount: 1,
          initializedTickCount: 1,
          bitmapChunkCount: 1,
          tickChunkCount: 1,
          providerReadCount: 42,
          durationMs: 24,
          stateHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
          lpFee: "30000",
          protocolFee: "0",
        },
      ],
    });
    expect(db.getLatestV4ClReplay(v4Pool)).toMatchObject({
      stateKind: "v4-cl-replay-v1",
      poolId: v4Pool.id,
      poolKey: v4Pool.poolKey,
      stateViewAddress: v4Pool.stateViewAddress,
      tick: -17_400,
      liquidity: "8888",
      lpFee: "30000",
      protocolFee: "0",
      feeSource: "v4-slot0",
      source: "uniswap-v4-state-view",
      observedThroughBlock: 118,
      blockHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      bitmapWordCount: 1,
      initializedTickCount: 1,
      minTick: -17_400,
      maxTick: -17_400,
    });
    expect(db.getLatestV4ClReplay(v4Pool)).not.toHaveProperty("poolAddress");
    expect(
      stringField(parseItem(db.getLatestV4ClReplay(v4Pool)), "snapshotId"),
    ).toContain(result.sourceRegistryId);
  });

  test("writes no-hook ZORA/ETH V4 replay snapshots without Zora provenance", async () => {
    const v4Pool = v4ClReplayPool("uniswap-v4-zora-eth");
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.v4ClReplaySnapshotsByPoolId.set(v4Pool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: -1_200,
      liquidity: 7_777n,
      lpFee: 3_000n,
      protocolFee: 0n,
      blockHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      parentHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      bitmapWords: [{ wordPosition: -1, bitmap: 1n << 240n }],
      initializedTicks: [
        { tick: -1_200, liquidityGross: 30n, liquidityNet: 10n },
      ],
      providerReadCount: 19,
      durationMs: 11,
    });

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([v4Pool]),
      now: new Date("2026-05-21T00:01:00.000Z"),
    });

    expect(result).toMatchObject({
      v4ClReplaySnapshots: 1,
      v4ClReplayWrittenPools: 1,
      v4ClReplayFailedPools: 0,
      v4ClReplayMetrics: [
        {
          poolId: v4Pool.id,
          bitmapWordCount: 1,
          initializedTickCount: 1,
          bitmapChunkCount: 1,
          tickChunkCount: 1,
          providerReadCount: 19,
          durationMs: 11,
          stateHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
          lpFee: "3000",
          protocolFee: "0",
        },
      ],
    });
    expect(db.getLatestV4ClReplay(v4Pool)).toMatchObject({
      stateKind: "v4-cl-replay-v1",
      poolId: v4Pool.id,
      poolKey: v4Pool.poolKey,
      stateViewAddress: v4Pool.stateViewAddress,
      tick: -1_200,
      liquidity: "7777",
      lpFee: "3000",
      protocolFee: "0",
      reviewedPoolEvidence: expect.objectContaining({
        kind: "zero-hook-static-fee",
        poolId: "uniswap-v4-zora-eth",
        staticFee: "3000",
        protocolFeeStatus: "zero",
      }),
    });
    expect(db.getLatestV4ClReplay(v4Pool)).not.toHaveProperty(
      "zoraProvenance",
    );
  });

  test("seeds approved V4 maintenance once then advances from PoolManager deltas", async () => {
    const v4Pool = v4ClReplayPool();
    const db = new InMemoryPoolStateDb();
    const seedClient = new FakePoolStateClient([], 120n);
    seedClient.v4ClReplaySnapshotsByPoolId.set(v4Pool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: -17_400,
      liquidity: 1_000n,
      lpFee: 30_000n,
      protocolFee: 0n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [
        { wordPosition: -2, bitmap: 0n },
        { wordPosition: -1, bitmap: (1n << 168n) | (1n << 170n) },
        { wordPosition: 0, bitmap: 0n },
      ],
      initializedTicks: [
        { tick: -17_600, liquidityGross: 500n, liquidityNet: 500n },
        { tick: -17_200, liquidityGross: 500n, liquidityNet: -500n },
      ],
      providerReadCount: 42,
      durationMs: 24,
    });

    const seedResult = await indexFamePoolStates({
      client: seedClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([v4Pool]),
      clReplayMaintenanceMode: "steady-state",
      clReplayTrustPromotion: true,
      v4ZoraProvenance: verifiedV4ZoraProvenance(v4Pool),
      now: new Date("2026-05-21T00:00:00.000Z"),
    });

    expect(seedResult).toMatchObject({
      v4ClReplaySnapshots: 1,
      v4ClReplayMaintenanceMetrics: [
        {
          poolId: v4Pool.id,
          status: "trusted",
          reason: null,
          fromBlock: 118,
          toBlock: 118,
          scannedLogCount: 0,
          appliedEventCount: 0,
          candidateWritten: true,
        },
      ],
    });
    expect(db.getLatestV4ClReplayMaintenance(v4Pool)).toMatchObject({
      status: "trusted",
      cursorBlock: 118,
      reason: null,
    });
    expect(db.getLatestV4ClReplay(v4Pool)).toMatchObject({
      bitmapWordCount: 1,
      initializedTickCount: 2,
    });

    const deltaClient = new FakePoolStateClient([], 123n);
    const unrelatedV4Log = swapV4ReplayLog(v4Pool, {
      blockNumber: 120n,
      transactionIndex: 1,
      logIndex: 1,
    });
    const unrelatedTopic0 = unrelatedV4Log.topics[0];
    if (!unrelatedTopic0) throw new Error("Missing V4 replay topic0.");
    deltaClient.v4ClReplayLogs = [
      {
        ...unrelatedV4Log,
        topics: [
          unrelatedTopic0,
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
      },
      swapV4ReplayLog(v4Pool, {
        blockNumber: 120n,
        transactionIndex: 2,
        logIndex: 3,
      }),
    ];

    const deltaResult = await indexFamePoolStates({
      client: deltaClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([v4Pool]),
      clReplayMaintenanceMode: "steady-state",
      clReplayTrustPromotion: true,
      v4ZoraProvenance: verifiedV4ZoraProvenance(v4Pool),
      now: new Date("2026-05-21T00:01:00.000Z"),
    });

    expect(deltaClient.v4ClReplaySnapshotReadCount).toBe(0);
    expect(deltaResult).toMatchObject({
      v4ClReplaySnapshots: 0,
      v4ClReplayMaintenanceMetrics: [
        {
          poolId: v4Pool.id,
          status: "trusted",
          reason: null,
          fromBlock: 119,
          toBlock: 121,
          scannedLogCount: 1,
          appliedEventCount: 1,
          candidateWritten: true,
        },
      ],
    });
    expect(db.getLatestV4ClReplay(v4Pool)).toMatchObject({
      tick: -17_200,
      liquidity: "2345",
      observedThroughBlock: 121,
      lpFee: "30000",
      protocolFee: "0",
    });
    expect(db.getLatestV4ClReplayCandidate(v4Pool)).toMatchObject({
      stateKind: "v4-cl-replay-candidate-v1",
      observedThroughBlock: 121,
    });
  });

  test("repairs approved V4 maintenance from a full snapshot without a trusted cursor", async () => {
    const v4Pool = v4ClReplayPool();
    const db = new InMemoryPoolStateDb();
    const repairClient = new FakePoolStateClient([], 120n);
    repairClient.v4ClReplaySnapshotsByPoolId.set(v4Pool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: -17_400,
      liquidity: 2_000n,
      lpFee: 30_000n,
      protocolFee: 0n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [
        { wordPosition: -2, bitmap: 0n },
        { wordPosition: -1, bitmap: 1n << 168n },
      ],
      initializedTicks: [
        { tick: -17_600, liquidityGross: 500n, liquidityNet: 500n },
      ],
      providerReadCount: 42,
      durationMs: 24,
    });

    const repairResult = await indexFamePoolStates({
      client: repairClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([v4Pool]),
      clReplayMaintenanceMode: "repair",
      clReplayTrustPromotion: true,
      v4ZoraProvenance: verifiedV4ZoraProvenance(v4Pool),
      now: new Date("2026-05-21T00:00:00.000Z"),
    });

    expect(repairResult).toMatchObject({
      v4ClReplaySnapshots: 1,
      v4ClReplayMaintenanceMetrics: [
        {
          poolId: v4Pool.id,
          status: "trusted",
          reason: null,
          fromBlock: 118,
          toBlock: 118,
          scannedLogCount: 0,
          appliedEventCount: 0,
          candidateWritten: true,
        },
      ],
    });
    expect(db.getLatestV4ClReplay(v4Pool)).toMatchObject({
      liquidity: "2000",
      observedThroughBlock: 118,
      bitmapWordCount: 1,
    });
    expect(db.getLatestV4ClReplayMaintenance(v4Pool)).toMatchObject({
      status: "trusted",
      reason: null,
      cursorBlock: 118,
    });
  });

  test("maintains the selected Slipstream candidate without publishing quoteable replay state", async () => {
    const candidatePool = clReplayCandidatePool();
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.clReplaySnapshotsByPoolId.set(candidatePool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 200_000,
      liquidity: 7_777n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 0, bitmap: 1n << 100n }],
      initializedTicks: [
        { tick: 200_000, liquidityGross: 77n, liquidityNet: 77n },
      ],
      providerReadCount: 41,
      durationMs: 99,
    });

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([candidatePool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      clReplaySnapshots: 1,
      clReplayWrittenPools: 0,
      clReplayMaintenanceMetrics: [
        {
          poolId: candidatePool.id,
          status: "trusted",
          reason: null,
          fromBlock: 118,
          toBlock: 118,
          scannedLogCount: 0,
          appliedEventCount: 0,
          candidateWritten: true,
          stateHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        },
      ],
    });
    expect(db.getLatestClReplay(candidatePool)).toBeUndefined();
    expect(db.getLatestClReplayCandidate(candidatePool)).toMatchObject({
      stateKind: "cl-replay-candidate-v1",
      poolId: candidatePool.id,
      tick: 200_000,
      liquidity: "7777",
      observedThroughBlock: 118,
    });
    expect(db.getLatestClReplayMaintenance(candidatePool)).toMatchObject({
      status: "trusted",
      reason: null,
      candidateId: expect.stringContaining(candidatePool.id),
    });
  });

  test("publishes selected Slipstream replay rows only after compact quote activation", async () => {
    const promotedPool = clReplayPromotedCandidatePool();
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.clReplaySnapshotsByPoolId.set(promotedPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 200_000,
      liquidity: 7_777n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 0, bitmap: 1n << 100n }],
      initializedTicks: [
        { tick: 200_000, liquidityGross: 77n, liquidityNet: 77n },
      ],
      providerReadCount: 41,
      durationMs: 99,
    });

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([promotedPool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      clReplaySnapshots: 1,
      clReplayWrittenPools: 1,
      clReplayMaintenanceMetrics: [
        {
          poolId: promotedPool.id,
          status: "trusted",
          reason: null,
          candidateWritten: true,
        },
      ],
    });
    expect(db.getLatestClReplay(promotedPool)).toMatchObject({
      stateKind: "cl-replay-v1",
      poolId: promotedPool.id,
      tick: 200_000,
      liquidity: "7777",
      observedThroughBlock: 118,
    });
  });

  test("requires a complete checkpoint snapshot before trusting selected candidate maintenance", async () => {
    const candidatePool = clReplayCandidatePool();
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.failingClReplayPoolId = candidatePool.id;

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([candidatePool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      clReplaySnapshots: 0,
      clReplayFailedPools: 1,
      clReplayMaintenanceMetrics: [
        {
          poolId: candidatePool.id,
          status: "event-gap",
          reason: "checkpoint-snapshot-required",
          candidateWritten: false,
          stateHash: null,
        },
      ],
    });
    expect(db.getLatestClReplay(candidatePool)).toBeUndefined();
    expect(db.getLatestClReplayCandidate(candidatePool)).toBeUndefined();
  });

  test("keeps selected candidate steady-state untrusted without a matching trusted cursor", async () => {
    const candidatePool = clReplayCandidatePool();
    const db = new InMemoryPoolStateDb();
    const seedClient = new FakePoolStateClient([], 120n);
    seedClient.clReplaySnapshotsByPoolId.set(candidatePool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 200_000,
      liquidity: 7_777n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 0, bitmap: 1n << 100n }],
      initializedTicks: [
        { tick: 200_000, liquidityGross: 77n, liquidityNet: 77n },
      ],
      providerReadCount: 41,
      durationMs: 99,
    });

    await indexFamePoolStates({
      client: seedClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([candidatePool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    const maintenance = db.getLatestClReplayMaintenance(candidatePool);
    if (!maintenance) throw new Error("Missing seeded candidate maintenance.");
    await putLatestClReplayMaintenanceState({
      db,
      tableName: "PoolState",
      state: {
        ...maintenance,
        status: "event-gap",
        reason: "unit-event-gap",
      } as Parameters<typeof putLatestClReplayMaintenanceState>[0]["state"],
    });

    const result = await indexFamePoolStates({
      client: new FakePoolStateClient([], 123n),
      db,
      tableName: "PoolState",
      registry: registryWithPools([candidatePool]),
      clReplayMaintenanceMode: "steady-state",
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:01:00.000Z"),
    });

    expect(result.clReplayMaintenanceMetrics).toMatchObject([
      {
        poolId: candidatePool.id,
        status: "event-gap",
        reason: "trusted-cursor-required",
        candidateWritten: false,
      },
    ]);
    expect(db.getLatestClReplayCandidate(candidatePool)).toMatchObject({
      observedThroughBlock: 118,
    });
  });

  test("checkpoint-bootstraps steady-state replay when the source registry changes", async () => {
    const replayPool = clReplayPool();
    const oldRegistry = registryWithPools(
      [replayPool],
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const newRegistry = registryWithPools(
      [replayPool],
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const db = new InMemoryPoolStateDb();
    const seedClient = new FakePoolStateClient([], 120n);
    seedClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 207n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      providerReadCount: 5,
      durationMs: 12,
    });

    await indexFamePoolStates({
      client: seedClient,
      db,
      tableName: "PoolState",
      registry: oldRegistry,
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    const bootstrapClient = new FakePoolStateClient([], 123n);
    bootstrapClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 200_000,
      liquidity: 2_000n,
      fee: 100n,
      blockHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      parentHash:
        "0x4444444444444444444444444444444444444444444444444444444444444444",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 208n }],
      initializedTicks: [
        { tick: 200_000, liquidityGross: 30n, liquidityNet: 20n },
      ],
      providerReadCount: 7,
      durationMs: 14,
    });

    const result = await indexFamePoolStates({
      client: bootstrapClient,
      db,
      tableName: "PoolState",
      registry: newRegistry,
      clReplayMaintenanceMode: "steady-state",
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:01:00.000Z"),
    });

    const newSourceRegistryId = sourceRegistryIdFor(newRegistry.source);
    expect(result).toMatchObject({
      clReplaySnapshots: 1,
      clReplayWrittenPools: 1,
      clReplayMaintenanceMetrics: [
        {
          poolId: replayPool.id,
          status: "trusted",
          reason: null,
          fromBlock: 121,
          toBlock: 121,
          scannedLogCount: 0,
          appliedEventCount: 0,
          candidateWritten: true,
          stateHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        },
      ],
      sourceRegistryId: newSourceRegistryId,
    });
    expect(db.getLatestClReplay(replayPool)).toMatchObject({
      observedThroughBlock: 121,
      tick: 200_000,
      liquidity: "2000",
      sourceRegistryId: newSourceRegistryId,
    });
    expect(db.getLatestClReplayMaintenance(replayPool)).toMatchObject({
      status: "trusted",
      reason: null,
      cursorBlock: 121,
      sourceRegistryId: newSourceRegistryId,
    });
  });

  test("fails loudly when selected candidate registry identity drifts before maintenance", async () => {
    const candidatePool: FamePoolStateRegistryEntry = {
      ...clReplayCandidatePool(),
      venue: "aerodrome-slipstream2",
      venueFamily: "Slipstream2",
    };

    await expect(
      indexFamePoolStates({
        client: new FakePoolStateClient([], 120n),
        db: new InMemoryPoolStateDb(),
        tableName: "PoolState",
        registry: registryWithPools([candidatePool]),
        clReplayTrustPromotion: true,
        now: new Date("2026-05-20T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/Aerodrome Slipstream v1/);
  });

  test("advances trusted candidate maintenance only when the cursor block is canonical", async () => {
    const candidatePool = clReplayCandidatePool();
    const db = new InMemoryPoolStateDb();
    const seedClient = new FakePoolStateClient([], 120n);
    seedClient.clReplaySnapshotsByPoolId.set(candidatePool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 200_000,
      liquidity: 7_777n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 0, bitmap: 1n << 100n }],
      initializedTicks: [
        { tick: 200_000, liquidityGross: 77n, liquidityNet: 77n },
      ],
      providerReadCount: 41,
      durationMs: 99,
    });

    await indexFamePoolStates({
      client: seedClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([candidatePool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    const steadyClient = new FakePoolStateClient([], 123n);
    const steadyResult = await indexFamePoolStates({
      client: steadyClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([candidatePool]),
      clReplayMaintenanceMode: "steady-state",
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:01:00.000Z"),
    });

    expect(steadyResult).toMatchObject({
      clReplaySnapshots: 0,
      clReplayMaintenanceMetrics: [
        {
          poolId: candidatePool.id,
          status: "trusted",
          reason: null,
          fromBlock: 119,
          toBlock: 121,
          scannedLogCount: 0,
          appliedEventCount: 0,
          candidateWritten: true,
        },
      ],
    });
    expect(db.getLatestClReplay(candidatePool)).toBeUndefined();
    expect(db.getLatestClReplayCandidate(candidatePool)).toMatchObject({
      observedThroughBlock: 121,
      liquidity: "7777",
    });

    const mismatchClient = new FakePoolStateClient([], 124n);
    mismatchClient.blockIdentitiesByNumber.set(121, {
      hash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
    });
    const mismatchResult = await indexFamePoolStates({
      client: mismatchClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([candidatePool]),
      clReplayMaintenanceMode: "steady-state",
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:02:00.000Z"),
    });

    expect(mismatchResult.clReplayMaintenanceMetrics).toMatchObject([
      {
        poolId: candidatePool.id,
        status: "event-gap",
        reason: "cursor-block-hash-mismatch",
      },
    ]);
  });

  test("promotes checkpoint-clean CL replay state and advances it in steady-state without full snapshots", async () => {
    const replayPool = clReplayPool();
    const db = new InMemoryPoolStateDb();
    const seedClient = new FakePoolStateClient([], 120n);
    seedClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 207n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      providerReadCount: 5,
      durationMs: 12,
    });

    const seedResult = await indexFamePoolStates({
      client: seedClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    expect(seedResult).toMatchObject({
      clReplaySnapshots: 1,
      clReplayMaintenanceMetrics: [
        {
          poolId: replayPool.id,
          status: "trusted",
          fromBlock: 118,
          toBlock: 118,
          scannedLogCount: 0,
          appliedEventCount: 0,
          candidateWritten: true,
        },
      ],
    });
    expect(db.getLatestClReplayMaintenance(replayPool)).toMatchObject({
      status: "trusted",
      reason: null,
      cursorBlock: 118,
    });

    const deltaClient = new FakePoolStateClient([], 123n);
    deltaClient.clReplayLogs = [
      swapReplayLog(replayPool, {
        blockNumber: 120n,
        transactionIndex: 2,
        logIndex: 3,
      }),
    ];

    const deltaResult = await indexFamePoolStates({
      client: deltaClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayMaintenanceMode: "steady-state",
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:01:00.000Z"),
    });

    expect(deltaResult).toMatchObject({
      clReplaySnapshots: 0,
      clReplayMaintenanceMetrics: [
        {
          poolId: replayPool.id,
          status: "trusted",
          fromBlock: 119,
          toBlock: 121,
          scannedLogCount: 1,
          appliedEventCount: 1,
          candidateWritten: true,
        },
      ],
    });
    expect(db.getLatestClReplay(replayPool)).toMatchObject({
      tick: 101,
      liquidity: "1234",
      observedThroughBlock: 121,
    });
    expect(db.getLatestClReplayMaintenance(replayPool)).toMatchObject({
      status: "trusted",
      cursorBlock: 121,
      reason: null,
    });
  });

  test("checkpoint promotion seeds maintenance from a fresh snapshot when a legacy replay pointer has no maintenance row", async () => {
    const replayPool = clReplayPool();
    const registry = registryWithPools([replayPool]);
    const db = new InMemoryPoolStateDb();

    await putLatestClReplayState({
      db,
      tableName: "PoolState",
      rows: clReplayStateRowsFromSnapshot({
        pool: replayPool,
        sqrtPriceX96: 2n ** 96n,
        tick: 199_800,
        liquidity: 500n,
        fee: 100n,
        observedThroughBlock: 110,
        blockHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        parentHash:
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        snapshotId: "legacy-110",
        stateHash:
          "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        sourceRegistryId: sourceRegistryIdFor(registry.source),
        updatedAt: "2026-05-20T00:00:00.000Z",
        bitmapWords: [{ wordPosition: 7, bitmap: 1n << 206n }],
        initializedTicks: [
          { tick: 199_800, liquidityGross: 10n, liquidityNet: 10n },
        ],
      }),
    });

    const checkpointClient = new FakePoolStateClient([], 120n);
    checkpointClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 207n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      providerReadCount: 5,
      durationMs: 12,
    });

    const result = await indexFamePoolStates({
      client: checkpointClient,
      db,
      tableName: "PoolState",
      registry,
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:01:00.000Z"),
    });

    expect(result.clReplayMaintenanceMetrics).toMatchObject([
      {
        poolId: replayPool.id,
        status: "trusted",
        reason: null,
        fromBlock: 118,
        toBlock: 118,
        scannedLogCount: 0,
        appliedEventCount: 0,
        candidateWritten: true,
      },
    ]);
    expect(db.getLatestClReplayMaintenance(replayPool)).toMatchObject({
      status: "trusted",
      reason: null,
      cursorBlock: 118,
    });
    expect(db.getLatestClReplay(replayPool)).toMatchObject({
      tick: 199_900,
      liquidity: "1000",
      observedThroughBlock: 118,
    });
  });

  test("keeps checkpoint trust when the dynamic fee changes without liquidity drift", async () => {
    const replayPool = clReplayPool();
    const db = new InMemoryPoolStateDb();
    const seedClient = new FakePoolStateClient([], 120n);
    seedClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 60n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 207n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      providerReadCount: 5,
      durationMs: 12,
    });

    await indexFamePoolStates({
      client: seedClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    const checkpointClient = new FakePoolStateClient([], 123n);
    checkpointClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 712n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 207n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      providerReadCount: 5,
      durationMs: 12,
    });

    const result = await indexFamePoolStates({
      client: checkpointClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:01:00.000Z"),
    });

    expect(result.clReplayMaintenanceMetrics).toMatchObject([
      {
        poolId: replayPool.id,
        status: "trusted",
        reason: null,
        fromBlock: 119,
        toBlock: 121,
        scannedLogCount: 0,
        appliedEventCount: 0,
        candidateWritten: true,
      },
    ]);
    expect(db.getLatestClReplay(replayPool)).toMatchObject({
      fee: "712",
      observedThroughBlock: 121,
    });
  });

  test("steady-state refreshes dynamic fee without full replay snapshots", async () => {
    const replayPool = clReplayPool();
    const db = new InMemoryPoolStateDb();
    const seedClient = new FakePoolStateClient([], 120n);
    seedClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 60n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 207n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      providerReadCount: 5,
      durationMs: 12,
    });

    await indexFamePoolStates({
      client: seedClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    const deltaClient = new FakePoolStateClient([], 123n);
    deltaClient.clReplayFeesByPoolId.set(replayPool.id, 712n);

    const result = await indexFamePoolStates({
      client: deltaClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayMaintenanceMode: "steady-state",
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:01:00.000Z"),
    });

    expect(result).toMatchObject({
      clReplaySnapshots: 0,
      clReplayMaintenanceMetrics: [
        {
          poolId: replayPool.id,
          status: "trusted",
          reason: null,
          fromBlock: 119,
          toBlock: 121,
          scannedLogCount: 0,
          appliedEventCount: 0,
          candidateWritten: true,
        },
      ],
    });
    expect(db.getLatestClReplay(replayPool)).toMatchObject({
      fee: "712",
      observedThroughBlock: 121,
    });
  });

  test("marks checkpoint drift failed and repairs from a complete snapshot", async () => {
    const replayPool = clReplayPool();
    const db = new InMemoryPoolStateDb();
    const seedClient = new FakePoolStateClient([], 120n);
    seedClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 1_000n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 207n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      providerReadCount: 5,
      durationMs: 12,
    });

    await indexFamePoolStates({
      client: seedClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    const checkpointClient = new FakePoolStateClient([], 120n);
    checkpointClient.clReplaySnapshotsByPoolId.set(replayPool.id, {
      sqrtPriceX96: 2n ** 96n,
      tick: 199_900,
      liquidity: 2_000n,
      fee: 100n,
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      parentHash:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      bitmapWords: [{ wordPosition: 7, bitmap: 1n << 207n }],
      initializedTicks: [
        { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      ],
      providerReadCount: 5,
      durationMs: 12,
    });

    const driftResult = await indexFamePoolStates({
      client: checkpointClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:01:00.000Z"),
    });

    expect(driftResult.clReplayMaintenanceMetrics).toMatchObject([
      {
        poolId: replayPool.id,
        status: "drift-failed",
        reason: "checkpoint-state-hash-mismatch",
      },
    ]);
    expect(db.getLatestClReplayMaintenance(replayPool)).toMatchObject({
      status: "drift-failed",
    });

    const repairResult = await indexFamePoolStates({
      client: checkpointClient,
      db,
      tableName: "PoolState",
      registry: registryWithPools([replayPool]),
      clReplayMaintenanceMode: "repair",
      clReplayTrustPromotion: true,
      now: new Date("2026-05-20T00:02:00.000Z"),
    });

    expect(repairResult.clReplayMaintenanceMetrics).toMatchObject([
      {
        poolId: replayPool.id,
        status: "trusted",
        reason: null,
      },
    ]);
    expect(db.getLatestClReplay(replayPool)).toMatchObject({
      liquidity: "2000",
    });
    expect(db.getLatestClReplayMaintenance(replayPool)).toMatchObject({
      status: "trusted",
      reason: null,
    });
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

  test("redacts dependency diagnostics from CL head and replay failures", async () => {
    const failedClPool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const replayPool = clReplayPool();
    const db = new InMemoryPoolStateDb();
    const client = new FakePoolStateClient([], 120n);
    client.failingClHeadPoolId = failedClPool.id;
    client.failingClReplayPoolId = replayPool.id;
    client.failingClHeadError = new Error(
      'RPC failed.\nrequest body {"authorization":"Bearer unit-token"}\nhttps://unit:secret@example.invalid/base',
    );
    client.failingClReplayError = new Error(
      'raw response {"access_token":"super-secret"}\nURL: https://example.invalid/super-secret\nbearer abc.def',
    );

    const result = await indexFamePoolStates({
      client,
      db,
      tableName: "PoolState",
      registry: registryWithPools([failedClPool, replayPool]),
      now: new Date("2026-05-20T00:00:00.000Z"),
    });

    const serialized = JSON.stringify({
      clHeadFailures: result.clHeadFailures,
      clReplayFailures: result.clReplayFailures,
    });
    expect(serialized).not.toMatch(
      /unit-token|super-secret|unit:secret|request body|raw response|authorization|access_token|abc\.def/i,
    );
    expect(result.clHeadFailures[0]?.message).toBe("RPC failed.");
    expect(result.clReplayFailures[0]?.message).toContain("[redacted-url]");
    expect(() => assertNoClReplaySnapshotFailures(result)).toThrow(
      /\[redacted-url\]/,
    );
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
        v4ClReplayFailedPools: 0,
        v4ClReplayFailures: [],
      }),
    ).toThrow(FameClReplaySnapshotIndexingError);
  });

  test("throws an operational error when required V4 replay snapshots fail", () => {
    expect(() =>
      assertNoClReplaySnapshotFailures({
        clReplayFailedPools: 0,
        clReplayFailures: [],
        v4ClReplayFailedPools: 1,
        v4ClReplayFailures: [
          {
            poolId: "uniswap-v4-basedflick-zora",
            message: "V4 replay read failed",
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
