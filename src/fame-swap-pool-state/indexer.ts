import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import {
  Uint256ReserveSyncEvent,
  UniswapV2PairReserveAbi,
  UniswapV2SyncEvent,
} from "../events.ts";
import type { baseClient } from "../viem.ts";
import {
  batchGetLatestClHeadStates,
  batchGetLatestClReplayMaintenanceStates,
  batchGetLatestClReplayStates,
  batchGetLatestPoolStates,
  clReplayCandidateStateRowsFromSnapshot,
  clReplayStateRowsFromSnapshot,
  getPoolStateCursor,
  latestClHeadStateFromSnapshot,
  latestClReplayMaintenanceStateKey,
  latestStateFromReserves,
  markPoolObservedThroughBlock,
  putLatestClReplayCandidateState,
  putLatestClReplayMaintenanceState,
  putLatestClReplayState,
  putLatestClHeadState,
  putLatestPoolState,
  setPoolStateCursor,
  sourceRegistryIdFor,
  type FameClHeadSnapshotRegistryEntry,
  type FameClHeadSource,
  type FameClReplayRegistryEntry,
  type FameClReplayMaintenanceState,
  type FameClReplayStateCapsule,
  type FameClReplayStateRows,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
} from "./types.ts";

type QuoteModelPool = FamePoolStateRegistryEntry & { poolAddress: Address };
type ClHeadPool = FameClHeadSnapshotRegistryEntry;
type ClReplayPool = FameClReplayRegistryEntry;
type FamePoolStateSyncEventKind = "uint112-reserves" | "uint256-reserves";

const CL_MIN_TICK = -887_272;
const CL_MAX_TICK = 887_272;
const CL_TICK_BITMAP_WORD_SIZE = 256;
const CL_REPLAY_PROVIDER_READ_BATCH_SIZE = 4;
const RPC_GET_LOGS_BLOCK_RANGE = 10n;

const SlipstreamSlot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

const UniswapV3Slot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

const ConcentratedPoolLiquidityAbi = [
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

const SlipstreamFeeAbi = [
  {
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "fee", type: "uint24" }],
  },
] as const;

export const ClReplaySwapEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: true },
    { name: "amount0", type: "int256", indexed: false },
    { name: "amount1", type: "int256", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
  name: "Swap",
} as const;

export const ClReplayMintEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    { name: "sender", type: "address", indexed: false },
    { name: "owner", type: "address", indexed: true },
    { name: "tickLower", type: "int24", indexed: true },
    { name: "tickUpper", type: "int24", indexed: true },
    { name: "amount", type: "uint128", indexed: false },
    { name: "amount0", type: "uint256", indexed: false },
    { name: "amount1", type: "uint256", indexed: false },
  ],
  name: "Mint",
} as const;

export const ClReplayBurnEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    { name: "owner", type: "address", indexed: true },
    { name: "tickLower", type: "int24", indexed: true },
    { name: "tickUpper", type: "int24", indexed: true },
    { name: "amount", type: "uint128", indexed: false },
    { name: "amount0", type: "uint256", indexed: false },
    { name: "amount1", type: "uint256", indexed: false },
  ],
  name: "Burn",
} as const;

export const ClReplayCollectEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    { name: "owner", type: "address", indexed: true },
    { name: "recipient", type: "address", indexed: false },
    { name: "tickLower", type: "int24", indexed: true },
    { name: "tickUpper", type: "int24", indexed: true },
    { name: "amount0", type: "uint128", indexed: false },
    { name: "amount1", type: "uint128", indexed: false },
  ],
  name: "Collect",
} as const;

const CL_REPLAY_SWAP_TOPIC = toEventSelector(
  "Swap(address,address,int256,int256,uint160,uint128,int24)",
);
const CL_REPLAY_MINT_TOPIC = toEventSelector(
  "Mint(address,address,int24,int24,uint128,uint256,uint256)",
);
const CL_REPLAY_BURN_TOPIC = toEventSelector(
  "Burn(address,int24,int24,uint128,uint256,uint256)",
);
const CL_REPLAY_COLLECT_TOPIC = toEventSelector(
  "Collect(address,address,int24,int24,uint128,uint128)",
);

const SlipstreamTickBitmapAbi = [
  {
    type: "function",
    name: "tickBitmap",
    stateMutability: "view",
    inputs: [{ name: "wordPosition", type: "int16" }],
    outputs: [{ name: "bitmap", type: "uint256" }],
  },
] as const;

export const SlipstreamTicksAbi = [
  {
    type: "function",
    name: "ticks",
    stateMutability: "view",
    inputs: [{ name: "tick", type: "int24" }],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "stakedLiquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "rewardGrowthOutsideX128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
  },
] as const;

const UniswapV4StateViewSlot0Abi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

const UniswapV4StateViewLiquidityAbi = [
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

export interface FamePoolStateSyncLog {
  address: Address;
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  transactionHash: Hex;
  args: {
    reserve0: bigint;
    reserve1: bigint;
  };
}

export interface FameClReplayRawLog {
  address: Address;
  blockNumber: bigint;
  blockHash: Hex | null;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  removed: boolean;
  topics: readonly Hex[];
  data: Hex;
}

export interface FameClReplayEventBase {
  poolId: string;
  venue: ClReplayPool["venue"];
  poolAddress: Address;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
}

export type FameClReplayNormalizedEvent =
  | (FameClReplayEventBase & {
      kind: "swap";
      sqrtPriceX96: bigint;
      tick: number;
      liquidity: bigint;
    })
  | (FameClReplayEventBase & {
      kind: "mint";
      tickLower: number;
      tickUpper: number;
      amount: bigint;
    })
  | (FameClReplayEventBase & {
      kind: "burn";
      tickLower: number;
      tickUpper: number;
      amount: bigint;
    })
  | (FameClReplayEventBase & {
      kind: "collect";
      tickLower: number;
      tickUpper: number;
    });

export type FameClReplayDeltaApplyResult =
  | {
      status: "candidate";
      rows: ReturnType<typeof clReplayCandidateStateRowsFromSnapshot>;
      appliedEventCount: number;
    }
  | {
      status: "warming" | "event-gap";
      reason: string;
      appliedEventCount: number;
    };

export class FameClReplayLogNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FameClReplayLogNormalizationError";
  }
}

export interface FamePoolStateIndexerClient {
  chain: {
    id: number;
  };
  getBlockNumber(): Promise<bigint>;
  getBlock(options: {
    blockNumber: bigint;
  }): Promise<{ hash: Hex | null; parentHash: Hex }>;
  getSyncLogs(options: {
    pools: readonly QuoteModelPool[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly FamePoolStateSyncLog[]>;
  getClReplayLogs(options: {
    pools: readonly ClReplayPool[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly FameClReplayRawLog[]>;
  getReserves(options: {
    poolAddress: Address;
    blockNumber: bigint;
  }): Promise<readonly [bigint, bigint, number]>;
  getClHeadSnapshot(options: {
    pool: ClHeadPool;
    blockNumber: bigint;
  }): Promise<FameClHeadSnapshotRead>;
  getClReplaySnapshot(options: {
    pool: ClReplayPool;
    blockNumber: bigint;
  }): Promise<FameClReplaySnapshotRead>;
}

export interface SlipstreamReplayReadClient {
  getBlock(options: {
    blockNumber: bigint;
  }): Promise<{ hash: Hex | null; parentHash: Hex }>;
  getSlot0(options: {
    poolAddress: Address;
    blockNumber: bigint;
  }): Promise<readonly [bigint, number, number, number, number, boolean]>;
  getLiquidity(options: {
    poolAddress: Address;
    blockNumber: bigint;
  }): Promise<bigint>;
  getFee(options: {
    poolAddress: Address;
    blockNumber: bigint;
  }): Promise<bigint | number>;
  getTickBitmap(options: {
    poolAddress: Address;
    wordPosition: number;
    blockNumber: bigint;
  }): Promise<bigint>;
  getTickBitmaps?(options: {
    poolAddress: Address;
    wordPositions: readonly number[];
    blockNumber: bigint;
  }): Promise<readonly FameClReplayBitmapWordRead[]>;
  getTick(options: {
    poolAddress: Address;
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
  >;
  getTicks?(options: {
    poolAddress: Address;
    ticks: readonly number[];
    blockNumber: bigint;
  }): Promise<
    readonly {
      tick: number;
      state: readonly [
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
      ];
    }[]
  >;
}

export interface FameClHeadSnapshotRead {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  source: FameClHeadSource;
}

export interface FameClReplayBitmapWordRead {
  wordPosition: number;
  bitmap: bigint;
}

export interface FameClReplayInitializedTickRead {
  tick: number;
  liquidityGross: bigint;
  liquidityNet: bigint;
}

export interface FameClReplaySnapshotRead {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  fee: bigint;
  blockHash: Hex;
  parentHash: Hex;
  bitmapWords: readonly FameClReplayBitmapWordRead[];
  initializedTicks: readonly FameClReplayInitializedTickRead[];
  providerReadCount: number;
  durationMs: number;
}

export interface FameClHeadSnapshotFailure {
  poolId: string;
  message: string;
}

export interface FameClReplaySnapshotFailure {
  poolId: string;
  message: string;
}

export interface FameClReplaySnapshotMetric {
  poolId: string;
  bitmapWordCount: number;
  initializedTickCount: number;
  bitmapChunkCount: number;
  tickChunkCount: number;
  providerReadCount: number;
  durationMs: number;
  stateHash: Hex;
}

export interface FameClReplayMaintenanceMetric {
  poolId: string;
  status: "trusted" | "warming" | "drift-failed" | "repairing" | "event-gap";
  reason: string | null;
  fromBlock: number;
  toBlock: number;
  scannedLogCount: number;
  appliedEventCount: number;
  candidateWritten: boolean;
  stateHash: Hex | null;
}

export type FameClReplayMaintenanceMode =
  | "checkpoint"
  | "steady-state"
  | "repair";

export interface FamePoolStateIndexerResult {
  chainId: number;
  durationMs: number;
  fromBlock: number;
  observedThroughBlock: number;
  syncEvents: number;
  writtenEvents: number;
  ignoredEvents: number;
  seededPools: number;
  reconciledPools: number;
  observedPools: number;
  clHeadSnapshots: number;
  clHeadWrittenPools: number;
  clHeadFailedPools: number;
  clHeadFailures: FameClHeadSnapshotFailure[];
  clReplaySnapshots: number;
  clReplayWrittenPools: number;
  clReplayFailedPools: number;
  clReplayFailures: FameClReplaySnapshotFailure[];
  clReplayMetrics: FameClReplaySnapshotMetric[];
  clReplayMaintenanceMetrics: FameClReplayMaintenanceMetric[];
  sourceRegistryId: string;
}

export class FameClReplaySnapshotIndexingError extends Error {
  constructor(failures: readonly FameClReplaySnapshotFailure[]) {
    super(
      `CL replay snapshot failed for ${failures
        .map((failure) => `${failure.poolId}: ${failure.message}`)
        .join("; ")}`,
    );
    this.name = "FameClReplaySnapshotIndexingError";
  }
}

export function assertNoClReplaySnapshotFailures(
  result: Pick<
    FamePoolStateIndexerResult,
    "clReplayFailedPools" | "clReplayFailures"
  >,
): void {
  if (result.clReplayFailedPools > 0) {
    throw new FameClReplaySnapshotIndexingError(result.clReplayFailures);
  }
}

function quoteModelPools(
  registry: FamePoolStateRegistryFile,
): QuoteModelPool[] {
  return registry.pools.filter(
    (pool): pool is QuoteModelPool =>
      pool.capability === "quote-model" && pool.poolAddress !== null,
  );
}

function clHeadPools(registry: FamePoolStateRegistryFile): ClHeadPool[] {
  return registry.pools.filter(
    (pool): pool is ClHeadPool =>
      pool.stateSurface === "cl-head-snapshot" && pool.tickSpacing !== null,
  );
}

function clReplayPools(registry: FamePoolStateRegistryFile): ClReplayPool[] {
  return registry.pools.filter(
    (pool): pool is ClReplayPool =>
      pool.replaySurface === "cl-replay-v1" &&
      pool.stateSurface === "cl-head-snapshot" &&
      pool.tickSpacing !== null &&
      pool.poolAddress !== null &&
      pool.venue === "aerodrome-slipstream",
  );
}

function syncEventKind(pool: QuoteModelPool): FamePoolStateSyncEventKind {
  if (pool.venue === "uniswap-v2") return "uint112-reserves";
  if (pool.venue === "solidly" || pool.venue === "aerodrome-v2") {
    return "uint256-reserves";
  }
  throw new Error(`${pool.id} has no supported Sync event kind.`);
}

function addressKey(address: Address): string {
  return address.toLowerCase();
}

function safeNumber(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} exceeds Number.MAX_SAFE_INTEGER.`);
  }
  return Number(value);
}

function safeHeadBlock(
  latestBlock: bigint,
  confirmationBlocks: number,
): bigint {
  const confirmations = BigInt(confirmationBlocks);
  return latestBlock > confirmations
    ? latestBlock - confirmations
    : latestBlock;
}

function boundedBlockRanges({
  fromBlock,
  toBlock,
  maxRange,
}: {
  fromBlock: bigint;
  toBlock: bigint;
  maxRange: bigint;
}): { fromBlock: bigint; toBlock: bigint }[] {
  if (maxRange <= 0n) throw new Error("maxRange must be positive.");
  if (fromBlock > toBlock) return [];
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  let nextFromBlock = fromBlock;
  while (nextFromBlock <= toBlock) {
    const nextToBlock =
      nextFromBlock + maxRange - 1n < toBlock
        ? nextFromBlock + maxRange - 1n
        : toBlock;
    ranges.push({ fromBlock: nextFromBlock, toBlock: nextToBlock });
    nextFromBlock = nextToBlock + 1n;
  }
  return ranges;
}

function requirePoolAddress(pool: ClHeadPool): Address {
  if (pool.poolAddress === null) {
    throw new Error(`${pool.id} must have a poolAddress for pool head reads.`);
  }
  return pool.poolAddress;
}

function requirePoolKey(pool: ClHeadPool): Hex {
  if (pool.poolKey === null) {
    throw new Error(`${pool.id} must have a poolKey for V4 head reads.`);
  }
  return pool.poolKey;
}

function requireStateViewAddress(pool: ClHeadPool): Address {
  if (pool.stateViewAddress === null) {
    throw new Error(
      `${pool.id} must have a StateView address for V4 head reads.`,
    );
  }
  return pool.stateViewAddress;
}

function floorDiv(left: number, right: number): number {
  return Math.floor(left / right);
}

function tickBitmapWordPositions(tickSpacing: number): number[] {
  if (!Number.isSafeInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("CL replay tickSpacing must be a positive safe integer.");
  }
  const minCompressedTick = Math.ceil(CL_MIN_TICK / tickSpacing);
  const maxCompressedTick = Math.floor(CL_MAX_TICK / tickSpacing);
  const minWord = floorDiv(minCompressedTick, CL_TICK_BITMAP_WORD_SIZE);
  const maxWord = floorDiv(maxCompressedTick, CL_TICK_BITMAP_WORD_SIZE);
  return Array.from(
    { length: maxWord - minWord + 1 },
    (_, index) => minWord + index,
  );
}

function initializedTicksForBitmapWord({
  wordPosition,
  bitmap,
  tickSpacing,
}: {
  wordPosition: number;
  bitmap: bigint;
  tickSpacing: number;
}): number[] {
  const ticks: number[] = [];
  for (let bit = 0; bit < CL_TICK_BITMAP_WORD_SIZE; bit += 1) {
    if (((bitmap >> BigInt(bit)) & 1n) === 0n) continue;
    const compressedTick = wordPosition * CL_TICK_BITMAP_WORD_SIZE + bit;
    const tick = compressedTick * tickSpacing;
    if (tick >= CL_MIN_TICK && tick <= CL_MAX_TICK) ticks.push(tick);
  }
  return ticks;
}

async function mapInBatches<Input, Output>(
  values: readonly Input[],
  batchSize: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const outputs: Output[] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    outputs.push(
      ...(await Promise.all(
        values.slice(index, index + batchSize).map(mapper),
      )),
    );
  }
  return outputs;
}

function chunkArray<T>(values: readonly T[], chunkSize: number): T[][] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive safe integer.");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push([...values.slice(index, index + chunkSize)]);
  }
  return chunks;
}

function clReplaySnapshotId({
  poolId,
  observedThroughBlock,
  blockHash,
  sourceRegistryId,
}: {
  poolId: string;
  observedThroughBlock: number;
  blockHash: Hex;
  sourceRegistryId: string;
}): string {
  return `cl-replay-v1:${poolId}:${observedThroughBlock.toString()}:${blockHash}:${sourceRegistryId}`;
}

function clReplayStateHash({
  snapshot,
  observedThroughBlock,
}: {
  snapshot: FameClReplaySnapshotRead;
  observedThroughBlock: number;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "sqrtPriceX96", type: "uint160" },
        { name: "tick", type: "int24" },
        { name: "liquidity", type: "uint128" },
        { name: "fee", type: "uint24" },
        { name: "observedThroughBlock", type: "uint256" },
        { name: "blockHash", type: "bytes32" },
        { name: "parentHash", type: "bytes32" },
        {
          name: "bitmapWords",
          type: "tuple[]",
          components: [
            { name: "wordPosition", type: "int16" },
            { name: "bitmap", type: "uint256" },
          ],
        },
        {
          name: "initializedTicks",
          type: "tuple[]",
          components: [
            { name: "tick", type: "int24" },
            { name: "liquidityGross", type: "uint128" },
            { name: "liquidityNet", type: "int128" },
          ],
        },
      ],
      [
        snapshot.sqrtPriceX96,
        snapshot.tick,
        snapshot.liquidity,
        safeNumber(snapshot.fee, "CL replay fee"),
        BigInt(observedThroughBlock),
        snapshot.blockHash,
        snapshot.parentHash,
        snapshot.bitmapWords.map((word) => ({
          wordPosition: word.wordPosition,
          bitmap: word.bitmap,
        })),
        snapshot.initializedTicks.map((tick) => ({
          tick: tick.tick,
          liquidityGross: tick.liquidityGross,
          liquidityNet: tick.liquidityNet,
        })),
      ],
    ),
  );
}

function clReplayRowsFromSnapshot({
  pool,
  snapshot,
  observedThroughBlock,
  sourceRegistryId,
  updatedAt,
}: {
  pool: ClReplayPool;
  snapshot: FameClReplaySnapshotRead;
  observedThroughBlock: number;
  sourceRegistryId: string;
  updatedAt: string;
}): FameClReplayStateRows {
  return clReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: snapshot.sqrtPriceX96,
    tick: snapshot.tick,
    liquidity: snapshot.liquidity,
    fee: snapshot.fee,
    observedThroughBlock,
    blockHash: snapshot.blockHash,
    parentHash: snapshot.parentHash,
    snapshotId: clReplaySnapshotId({
      poolId: pool.id,
      observedThroughBlock,
      blockHash: snapshot.blockHash,
      sourceRegistryId,
    }),
    stateHash: clReplayStateHash({ snapshot, observedThroughBlock }),
    sourceRegistryId,
    updatedAt,
    bitmapWords: snapshot.bitmapWords,
    initializedTicks: snapshot.initializedTicks,
  });
}

function clReplayCapsuleFromRows(
  rows: FameClReplayStateRows,
): FameClReplayStateCapsule {
  return {
    latest: rows.latest,
    bitmapWords: rows.bitmapChunks.flatMap((chunk) => chunk.bitmapWords),
    initializedTicks: rows.tickChunks.flatMap((chunk) => chunk.initializedTicks),
  };
}

function clReplayRowsFromCandidateRows({
  pool,
  rows,
}: {
  pool: ClReplayPool;
  rows: ReturnType<typeof clReplayCandidateStateRowsFromSnapshot>;
}): FameClReplayStateRows {
  return clReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: BigInt(rows.latest.sqrtPriceX96),
    tick: rows.latest.tick,
    liquidity: BigInt(rows.latest.liquidity),
    fee: BigInt(rows.latest.fee),
    observedThroughBlock: rows.latest.observedThroughBlock,
    blockHash: rows.latest.blockHash,
    parentHash: rows.latest.parentHash,
    snapshotId: `cl-replay-v1:${pool.id}:${rows.latest.observedThroughBlock.toString()}:${rows.latest.blockHash}:${rows.latest.sourceRegistryId}`,
    stateHash: rows.latest.stateHash,
    sourceRegistryId: rows.latest.sourceRegistryId,
    updatedAt: rows.latest.updatedAt,
    bitmapWords: rows.bitmapChunks.flatMap((chunk) =>
      chunk.bitmapWords.map((word) => ({
        wordPosition: word.wordPosition,
        bitmap: BigInt(word.bitmap),
      })),
    ),
    initializedTicks: rows.tickChunks.flatMap((chunk) =>
      chunk.initializedTicks.map((tick) => ({
        tick: tick.tick,
        liquidityGross: BigInt(tick.liquidityGross),
        liquidityNet: BigInt(tick.liquidityNet),
      })),
    ),
  });
}

function clReplayMaintenanceMatchesLatest({
  maintenance,
  latest,
  sourceRegistryId,
}: {
  maintenance: FameClReplayMaintenanceState | null;
  latest: FameClReplayStateCapsule | null;
  sourceRegistryId: string;
}): boolean {
  return (
    maintenance !== null &&
    latest !== null &&
    maintenance.status === "trusted" &&
    maintenance.sourceRegistryId === sourceRegistryId &&
    latest.latest.sourceRegistryId === sourceRegistryId &&
    maintenance.cursorBlock === latest.latest.observedThroughBlock &&
    maintenance.cursorBlockHash === latest.latest.blockHash &&
    maintenance.stateHash === latest.latest.stateHash
  );
}

async function readBlockIdentity({
  client,
  blockNumber,
}: {
  client: FamePoolStateIndexerClient;
  blockNumber: number;
}): Promise<{ blockHash: Hex; parentHash: Hex }> {
  const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
  if (block.hash === null) {
    throw new Error(`Block ${blockNumber.toString()} has no hash.`);
  }
  return { blockHash: block.hash, parentHash: block.parentHash };
}

function sortedLogs(
  logs: readonly FamePoolStateSyncLog[],
): FamePoolStateSyncLog[] {
  return [...logs].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber < right.blockNumber ? -1 : 1;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex;
    }
    return left.logIndex - right.logIndex;
  });
}

function sortedReplayLogs(
  logs: readonly FameClReplayRawLog[],
): FameClReplayRawLog[] {
  return [...logs].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber < right.blockNumber ? -1 : 1;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex;
    }
    return left.logIndex - right.logIndex;
  });
}

function baseReplayEvent({
  pool,
  log,
}: {
  pool: ClReplayPool;
  log: FameClReplayRawLog;
}): FameClReplayEventBase {
  if (log.blockHash === null) {
    throw new FameClReplayLogNormalizationError(
      `${pool.id} replay log is missing block hash.`,
    );
  }
  return {
    poolId: pool.id,
    venue: pool.venue,
    poolAddress: pool.poolAddress,
    blockNumber: safeNumber(log.blockNumber, "CL replay log block number"),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  };
}

function replayLogTopics(log: FameClReplayRawLog): [Hex, ...Hex[]] {
  const [topic0, ...topics] = log.topics;
  if (!topic0) {
    throw new FameClReplayLogNormalizationError(
      "CL replay log is missing topic0.",
    );
  }
  return [topic0, ...topics];
}

function decodeClReplayLog({
  pool,
  log,
}: {
  pool: ClReplayPool;
  log: FameClReplayRawLog;
}): FameClReplayNormalizedEvent {
  if (log.removed) {
    throw new FameClReplayLogNormalizationError(
      `${pool.id} replay log was removed.`,
    );
  }
  if (addressKey(log.address) !== addressKey(pool.poolAddress)) {
    throw new FameClReplayLogNormalizationError(
      `Replay log address does not match ${pool.id}.`,
    );
  }
  const topics = replayLogTopics(log);
  const topic = topics[0];

  const base = baseReplayEvent({ pool, log });
  if (topic === CL_REPLAY_SWAP_TOPIC) {
    const decoded = decodeEventLog({
      abi: [ClReplaySwapEventAbi],
      eventName: "Swap",
      topics,
      data: log.data,
      strict: true,
    });
    return {
      ...base,
      kind: "swap",
      sqrtPriceX96: decoded.args.sqrtPriceX96,
      tick: decoded.args.tick,
      liquidity: decoded.args.liquidity,
    };
  }
  if (topic === CL_REPLAY_MINT_TOPIC) {
    const decoded = decodeEventLog({
      abi: [ClReplayMintEventAbi],
      eventName: "Mint",
      topics,
      data: log.data,
      strict: true,
    });
    return {
      ...base,
      kind: "mint",
      tickLower: decoded.args.tickLower,
      tickUpper: decoded.args.tickUpper,
      amount: decoded.args.amount,
    };
  }
  if (topic === CL_REPLAY_BURN_TOPIC) {
    const decoded = decodeEventLog({
      abi: [ClReplayBurnEventAbi],
      eventName: "Burn",
      topics,
      data: log.data,
      strict: true,
    });
    return {
      ...base,
      kind: "burn",
      tickLower: decoded.args.tickLower,
      tickUpper: decoded.args.tickUpper,
      amount: decoded.args.amount,
    };
  }
  if (topic === CL_REPLAY_COLLECT_TOPIC) {
    const decoded = decodeEventLog({
      abi: [ClReplayCollectEventAbi],
      eventName: "Collect",
      topics,
      data: log.data,
      strict: true,
    });
    return {
      ...base,
      kind: "collect",
      tickLower: decoded.args.tickLower,
      tickUpper: decoded.args.tickUpper,
    };
  }

  throw new FameClReplayLogNormalizationError(
    `${pool.id} replay log has unsupported topic ${topic}.`,
  );
}

export function normalizeClReplayLogs({
  pool,
  logs,
}: {
  pool: ClReplayPool;
  logs: readonly FameClReplayRawLog[];
}): FameClReplayNormalizedEvent[] {
  return sortedReplayLogs(logs).map((log) => decodeClReplayLog({ pool, log }));
}

function assertTickAligned({
  tick,
  tickSpacing,
}: {
  tick: number;
  tickSpacing: number;
}): void {
  if (tick % tickSpacing !== 0) {
    throw new Error(
      `CL replay tick ${tick.toString()} is not aligned to spacing ${tickSpacing.toString()}.`,
    );
  }
}

function bitmapWordsFromInitializedTicks({
  ticks,
  tickSpacing,
}: {
  ticks: readonly number[];
  tickSpacing: number;
}): { wordPosition: number; bitmap: bigint }[] {
  const words = new Map<number, bigint>();
  for (const tick of ticks) {
    assertTickAligned({ tick, tickSpacing });
    const compressedTick = tick / tickSpacing;
    const wordPosition = floorDiv(compressedTick, CL_TICK_BITMAP_WORD_SIZE);
    const bit = compressedTick - wordPosition * CL_TICK_BITMAP_WORD_SIZE;
    const current = words.get(wordPosition) ?? 0n;
    words.set(wordPosition, current | (1n << BigInt(bit)));
  }
  return [...words.entries()]
    .sort(([left], [right]) => left - right)
    .map(([wordPosition, bitmap]) => ({ wordPosition, bitmap }));
}

function orderedReplayEvents(
  events: readonly FameClReplayNormalizedEvent[],
): FameClReplayNormalizedEvent[] {
  return [...events].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber - right.blockNumber;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex;
    }
    return left.logIndex - right.logIndex;
  });
}

function currentTickInRange({
  currentTick,
  tickLower,
  tickUpper,
}: {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
}): boolean {
  return currentTick >= tickLower && currentTick < tickUpper;
}

function applyLiquidityDelta({
  tickStates,
  tick,
  grossDelta,
  netDelta,
}: {
  tickStates: Map<number, { liquidityGross: bigint; liquidityNet: bigint }>;
  tick: number;
  grossDelta: bigint;
  netDelta: bigint;
}): "applied" | "underflow" {
  const current = tickStates.get(tick) ?? {
    liquidityGross: 0n,
    liquidityNet: 0n,
  };
  const liquidityGross = current.liquidityGross + grossDelta;
  if (liquidityGross < 0n) return "underflow";
  const liquidityNet = current.liquidityNet + netDelta;
  if (liquidityGross === 0n) {
    if (liquidityNet !== 0n) return "underflow";
    tickStates.delete(tick);
  } else {
    tickStates.set(tick, { liquidityGross, liquidityNet });
  }
  return "applied";
}

export function applyClReplayDeltas({
  pool,
  seed,
  events,
  observedThroughBlock,
  blockHash,
  parentHash,
  candidateId,
  sourceRegistryId,
  updatedAt,
}: {
  pool: ClReplayPool;
  seed: FameClReplayStateCapsule | null;
  events: readonly FameClReplayNormalizedEvent[];
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  candidateId: string;
  sourceRegistryId: string;
  updatedAt: string;
}): FameClReplayDeltaApplyResult {
  if (seed === null) {
    return {
      status: "warming",
      reason: "seed-required",
      appliedEventCount: 0,
    };
  }
  if (seed.latest.sourceRegistryId !== sourceRegistryId) {
    return {
      status: "warming",
      reason: "source-registry-mismatch",
      appliedEventCount: 0,
    };
  }

  let sqrtPriceX96 = BigInt(seed.latest.sqrtPriceX96);
  let tick = seed.latest.tick;
  let liquidity = BigInt(seed.latest.liquidity);
  const fee = BigInt(seed.latest.fee);
  const tickStates = new Map(
    seed.initializedTicks.map((initializedTick) => [
      initializedTick.tick,
      {
        liquidityGross: BigInt(initializedTick.liquidityGross),
        liquidityNet: BigInt(initializedTick.liquidityNet),
      },
    ]),
  );
  let appliedEventCount = 0;

  for (const event of orderedReplayEvents(events)) {
    if (event.poolId !== pool.id) {
      return {
        status: "event-gap",
        reason: "pool-mismatch",
        appliedEventCount,
      };
    }

    if (event.kind === "swap") {
      sqrtPriceX96 = event.sqrtPriceX96;
      tick = event.tick;
      liquidity = event.liquidity;
      appliedEventCount += 1;
      continue;
    }

    if (event.kind === "collect") {
      continue;
    }

    if (event.tickLower >= event.tickUpper) {
      return {
        status: "event-gap",
        reason: "invalid-tick-range",
        appliedEventCount,
      };
    }
    try {
      assertTickAligned({ tick: event.tickLower, tickSpacing: pool.tickSpacing });
      assertTickAligned({ tick: event.tickUpper, tickSpacing: pool.tickSpacing });
    } catch {
      return {
        status: "event-gap",
        reason: "invalid-tick-spacing",
        appliedEventCount,
      };
    }

    const signedAmount = event.kind === "mint" ? event.amount : -event.amount;
    const lowerResult = applyLiquidityDelta({
      tickStates,
      tick: event.tickLower,
      grossDelta: signedAmount,
      netDelta: signedAmount,
    });
    const upperResult = applyLiquidityDelta({
      tickStates,
      tick: event.tickUpper,
      grossDelta: signedAmount,
      netDelta: -signedAmount,
    });
    if (lowerResult === "underflow" || upperResult === "underflow") {
      return {
        status: "event-gap",
        reason: "liquidity-underflow",
        appliedEventCount,
      };
    }
    if (
      currentTickInRange({
        currentTick: tick,
        tickLower: event.tickLower,
        tickUpper: event.tickUpper,
      })
    ) {
      liquidity += signedAmount;
      if (liquidity < 0n) {
        return {
          status: "event-gap",
          reason: "active-liquidity-underflow",
          appliedEventCount,
        };
      }
    }
    appliedEventCount += 1;
  }

  const initializedTicks = [...tickStates.entries()]
    .sort(([left], [right]) => left - right)
    .map(([initializedTick, state]) => ({
      tick: initializedTick,
      liquidityGross: state.liquidityGross,
      liquidityNet: state.liquidityNet,
    }));
  const bitmapWords = bitmapWordsFromInitializedTicks({
    ticks: initializedTicks.map((initializedTick) => initializedTick.tick),
    tickSpacing: pool.tickSpacing,
  });
  const snapshot = {
    sqrtPriceX96,
    tick,
    liquidity,
    fee,
    blockHash,
    parentHash,
    bitmapWords,
    initializedTicks,
    providerReadCount: 0,
    durationMs: 0,
  } satisfies FameClReplaySnapshotRead;

  return {
    status: "candidate",
    rows: clReplayCandidateStateRowsFromSnapshot({
      pool,
      sqrtPriceX96,
      tick,
      liquidity,
      fee,
      observedThroughBlock,
      blockHash,
      parentHash,
      candidateId,
      stateHash: clReplayStateHash({ snapshot, observedThroughBlock }),
      sourceRegistryId,
      updatedAt,
      bitmapWords,
      initializedTicks,
    }),
    appliedEventCount,
  };
}

function reservesDiffer(
  latest: { reserve0: string; reserve1: string } | null,
  reserve0: bigint,
  reserve1: bigint,
): boolean {
  return (
    latest === null ||
    latest.reserve0 !== reserve0.toString() ||
    latest.reserve1 !== reserve1.toString()
  );
}

function stateNeedsReconciliation({
  latest,
  pool,
  reserve0,
  reserve1,
  sourceRegistryId,
}: {
  latest: {
    poolId: string;
    reserve0: string;
    reserve1: string;
    sourceRegistryId: string;
  } | null;
  pool: QuoteModelPool;
  reserve0: bigint;
  reserve1: bigint;
  sourceRegistryId: string;
}): boolean {
  if (latest === null) return true;
  return (
    reservesDiffer(latest, reserve0, reserve1) ||
    latest.poolId !== pool.id ||
    latest.sourceRegistryId !== sourceRegistryId
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.split("\n", 1)[0] ?? "Unknown error";
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "Unknown error";
}

export async function getSlipstreamClReplaySnapshot({
  client,
  pool,
  blockNumber,
}: {
  client: SlipstreamReplayReadClient;
  pool: ClReplayPool;
  blockNumber: bigint;
}): Promise<FameClReplaySnapshotRead> {
  const startedAtMs = Date.now();
  const poolAddress = pool.poolAddress;
  const blockBefore = await client.getBlock({ blockNumber });
  if (blockBefore.hash === null) {
    throw new Error(`Block ${blockNumber.toString()} has no hash.`);
  }

  const [[sqrtPriceX96, tick], liquidity, fee] = await Promise.all([
    client.getSlot0({
      poolAddress,
      blockNumber,
    }),
    client.getLiquidity({
      poolAddress,
      blockNumber,
    }),
    client.getFee({
      poolAddress,
      blockNumber,
    }),
  ]);

  const wordPositions = tickBitmapWordPositions(pool.tickSpacing);
  const wordReads = client.getTickBitmaps
    ? (
        await mapInBatches(
          chunkArray(wordPositions, CL_REPLAY_PROVIDER_READ_BATCH_SIZE),
          1,
          (batch) =>
            client.getTickBitmaps
              ? client.getTickBitmaps({
                  poolAddress,
                  wordPositions: batch,
                  blockNumber,
                })
              : Promise.resolve([]),
        )
      ).flat()
    : await mapInBatches(
        wordPositions,
        CL_REPLAY_PROVIDER_READ_BATCH_SIZE,
        async (wordPosition) => ({
          wordPosition,
          bitmap: await client.getTickBitmap({
            poolAddress,
            wordPosition,
            blockNumber,
          }),
        }),
      );
  const bitmapWords = wordReads.filter((word) => word.bitmap !== 0n);
  const initializedTickIndexes = bitmapWords.flatMap((word) =>
    initializedTicksForBitmapWord({
      wordPosition: word.wordPosition,
      bitmap: word.bitmap,
      tickSpacing: pool.tickSpacing,
    }),
  );
  const initializedTicks = client.getTicks
    ? (
        await mapInBatches(
          chunkArray(
            initializedTickIndexes,
            CL_REPLAY_PROVIDER_READ_BATCH_SIZE,
          ),
          1,
          (batch) =>
            client.getTicks
              ? client.getTicks({ poolAddress, ticks: batch, blockNumber })
              : Promise.resolve([]),
        )
      )
        .flat()
        .map(({ tick: initializedTick, state }) => {
          const [liquidityGross, liquidityNet, , , , , , , , initialized] =
            state;
          if (!initialized) {
            throw new Error(
              `Tick bitmap marked ${initializedTick.toString()} initialized but ticks() did not.`,
            );
          }
          return {
            tick: initializedTick,
            liquidityGross,
            liquidityNet,
          };
        })
    : await mapInBatches(
        initializedTickIndexes,
        CL_REPLAY_PROVIDER_READ_BATCH_SIZE,
        async (initializedTick) => {
          const [liquidityGross, liquidityNet, , , , , , , , initialized] =
            await client.getTick({
              poolAddress,
              tick: initializedTick,
              blockNumber,
            });
          if (!initialized) {
            throw new Error(
              `Tick bitmap marked ${initializedTick.toString()} initialized but ticks() did not.`,
            );
          }
          return {
            tick: initializedTick,
            liquidityGross,
            liquidityNet,
          };
        },
      );

  const blockAfter = await client.getBlock({ blockNumber });
  if (
    blockAfter.hash !== blockBefore.hash ||
    blockAfter.parentHash !== blockBefore.parentHash
  ) {
    throw new Error(
      `Block identity changed while reading ${pool.id} replay snapshot.`,
    );
  }

  return {
    sqrtPriceX96,
    tick,
    liquidity,
    fee: BigInt(fee),
    blockHash: blockBefore.hash,
    parentHash: blockBefore.parentHash,
    bitmapWords,
    initializedTicks,
    providerReadCount:
      2 + 3 + wordPositions.length + initializedTickIndexes.length,
    durationMs: Date.now() - startedAtMs,
  };
}

export function createViemPoolStateIndexerClient(
  client: typeof baseClient,
): FamePoolStateIndexerClient {
  return {
    chain: {
      id: client.chain.id,
    },
    getBlockNumber() {
      return client.getBlockNumber();
    },
    getBlock(options) {
      return client.getBlock(options);
    },
    async getSyncLogs({ pools, fromBlock, toBlock }) {
      const uint112Addresses = pools
        .filter((pool) => syncEventKind(pool) === "uint112-reserves")
        .map((pool) => pool.poolAddress);
      const uint256Addresses = pools
        .filter((pool) => syncEventKind(pool) === "uint256-reserves")
        .map((pool) => pool.poolAddress);
      const logs: FamePoolStateSyncLog[] = [];
      for (const range of boundedBlockRanges({
        fromBlock,
        toBlock,
        maxRange: RPC_GET_LOGS_BLOCK_RANGE,
      })) {
        if (uint112Addresses.length > 0) {
          const uint112Logs = await client.getLogs({
            address: uint112Addresses,
            event: UniswapV2SyncEvent,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            strict: true,
          });
          logs.push(
            ...uint112Logs.map((log) => ({
              address: log.address,
              blockNumber: log.blockNumber,
              transactionIndex: log.transactionIndex,
              logIndex: log.logIndex,
              transactionHash: log.transactionHash,
              args: {
                reserve0: log.args.reserve0,
                reserve1: log.args.reserve1,
              },
            })),
          );
        }
        if (uint256Addresses.length > 0) {
          const uint256Logs = await client.getLogs({
            address: uint256Addresses,
            event: Uint256ReserveSyncEvent,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            strict: true,
          });
          logs.push(
            ...uint256Logs.map((log) => ({
              address: log.address,
              blockNumber: log.blockNumber,
              transactionIndex: log.transactionIndex,
              logIndex: log.logIndex,
              transactionHash: log.transactionHash,
              args: {
                reserve0: log.args.reserve0,
                reserve1: log.args.reserve1,
              },
            })),
          );
        }
      }
      return logs;
    },
    async getClReplayLogs({ pools, fromBlock, toBlock }) {
      if (pools.length === 0) return [];
      const logs: FameClReplayRawLog[] = [];
      for (const range of boundedBlockRanges({
        fromBlock,
        toBlock,
        maxRange: RPC_GET_LOGS_BLOCK_RANGE,
      })) {
        const rangeLogs = await client.getLogs({
          address: pools.map((pool) => pool.poolAddress),
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        });
        logs.push(
          ...rangeLogs.map((log) => ({
            address: log.address,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            transactionIndex: log.transactionIndex,
            logIndex: log.logIndex,
            removed: log.removed,
            topics: log.topics,
            data: log.data,
          })),
        );
      }
      return logs;
    },
    getReserves({ poolAddress, blockNumber }) {
      return client.readContract({
        address: poolAddress,
        abi: UniswapV2PairReserveAbi,
        functionName: "getReserves",
        blockNumber,
      });
    },
    async getClHeadSnapshot({ pool, blockNumber }) {
      if (
        pool.venue === "aerodrome-slipstream" ||
        pool.venue === "aerodrome-slipstream2"
      ) {
        const poolAddress = requirePoolAddress(pool);
        const [sqrtPriceX96, tick] = await client.readContract({
          address: poolAddress,
          abi: SlipstreamSlot0Abi,
          functionName: "slot0",
          blockNumber,
        });
        const liquidity = await client.readContract({
          address: poolAddress,
          abi: ConcentratedPoolLiquidityAbi,
          functionName: "liquidity",
          blockNumber,
        });
        return {
          sqrtPriceX96,
          tick,
          liquidity,
          source: "pool-slot0-liquidity",
        };
      }

      if (pool.venue === "uniswap-v3") {
        const poolAddress = requirePoolAddress(pool);
        const [sqrtPriceX96, tick] = await client.readContract({
          address: poolAddress,
          abi: UniswapV3Slot0Abi,
          functionName: "slot0",
          blockNumber,
        });
        const liquidity = await client.readContract({
          address: poolAddress,
          abi: ConcentratedPoolLiquidityAbi,
          functionName: "liquidity",
          blockNumber,
        });
        return {
          sqrtPriceX96,
          tick,
          liquidity,
          source: "pool-slot0-liquidity",
        };
      }

      if (pool.venue === "uniswap-v4") {
        const poolKey = requirePoolKey(pool);
        const stateViewAddress = requireStateViewAddress(pool);
        const [sqrtPriceX96, tick] = await client.readContract({
          address: stateViewAddress,
          abi: UniswapV4StateViewSlot0Abi,
          functionName: "getSlot0",
          args: [poolKey],
          blockNumber,
        });
        const liquidity = await client.readContract({
          address: stateViewAddress,
          abi: UniswapV4StateViewLiquidityAbi,
          functionName: "getLiquidity",
          args: [poolKey],
          blockNumber,
        });
        return {
          sqrtPriceX96,
          tick,
          liquidity,
          source: "v4-state-view",
        };
      }

      throw new Error(`${pool.id} has no CL head reader.`);
    },
    async getClReplaySnapshot({ pool, blockNumber }) {
      return getSlipstreamClReplaySnapshot({
        client: {
          getBlock(options) {
            return client.getBlock(options);
          },
          getSlot0({ poolAddress, blockNumber: readBlockNumber }) {
            return client.readContract({
              address: poolAddress,
              abi: SlipstreamSlot0Abi,
              functionName: "slot0",
              blockNumber: readBlockNumber,
            });
          },
          getLiquidity({ poolAddress, blockNumber: readBlockNumber }) {
            return client.readContract({
              address: poolAddress,
              abi: ConcentratedPoolLiquidityAbi,
              functionName: "liquidity",
              blockNumber: readBlockNumber,
            });
          },
          getFee({ poolAddress, blockNumber: readBlockNumber }) {
            return client.readContract({
              address: poolAddress,
              abi: SlipstreamFeeAbi,
              functionName: "fee",
              blockNumber: readBlockNumber,
            });
          },
          getTickBitmap({
            poolAddress,
            wordPosition,
            blockNumber: readBlockNumber,
          }) {
            return client.readContract({
              address: poolAddress,
              abi: SlipstreamTickBitmapAbi,
              functionName: "tickBitmap",
              args: [wordPosition],
              blockNumber: readBlockNumber,
            });
          },
          async getTickBitmaps({
            poolAddress,
            wordPositions,
            blockNumber: readBlockNumber,
          }) {
            const results = await client.multicall({
              contracts: wordPositions.map((wordPosition) => ({
                address: poolAddress,
                abi: SlipstreamTickBitmapAbi,
                functionName: "tickBitmap",
                args: [wordPosition],
              })),
              blockNumber: readBlockNumber,
              allowFailure: false,
            });
            return results.map((bitmap, index) => {
              const wordPosition = wordPositions[index];
              if (wordPosition === undefined) {
                throw new Error("Missing tick bitmap word position.");
              }
              return { wordPosition, bitmap };
            });
          },
          getTick({ poolAddress, tick, blockNumber: readBlockNumber }) {
            return client.readContract({
              address: poolAddress,
              abi: SlipstreamTicksAbi,
              functionName: "ticks",
              args: [tick],
              blockNumber: readBlockNumber,
            });
          },
          async getTicks({ poolAddress, ticks, blockNumber: readBlockNumber }) {
            const results = await client.multicall({
              contracts: ticks.map((tick) => ({
                address: poolAddress,
                abi: SlipstreamTicksAbi,
                functionName: "ticks",
                args: [tick],
              })),
              blockNumber: readBlockNumber,
              allowFailure: false,
            });
            return results.map((state, index) => {
              const tick = ticks[index];
              if (tick === undefined) {
                throw new Error("Missing initialized tick index.");
              }
              return { tick, state };
            });
          },
        },
        pool,
        blockNumber,
      });
    },
  };
}

export async function indexFamePoolStates({
  client,
  tableName,
  db,
  registry = famePoolStateRegistry,
  confirmationBlocks = 2,
  clReplayMaintenanceMode = "checkpoint",
  clReplayTrustPromotion = false,
  clReplayMaxRangeBlocks = 1_000,
  now = new Date(),
}: {
  client: FamePoolStateIndexerClient;
  tableName: string;
  db?: PoolStateDocumentClient;
  registry?: FamePoolStateRegistryFile;
  confirmationBlocks?: number;
  clReplayMaintenanceMode?: FameClReplayMaintenanceMode;
  clReplayTrustPromotion?: boolean;
  clReplayMaxRangeBlocks?: number;
  now?: Date;
}): Promise<FamePoolStateIndexerResult> {
  const startedAtMs = Date.now();
  const pools = quoteModelPools(registry);
  const clPools = clHeadPools(registry);
  const replayPools = clReplayPools(registry);
  const sourceRegistryId = sourceRegistryIdFor(registry.source);
  const latestBlock = await client.getBlockNumber();
  const safeBlock = safeHeadBlock(latestBlock, confirmationBlocks);
  const observedThroughBlock = safeNumber(safeBlock, "safe head block");
  const cursor = await getPoolStateCursor({
    db,
    tableName,
    chainId: client.chain.id,
  });
  const fromBlock = Math.min(
    observedThroughBlock,
    (cursor?.observedThroughBlock ?? observedThroughBlock) + 1,
  );
  const previousObservedThroughBlock = cursor?.observedThroughBlock ?? 0;
  const writeObservedThroughBlock = Math.min(
    previousObservedThroughBlock,
    observedThroughBlock,
  );
  const updatedAt = now.toISOString();
  const poolByAddress = new Map(
    pools.map((pool) => [addressKey(pool.poolAddress), pool]),
  );

  let writtenEvents = 0;
  let ignoredEvents = 0;
  const logs =
    pools.length === 0 || fromBlock > observedThroughBlock
      ? []
      : await client.getSyncLogs({
          pools,
          fromBlock: BigInt(fromBlock),
          toBlock: safeBlock,
        });
  const reserveSnapshots = new Map(
    await Promise.all(
      pools.map(async (pool) => {
        const [reserve0, reserve1] = await client.getReserves({
          poolAddress: pool.poolAddress,
          blockNumber: safeBlock,
        });
        return [addressKey(pool.poolAddress), { reserve0, reserve1 }] as const;
      }),
    ),
  );

  for (const log of sortedLogs(logs)) {
    const pool = poolByAddress.get(addressKey(log.address));
    if (!pool) {
      throw new Error(`Sync log came from unregistered pool ${log.address}.`);
    }

    const result = await putLatestPoolState({
      db,
      tableName,
      state: latestStateFromReserves({
        pool,
        reserve0: log.args.reserve0,
        reserve1: log.args.reserve1,
        observedThroughBlock: writeObservedThroughBlock,
        version: {
          blockNumber: safeNumber(log.blockNumber, "Sync event block number"),
          transactionIndex: log.transactionIndex,
          logIndex: log.logIndex,
        },
        transactionHash: log.transactionHash,
        source: "sync-event",
        sourceRegistryId,
        updatedAt,
      }),
    });
    if (result === "written") writtenEvents += 1;
    else ignoredEvents += 1;
  }

  let seededPools = 0;
  let reconciledPools = 0;
  let observedPools = 0;
  const latestStates = await batchGetLatestPoolStates({
    db,
    tableName,
    pools,
  });
  const latestByAddress = new Map(
    latestStates.map((state) => [addressKey(state.poolAddress), state]),
  );

  for (const pool of pools) {
    const latest = latestByAddress.get(addressKey(pool.poolAddress)) ?? null;
    const reserves = reserveSnapshots.get(addressKey(pool.poolAddress));
    if (!reserves) {
      throw new Error(`${pool.id} missing reserve snapshot.`);
    }
    const { reserve0, reserve1 } = reserves;
    if (
      stateNeedsReconciliation({
        latest,
        pool,
        reserve0,
        reserve1,
        sourceRegistryId,
      })
    ) {
      const result = await putLatestPoolState({
        db,
        tableName,
        state: latestStateFromReserves({
          pool,
          reserve0,
          reserve1,
          observedThroughBlock: writeObservedThroughBlock,
          version: {
            blockNumber: observedThroughBlock,
            transactionIndex: Number.MAX_SAFE_INTEGER,
            logIndex: Number.MAX_SAFE_INTEGER,
          },
          transactionHash: null,
          source: "getReserves",
          sourceRegistryId,
          updatedAt,
        }),
      });
      if (result === "written") {
        if (latest) reconciledPools += 1;
        else seededPools += 1;
      }
    }
  }

  for (const pool of pools) {
    await markPoolObservedThroughBlock({
      db,
      tableName,
      chainId: pool.chainId,
      poolAddress: pool.poolAddress,
      observedThroughBlock,
      sourceRegistryId,
      updatedAt,
    });
    observedPools += 1;
  }

  await setPoolStateCursor({
    db,
    tableName,
    chainId: client.chain.id,
    observedThroughBlock,
    sourceRegistryId,
    updatedAt,
  });

  const latestClHeadStates = await batchGetLatestClHeadStates({
    db,
    tableName,
    pools: clPools,
  });
  const latestClHeadByPoolId = new Map(
    latestClHeadStates.map((state) => [state.poolId, state]),
  );
  const clHeadReads = await Promise.allSettled(
    clPools.map(async (pool) => {
      const snapshot = await client.getClHeadSnapshot({
        pool,
        blockNumber: safeBlock,
      });
      return {
        pool,
        snapshot,
      };
    }),
  );
  const clHeadSnapshots: {
    pool: ClHeadPool;
    snapshot: FameClHeadSnapshotRead;
  }[] = [];
  const clHeadFailures: FameClHeadSnapshotFailure[] = [];
  clHeadReads.forEach((result, index) => {
    if (result.status === "fulfilled") {
      clHeadSnapshots.push(result.value);
      return;
    }
    const pool = clPools[index];
    if (!pool) throw new Error("CL head read result missing pool.");
    clHeadFailures.push({
      poolId: pool.id,
      message: errorMessage(result.reason),
    });
  });
  let clHeadWrittenPools = 0;
  for (const { pool, snapshot } of clHeadSnapshots) {
    const latest = latestClHeadByPoolId.get(pool.id);
    if (
      latest &&
      latest.sqrtPriceX96 === snapshot.sqrtPriceX96.toString() &&
      latest.tick === snapshot.tick &&
      latest.liquidity === snapshot.liquidity.toString() &&
      latest.sourceRegistryId === sourceRegistryId &&
      latest.observedThroughBlock >= observedThroughBlock
    ) {
      continue;
    }
    const result = await putLatestClHeadState({
      db,
      tableName,
      state: latestClHeadStateFromSnapshot({
        pool,
        sqrtPriceX96: snapshot.sqrtPriceX96,
        tick: snapshot.tick,
        liquidity: snapshot.liquidity,
        observedThroughBlock,
        source: snapshot.source,
        sourceRegistryId,
        updatedAt,
      }),
    });
    if (result === "written") clHeadWrittenPools += 1;
  }

  const latestClReplayStates = await batchGetLatestClReplayStates({
    db,
    tableName,
    pools: replayPools,
  });
  const latestClReplayByPoolId = new Map(
    latestClReplayStates.map((state) => [state.latest.poolId, state]),
  );
  const latestClReplayMaintenanceStates =
    await batchGetLatestClReplayMaintenanceStates({
      db,
      tableName,
      pools: replayPools,
    });
  const latestClReplayMaintenanceByPoolId = new Map(
    latestClReplayMaintenanceStates.map((state) => [state.poolId, state]),
  );
  const targetBlockIdentity =
    replayPools.length === 0
      ? null
      : await readBlockIdentity({ client, blockNumber: observedThroughBlock });
  const replayFromBlockByPoolId = new Map<string, number>();
  for (const pool of replayPools) {
    const latest = latestClReplayByPoolId.get(pool.id) ?? null;
    const maintenance = latestClReplayMaintenanceByPoolId.get(pool.id) ?? null;
    const canAdvanceTrustedState = clReplayMaintenanceMatchesLatest({
      maintenance,
      latest,
      sourceRegistryId,
    });
    if (
      (clReplayMaintenanceMode === "checkpoint" ||
        clReplayMaintenanceMode === "steady-state") &&
      canAdvanceTrustedState &&
      maintenance !== null
    ) {
      replayFromBlockByPoolId.set(pool.id, maintenance.cursorBlock + 1);
    } else {
      replayFromBlockByPoolId.set(pool.id, observedThroughBlock + 1);
    }
  }
  const replayScanFromBlock =
    replayFromBlockByPoolId.size === 0
      ? observedThroughBlock + 1
      : Math.min(...replayFromBlockByPoolId.values());
  const clReplayRawLogs =
    replayPools.length === 0 || replayScanFromBlock > observedThroughBlock
      ? []
      : await client.getClReplayLogs({
          pools: replayPools,
          fromBlock: BigInt(replayScanFromBlock),
          toBlock: safeBlock,
        });
  const replayPoolByAddress = new Map(
    replayPools.map((pool) => [addressKey(pool.poolAddress), pool]),
  );
  const clReplayRawLogsByPoolId = new Map<string, FameClReplayRawLog[]>();
  for (const log of clReplayRawLogs) {
    const pool = replayPoolByAddress.get(addressKey(log.address));
    if (!pool) {
      throw new Error(
        `CL replay log came from unregistered pool ${log.address}.`,
      );
    }
    const poolLogs = clReplayRawLogsByPoolId.get(pool.id) ?? [];
    poolLogs.push(log);
    clReplayRawLogsByPoolId.set(pool.id, poolLogs);
  }

  const clReplayReads =
    clReplayMaintenanceMode !== "steady-state"
      ? await Promise.allSettled(
          replayPools.map(async (pool) => {
            const snapshot = await client.getClReplaySnapshot({
              pool,
              blockNumber: safeBlock,
            });
            return {
              pool,
              snapshot,
            };
          }),
        )
      : [];
  const clReplaySnapshots: {
    pool: ClReplayPool;
    snapshot: FameClReplaySnapshotRead;
  }[] = [];
  const clReplayFailures: FameClReplaySnapshotFailure[] = [];
  clReplayReads.forEach((result, index) => {
    if (result.status === "fulfilled") {
      clReplaySnapshots.push(result.value);
      return;
    }
    const pool = replayPools[index];
    if (!pool) throw new Error("CL replay read result missing pool.");
    clReplayFailures.push({
      poolId: pool.id,
      message: errorMessage(result.reason),
    });
  });

  let clReplayWrittenPools = 0;
  const clReplayMetrics: FameClReplaySnapshotMetric[] = [];
  const clReplayRowsByPoolId = new Map<string, FameClReplayStateRows>();
  for (const { pool, snapshot } of clReplaySnapshots) {
    const rows = clReplayRowsFromSnapshot({
      pool,
      snapshot,
      observedThroughBlock,
      sourceRegistryId,
      updatedAt,
    });
    const result = await putLatestClReplayState({
      db,
      tableName,
      rows,
    });
    clReplayRowsByPoolId.set(pool.id, rows);
    if (result === "written") clReplayWrittenPools += 1;
    clReplayMetrics.push({
      poolId: pool.id,
      bitmapWordCount: rows.latest.bitmapWordCount,
      initializedTickCount: rows.latest.initializedTickCount,
      bitmapChunkCount: rows.latest.bitmapChunkCount,
      tickChunkCount: rows.latest.tickChunkCount,
      providerReadCount: snapshot.providerReadCount,
      durationMs: snapshot.durationMs,
      stateHash: rows.latest.stateHash,
    });
  }

  const clReplayMaintenanceMetrics: FameClReplayMaintenanceMetric[] = [];
  for (const pool of replayPools) {
    const snapshotRows = clReplayRowsByPoolId.get(pool.id);
    const latest = latestClReplayByPoolId.get(pool.id) ?? null;
    const maintenance = latestClReplayMaintenanceByPoolId.get(pool.id) ?? null;
    const canAdvanceTrustedState = clReplayMaintenanceMatchesLatest({
      maintenance,
      latest,
      sourceRegistryId,
    });
    const snapshotSeed = snapshotRows
      ? clReplayCapsuleFromRows(snapshotRows)
      : null;
    const seed =
      clReplayMaintenanceMode === "repair" && snapshotSeed
        ? snapshotSeed
        : clReplayMaintenanceMode === "checkpoint" &&
            snapshotSeed &&
            !canAdvanceTrustedState
          ? snapshotSeed
          : latest ?? snapshotSeed;
    const replayFromBlockForPool =
      replayFromBlockByPoolId.get(pool.id) ?? observedThroughBlock + 1;
    const poolLogs = (clReplayRawLogsByPoolId.get(pool.id) ?? []).filter(
      (log) =>
        safeNumber(log.blockNumber, "CL replay log block number") >=
        replayFromBlockForPool,
    );
    const fromBlockForMetric =
      replayFromBlockForPool > observedThroughBlock
        ? observedThroughBlock
        : replayFromBlockForPool;

    let applyResult: FameClReplayDeltaApplyResult;
    try {
      if (
        replayFromBlockForPool <= observedThroughBlock &&
        observedThroughBlock - replayFromBlockForPool + 1 >
          clReplayMaxRangeBlocks
      ) {
        applyResult = {
          status: "event-gap",
          reason: "range-limit",
          appliedEventCount: 0,
        };
      } else {
        if (
          clReplayMaintenanceMode === "steady-state" &&
          maintenance !== null &&
          replayFromBlockForPool <= observedThroughBlock
        ) {
          const cursorIdentity = await readBlockIdentity({
            client,
            blockNumber: maintenance.cursorBlock,
          });
          if (cursorIdentity.blockHash !== maintenance.cursorBlockHash) {
            throw new Error("cursor-block-hash-mismatch");
          }
        }
        const events = normalizeClReplayLogs({ pool, logs: poolLogs });
        if (targetBlockIdentity === null) {
          throw new Error("target-block-unavailable");
        }
        applyResult = applyClReplayDeltas({
          pool,
          seed,
          events,
          observedThroughBlock,
          blockHash: snapshotRows?.latest.blockHash ?? targetBlockIdentity.blockHash,
          parentHash:
            snapshotRows?.latest.parentHash ?? targetBlockIdentity.parentHash,
          candidateId: `cl-replay-candidate-v1:${pool.id}:${observedThroughBlock.toString()}:${sourceRegistryId}`,
          sourceRegistryId,
          updatedAt,
        });
      }
    } catch (error) {
      applyResult = {
        status: "event-gap",
        reason: errorMessage(error),
        appliedEventCount: 0,
      };
    }

    let candidateWritten = false;
    let stateHash: Hex | null = null;
    let maintenanceStatus: FameClReplayMaintenanceMetric["status"] =
      "event-gap";
    let reason: string | null = null;
    let candidateId: string | null = null;
    let quoteableRows: FameClReplayStateRows | null = null;
    if (applyResult.status === "candidate") {
      const writeResult = await putLatestClReplayCandidateState({
        db,
        tableName,
        rows: applyResult.rows,
      });
      candidateWritten = writeResult === "written";
      stateHash = applyResult.rows.latest.stateHash;
      candidateId = applyResult.rows.latest.candidateId;
      const driftClean =
        snapshotRows === undefined ||
        snapshotRows.latest.stateHash === applyResult.rows.latest.stateHash;
      if (clReplayTrustPromotion && driftClean) {
        quoteableRows = clReplayRowsFromCandidateRows({
          pool,
          rows: applyResult.rows,
        });
        await putLatestClReplayState({
          db,
          tableName,
          rows: quoteableRows,
        });
        maintenanceStatus = "trusted";
        reason = null;
      } else if (clReplayTrustPromotion) {
        maintenanceStatus = "drift-failed";
        reason = "checkpoint-state-hash-mismatch";
      } else {
        maintenanceStatus = "warming";
        reason = "shadow-not-promoted";
      }
    } else {
      maintenanceStatus = applyResult.status;
      reason = applyResult.reason;
    }

    await putLatestClReplayMaintenanceState({
      db,
      tableName,
      state: {
        ...latestClReplayMaintenanceStateKey(pool),
        stateKind: "cl-replay-maintenance-v1",
        poolId: pool.id,
        chainId: pool.chainId,
        poolAddress: pool.poolAddress,
        status: maintenanceStatus,
        cursorBlock: observedThroughBlock,
        cursorBlockHash:
          quoteableRows?.latest.blockHash ??
          snapshotRows?.latest.blockHash ??
          targetBlockIdentity?.blockHash ??
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        cursorTransactionIndex: Number.MAX_SAFE_INTEGER,
        cursorLogIndex: Number.MAX_SAFE_INTEGER,
        targetBlock: observedThroughBlock,
        targetBlockHash:
          targetBlockIdentity?.blockHash ??
          snapshotRows?.latest.blockHash ??
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        stateHash:
          stateHash ??
          seed?.latest.stateHash ??
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        sourceRegistryId,
        updatedAt,
        lastCheckpointBlock:
          snapshotRows?.latest.observedThroughBlock ??
          maintenance?.lastCheckpointBlock ??
          null,
        lastCheckpointBlockHash:
          snapshotRows?.latest.blockHash ??
          maintenance?.lastCheckpointBlockHash ??
          null,
        reason,
        candidateId,
      },
    });

    clReplayMaintenanceMetrics.push({
      poolId: pool.id,
      status: maintenanceStatus,
      reason,
      fromBlock: fromBlockForMetric,
      toBlock: observedThroughBlock,
      scannedLogCount: poolLogs.length,
      appliedEventCount: applyResult.appliedEventCount,
      candidateWritten,
      stateHash,
    });
  }

  return {
    chainId: client.chain.id,
    durationMs: Date.now() - startedAtMs,
    fromBlock,
    observedThroughBlock,
    syncEvents: logs.length,
    writtenEvents,
    ignoredEvents,
    seededPools,
    reconciledPools,
    observedPools,
    clHeadSnapshots: clHeadSnapshots.length,
    clHeadWrittenPools,
    clHeadFailedPools: clHeadFailures.length,
    clHeadFailures,
    clReplaySnapshots: clReplaySnapshots.length,
    clReplayWrittenPools,
    clReplayFailedPools: clReplayFailures.length,
    clReplayFailures,
    clReplayMetrics,
    clReplayMaintenanceMetrics,
    sourceRegistryId,
  };
}
