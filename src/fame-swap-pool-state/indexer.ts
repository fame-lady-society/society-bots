import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import {
  Uint256ReserveSyncEvent,
  UniswapV2PairReserveAbi,
  UniswapV2SyncEvent,
} from "@/events.ts";
import type { baseClient } from "@/viem.ts";
import {
  batchGetLatestClHeadStates,
  batchGetLatestPoolStates,
  clReplayStateRowsFromSnapshot,
  getPoolStateCursor,
  latestClHeadStateFromSnapshot,
  latestStateFromReserves,
  markPoolObservedThroughBlock,
  putLatestClReplayState,
  putLatestClHeadState,
  putLatestPoolState,
  setPoolStateCursor,
  sourceRegistryIdFor,
  type FameClHeadSnapshotRegistryEntry,
  type FameClHeadSource,
  type FameClReplayRegistryEntry,
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
const CL_REPLAY_PROVIDER_READ_BATCH_SIZE = 32;

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

export interface FamePoolStateIndexerClient {
  chain: {
    id: number;
  };
  getBlockNumber(): Promise<bigint>;
  getSyncLogs(options: {
    pools: readonly QuoteModelPool[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly FamePoolStateSyncLog[]>;
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
  const wordReads = await mapInBatches(
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
  const initializedTicks = await mapInBatches(
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
    async getSyncLogs({ pools, fromBlock, toBlock }) {
      const uint112Addresses = pools
        .filter((pool) => syncEventKind(pool) === "uint112-reserves")
        .map((pool) => pool.poolAddress);
      const uint256Addresses = pools
        .filter((pool) => syncEventKind(pool) === "uint256-reserves")
        .map((pool) => pool.poolAddress);
      const logsByKind = await Promise.all([
        uint112Addresses.length === 0
          ? Promise.resolve([])
          : client.getLogs({
              address: uint112Addresses,
              event: UniswapV2SyncEvent,
              fromBlock,
              toBlock,
              strict: true,
            }),
        uint256Addresses.length === 0
          ? Promise.resolve([])
          : client.getLogs({
              address: uint256Addresses,
              event: Uint256ReserveSyncEvent,
              fromBlock,
              toBlock,
              strict: true,
            }),
      ]);
      return logsByKind.flat().map((log) => ({
        address: log.address,
        blockNumber: log.blockNumber,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        transactionHash: log.transactionHash,
        args: {
          reserve0: log.args.reserve0,
          reserve1: log.args.reserve1,
        },
      }));
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
          getTick({ poolAddress, tick, blockNumber: readBlockNumber }) {
            return client.readContract({
              address: poolAddress,
              abi: SlipstreamTicksAbi,
              functionName: "ticks",
              args: [tick],
              blockNumber: readBlockNumber,
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
  now = new Date(),
}: {
  client: FamePoolStateIndexerClient;
  tableName: string;
  db?: PoolStateDocumentClient;
  registry?: FamePoolStateRegistryFile;
  confirmationBlocks?: number;
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

  const clReplayReads = await Promise.allSettled(
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
  );
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
    sourceRegistryId,
  };
}
