import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { UniswapV2PairReserveAbi } from "../events.ts";
import type { baseClient } from "../viem.ts";
import {
  batchGetLatestClReplayCandidateStates,
  batchGetLatestClHeadStates,
  batchGetLatestClReplayMaintenanceStates,
  batchGetLatestClReplayStates,
  batchGetLatestPoolStates,
  batchGetLatestV4ClReplayCandidateStates,
  batchGetLatestV4ClReplayMaintenanceStates,
  batchGetLatestV4ClReplayStates,
  clReplayCandidateStateRowsFromSnapshot,
  clReplayStateRowsFromSnapshot,
  v4ClReplayCandidateStateRowsFromSnapshot,
  v4ClReplayStateRowsFromSnapshot,
  getPoolStateCursor,
  latestClHeadStateFromSnapshot,
  latestClReplayMaintenanceStateKey,
  latestV4ClReplayMaintenanceStateKey,
  latestStateFromReserves,
  markPoolObservedThroughBlock,
  putLatestClReplayCandidateState,
  putLatestClReplayMaintenanceState,
  putLatestClReplayState,
  putLatestV4ClReplayCandidateState,
  putLatestV4ClReplayMaintenanceState,
  putLatestV4ClReplayState,
  putLatestClHeadState,
  putLatestPoolState,
  setPoolStateCursor,
  sourceRegistryIdFor,
  type FameClHeadSnapshotRegistryEntry,
  type FameClHeadSource,
  type FameClReplayMaintenanceState,
  type FameClReplayCandidateStateCapsule,
  type FameClReplayStateCapsule,
  type FameClReplayStateRows,
  type FameV4ClReplayCandidateStateCapsule,
  type FameV4ClReplayMaintenanceState,
  type FameV4ClReplayRegistryEntry,
  type FameV4ReviewedPoolEvidence,
  type FameV4ClReplayStateCapsule,
  type FameV4ClReplayStateRows,
  type FameV4ZoraVerifiedProvenance,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import {
  FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID,
  clReplayReducerManifestForPool,
  isClReplayReducerManifestPool,
  type FameClReplayReducerRegistryEntry,
} from "./cl-reducer-manifests.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import {
  FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
  classifyV4ZoraQuoteLane,
  fameV4ZoraQuoteLaneManifestForPool,
  type FameV4ZoraQuoteLaneClassification,
} from "./v4-zora-manifests.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
  FamePoolStateV4ZoraProvenanceEvidence,
} from "./types.ts";

type QuoteModelPool = FamePoolStateRegistryEntry & { poolAddress: Address };
type ClHeadPool = FameClHeadSnapshotRegistryEntry;
type ClReplayPool = FameClReplayReducerRegistryEntry;
type V4ClReplayPool = FameV4ClReplayRegistryEntry;
type ClReplaySeedCapsule =
  | FameClReplayStateCapsule
  | FameClReplayCandidateStateCapsule;
type V4ClReplaySeedCapsule =
  | FameV4ClReplayStateCapsule
  | FameV4ClReplayCandidateStateCapsule;
type V4EligibleQuoteLaneClassification = Extract<
  FameV4ZoraQuoteLaneClassification,
  { status: "target-eligible" }
>;

function v4ReviewedPoolEvidenceFromClassification(
  classification: V4EligibleQuoteLaneClassification,
): FameV4ReviewedPoolEvidence {
  const shape = classification.manifest.reviewedPoolShape;
  return {
    status: "verified",
    source: "reviewed-v4-manifest",
    kind: classification.manifest.provenanceRequired
      ? "zora-protocol-pool"
      : "zero-hook-static-fee",
    manifestVersion: classification.manifest.version,
    poolId: classification.manifest.poolId,
    poolKey: shape.poolKey,
    staticFee: shape.fee.toString(),
    hookAddress: shape.hooks,
    hookData: shape.hookData,
    protocolFeeStatus: "zero",
  };
}

function eligibleV4QuoteLaneEvidence({
  pool,
  provenance,
}: {
  pool: V4ClReplayPool;
  provenance?: FamePoolStateV4ZoraProvenanceEvidence;
}): {
  reviewedPoolEvidence: FameV4ReviewedPoolEvidence;
  zoraProvenance?: FameV4ZoraVerifiedProvenance;
} {
  const classification = classifyV4ZoraQuoteLane(pool, provenance);
  if (classification.status !== "target-eligible") {
    throw new Error(
      `${pool.id} V4 replay pool is not reviewed quote eligible.`,
    );
  }
  return {
    reviewedPoolEvidence:
      v4ReviewedPoolEvidenceFromClassification(classification),
    ...(classification.provenance
      ? { zoraProvenance: classification.provenance }
      : {}),
  };
}
type ClReplayTrustedCursorCheck =
  | { canAdvance: true; reason: null }
  | { canAdvance: false; reason: string | null };

const CL_MIN_TICK = -887_272;
const CL_MAX_TICK = 887_272;
const CL_TICK_BITMAP_WORD_SIZE = 256;
const CL_REPLAY_PROVIDER_READ_BATCH_SIZE = 4;
const DEFAULT_RPC_GET_LOGS_BLOCK_RANGE = 500;

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

export const V4ClReplaySwapEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128", indexed: false },
    { name: "amount1", type: "int128", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
    { name: "fee", type: "uint24", indexed: false },
  ],
  name: "Swap",
} as const;

export const V4ClReplayModifyLiquidityEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "tickLower", type: "int24", indexed: false },
    { name: "tickUpper", type: "int24", indexed: false },
    { name: "liquidityDelta", type: "int256", indexed: false },
    { name: "salt", type: "bytes32", indexed: false },
  ],
  name: "ModifyLiquidity",
} as const;

export const V4ClReplayInitializeEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "currency0", type: "address", indexed: true },
    { name: "currency1", type: "address", indexed: true },
    { name: "fee", type: "uint24", indexed: false },
    { name: "tickSpacing", type: "int24", indexed: false },
    { name: "hooks", type: "address", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
  name: "Initialize",
} as const;

export const V4ClReplayDonateEventAbi = {
  type: "event",
  anonymous: false,
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "uint256", indexed: false },
    { name: "amount1", type: "uint256", indexed: false },
  ],
  name: "Donate",
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
const V4_REPLAY_SWAP_TOPIC = toEventSelector(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);
const V4_REPLAY_MODIFY_LIQUIDITY_TOPIC = toEventSelector(
  "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)",
);
const V4_REPLAY_INITIALIZE_TOPIC = toEventSelector(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
const V4_REPLAY_DONATE_TOPIC = toEventSelector(
  "Donate(bytes32,address,uint256,uint256)",
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

const UniswapV4StateViewTickBitmapAbi = [
  {
    type: "function",
    name: "getTickBitmap",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "wordPosition", type: "int16" },
    ],
    outputs: [{ name: "tickBitmap", type: "uint256" }],
  },
] as const;

const UniswapV4StateViewTickInfoAbi = [
  {
    type: "function",
    name: "getTickInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "tick", type: "int24" },
    ],
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
    ],
  },
] as const;

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

export type FameV4ClReplayRawLog = FameClReplayRawLog;

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

export interface FameV4ClReplayEventBase {
  poolId: string;
  venue: V4ClReplayPool["venue"];
  poolKey: Hex;
  poolManager: Address;
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

export type FameV4ClReplayNormalizedEvent =
  | (FameV4ClReplayEventBase & {
      kind: "swap";
      sqrtPriceX96: bigint;
      tick: number;
      liquidity: bigint;
      lpFee: bigint;
    })
  | (FameV4ClReplayEventBase & {
      kind: "modify-liquidity";
      tickLower: number;
      tickUpper: number;
      liquidityDelta: bigint;
    })
  | (FameV4ClReplayEventBase & {
      kind: "initialize";
      sqrtPriceX96: bigint;
      tick: number;
      lpFee: bigint;
      tickSpacing: number;
    })
  | (FameV4ClReplayEventBase & {
      kind: "donate";
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

export type FameV4ClReplayDeltaApplyResult =
  | {
      status: "candidate";
      rows: ReturnType<typeof v4ClReplayCandidateStateRowsFromSnapshot>;
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
  getClReplayLogs(options: {
    pools: readonly ClReplayPool[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly FameClReplayRawLog[]>;
  getV4ClReplayLogs(options: {
    pools: readonly V4ClReplayPool[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly FameV4ClReplayRawLog[]>;
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
  getV4ClReplaySnapshot(options: {
    pool: V4ClReplayPool;
    blockNumber: bigint;
  }): Promise<FameV4ClReplaySnapshotRead>;
  getClReplayFee(options: {
    pool: ClReplayPool;
    blockNumber: bigint;
  }): Promise<bigint>;
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

export interface UniswapV4ReplayReadClient {
  getBlock(options: {
    blockNumber: bigint;
  }): Promise<{ hash: Hex | null; parentHash: Hex }>;
  getSlot0(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    blockNumber: bigint;
  }): Promise<readonly [bigint, number, number, number]>;
  getLiquidity(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    blockNumber: bigint;
  }): Promise<bigint>;
  getTickBitmap(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    wordPosition: number;
    blockNumber: bigint;
  }): Promise<bigint>;
  getTickBitmaps?(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    wordPositions: readonly number[];
    blockNumber: bigint;
  }): Promise<readonly FameClReplayBitmapWordRead[]>;
  getTickInfo(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    tick: number;
    blockNumber: bigint;
  }): Promise<readonly [bigint, bigint, bigint, bigint]>;
  getTickInfos?(options: {
    stateViewAddress: Address;
    poolKey: Hex;
    ticks: readonly number[];
    blockNumber: bigint;
  }): Promise<
    readonly {
      tick: number;
      state: readonly [bigint, bigint, bigint, bigint];
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

export interface FameV4ClReplaySnapshotRead {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  lpFee: bigint;
  protocolFee: bigint;
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

export interface FameV4ClReplaySnapshotMetric
  extends FameClReplaySnapshotMetric {
  lpFee: string;
  protocolFee: string;
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
  v4ClReplaySnapshots: number;
  v4ClReplayWrittenPools: number;
  v4ClReplayFailedPools: number;
  v4ClReplayFailures: FameClReplaySnapshotFailure[];
  v4ClReplayMetrics: FameV4ClReplaySnapshotMetric[];
  v4ClReplayMaintenanceMetrics: FameClReplayMaintenanceMetric[];
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
    | "clReplayFailedPools"
    | "clReplayFailures"
    | "v4ClReplayFailedPools"
    | "v4ClReplayFailures"
  >,
): void {
  if (result.clReplayFailedPools > 0 || result.v4ClReplayFailedPools > 0) {
    throw new FameClReplaySnapshotIndexingError([
      ...result.clReplayFailures,
      ...result.v4ClReplayFailures,
    ]);
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
  return registry.pools.filter((pool): pool is ClReplayPool => {
    if (pool.id === FAME_SELECTED_CL_REPLAY_CANDIDATE_POOL_ID) {
      return isClReplayReducerManifestPool(pool);
    }
    return (
      pool.replaySurface === "cl-replay-v1" &&
      pool.stateSurface === "cl-head-snapshot" &&
      pool.tickSpacing !== null &&
      pool.poolAddress !== null &&
      pool.venue === "aerodrome-slipstream"
    );
  });
}

function v4ClReplayPools({
  registry,
  provenance,
}: {
  registry: FamePoolStateRegistryFile;
  provenance?: FamePoolStateV4ZoraProvenanceEvidence;
}): V4ClReplayPool[] {
  return registry.pools.filter((pool): pool is V4ClReplayPool => {
    if (
      classifyV4ZoraQuoteLane(pool, provenance).status !== "target-eligible"
    ) {
      return false;
    }
    return (
      pool.venue === "uniswap-v4" &&
      pool.venueFamily === "UniswapV4" &&
      pool.poolAddress === null &&
      pool.poolKey !== null &&
      pool.stateViewAddress !== null &&
      pool.stateSurface === "cl-head-snapshot" &&
      pool.tickSpacing !== null
    );
  });
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

function safeUint24(value: bigint, name: string): number {
  if (value < 0n || value > 0xff_ffffn) {
    throw new Error(`${name} must fit uint24.`);
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

function v4ClReplaySnapshotId({
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
  return `v4-cl-replay-v1:${poolId}:${observedThroughBlock.toString()}:${blockHash}:${sourceRegistryId}`;
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

function v4ClReplayStateHash({
  pool,
  snapshot,
  observedThroughBlock,
}: {
  pool: V4ClReplayPool;
  snapshot: Pick<
    FameV4ClReplaySnapshotRead,
    | "sqrtPriceX96"
    | "tick"
    | "liquidity"
    | "lpFee"
    | "protocolFee"
    | "blockHash"
    | "parentHash"
    | "bitmapWords"
    | "initializedTicks"
  >;
  observedThroughBlock: number;
}): Hex {
  const bitmapWords = snapshot.bitmapWords.filter((word) => word.bitmap !== 0n);
  return keccak256(
    encodeAbiParameters(
      [
        { name: "poolKey", type: "bytes32" },
        { name: "stateViewAddress", type: "address" },
        { name: "sqrtPriceX96", type: "uint160" },
        { name: "tick", type: "int24" },
        { name: "liquidity", type: "uint128" },
        { name: "lpFee", type: "uint24" },
        { name: "protocolFee", type: "uint24" },
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
        pool.poolKey,
        pool.stateViewAddress,
        snapshot.sqrtPriceX96,
        snapshot.tick,
        snapshot.liquidity,
        safeUint24(snapshot.lpFee, "V4 CL replay LP fee"),
        safeUint24(snapshot.protocolFee, "V4 CL replay protocol fee"),
        BigInt(observedThroughBlock),
        snapshot.blockHash,
        snapshot.parentHash,
        bitmapWords.map((word) => ({
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

function v4ClReplayRowsFromSnapshot({
  pool,
  snapshot,
  observedThroughBlock,
  reviewedPoolEvidence,
  zoraProvenance,
  sourceRegistryId,
  updatedAt,
}: {
  pool: V4ClReplayPool;
  snapshot: FameV4ClReplaySnapshotRead;
  observedThroughBlock: number;
  reviewedPoolEvidence: FameV4ReviewedPoolEvidence;
  zoraProvenance?: FameV4ZoraVerifiedProvenance;
  sourceRegistryId: string;
  updatedAt: string;
}): FameV4ClReplayStateRows {
  return v4ClReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: snapshot.sqrtPriceX96,
    tick: snapshot.tick,
    liquidity: snapshot.liquidity,
    lpFee: snapshot.lpFee,
    protocolFee: snapshot.protocolFee,
    observedThroughBlock,
    blockHash: snapshot.blockHash,
    parentHash: snapshot.parentHash,
    snapshotId: v4ClReplaySnapshotId({
      poolId: pool.id,
      observedThroughBlock,
      blockHash: snapshot.blockHash,
      sourceRegistryId,
    }),
    stateHash: v4ClReplayStateHash({ pool, snapshot, observedThroughBlock }),
    reviewedPoolEvidence,
    zoraProvenance,
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
    initializedTicks: rows.tickChunks.flatMap(
      (chunk) => chunk.initializedTicks,
    ),
  };
}

function v4ClReplayCapsuleFromRows(
  rows: FameV4ClReplayStateRows,
): FameV4ClReplayStateCapsule {
  return {
    latest: rows.latest,
    bitmapWords: rows.bitmapChunks.flatMap((chunk) => chunk.bitmapWords),
    initializedTicks: rows.tickChunks.flatMap(
      (chunk) => chunk.initializedTicks,
    ),
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

function v4ClReplayRowsFromCandidateRows({
  pool,
  rows,
}: {
  pool: V4ClReplayPool;
  rows: ReturnType<typeof v4ClReplayCandidateStateRowsFromSnapshot>;
}): FameV4ClReplayStateRows {
  return v4ClReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: BigInt(rows.latest.sqrtPriceX96),
    tick: rows.latest.tick,
    liquidity: BigInt(rows.latest.liquidity),
    lpFee: BigInt(rows.latest.lpFee),
    protocolFee: BigInt(rows.latest.protocolFee),
    observedThroughBlock: rows.latest.observedThroughBlock,
    blockHash: rows.latest.blockHash,
    parentHash: rows.latest.parentHash,
    snapshotId: `v4-cl-replay-v1:${pool.id}:${rows.latest.observedThroughBlock.toString()}:${rows.latest.blockHash}:${rows.latest.sourceRegistryId}`,
    stateHash: rows.latest.stateHash,
    reviewedPoolEvidence: rows.latest.reviewedPoolEvidence,
    zoraProvenance: rows.latest.zoraProvenance,
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
  latest: ClReplaySeedCapsule | null;
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

function v4ClReplayMaintenanceMatchesLatest({
  maintenance,
  latest,
  sourceRegistryId,
}: {
  maintenance: FameV4ClReplayMaintenanceState | null;
  latest: V4ClReplaySeedCapsule | null;
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

function clReplayNeedsSteadyStateCheckpointBootstrap({
  maintenance,
  latest,
  sourceRegistryId,
}: {
  maintenance: FameClReplayMaintenanceState | null;
  latest: ClReplaySeedCapsule | null;
  sourceRegistryId: string;
}): boolean {
  return (
    latest === null ||
    maintenance === null ||
    latest.latest.sourceRegistryId !== sourceRegistryId ||
    maintenance.sourceRegistryId !== sourceRegistryId
  );
}

function v4ClReplayNeedsCheckpointBootstrap({
  maintenance,
  latest,
  sourceRegistryId,
}: {
  maintenance: FameV4ClReplayMaintenanceState | null;
  latest: V4ClReplaySeedCapsule | null;
  sourceRegistryId: string;
}): boolean {
  return (
    latest === null ||
    maintenance === null ||
    latest.latest.sourceRegistryId !== sourceRegistryId ||
    maintenance.sourceRegistryId !== sourceRegistryId
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

function baseV4ReplayEvent({
  pool,
  log,
}: {
  pool: V4ClReplayPool;
  log: FameV4ClReplayRawLog;
}): FameV4ClReplayEventBase {
  if (log.blockHash === null) {
    throw new FameClReplayLogNormalizationError(
      `${pool.id} V4 replay log is missing block hash.`,
    );
  }
  return {
    poolId: pool.id,
    venue: pool.venue,
    poolKey: pool.poolKey,
    poolManager: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolManager,
    blockNumber: safeNumber(log.blockNumber, "V4 CL replay log block number"),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
  };
}

function decodeV4ClReplayLog({
  pool,
  log,
}: {
  pool: V4ClReplayPool;
  log: FameV4ClReplayRawLog;
}): FameV4ClReplayNormalizedEvent {
  if (log.removed) {
    throw new FameClReplayLogNormalizationError(
      `${pool.id} V4 replay log was removed.`,
    );
  }
  if (
    addressKey(log.address) !==
    addressKey(FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolManager)
  ) {
    throw new FameClReplayLogNormalizationError(
      `V4 replay log address does not match ${pool.id} PoolManager.`,
    );
  }
  const topics = replayLogTopics(log);
  const topic = topics[0];
  const base = baseV4ReplayEvent({ pool, log });

  if (topic === V4_REPLAY_SWAP_TOPIC) {
    const decoded = decodeEventLog({
      abi: [V4ClReplaySwapEventAbi],
      eventName: "Swap",
      topics,
      data: log.data,
      strict: true,
    });
    if (decoded.args.id.toLowerCase() !== pool.poolKey.toLowerCase()) {
      throw new FameClReplayLogNormalizationError(
        `${pool.id} V4 Swap PoolId mismatch.`,
      );
    }
    return {
      ...base,
      kind: "swap",
      sqrtPriceX96: decoded.args.sqrtPriceX96,
      tick: decoded.args.tick,
      liquidity: decoded.args.liquidity,
      lpFee: BigInt(decoded.args.fee),
    };
  }
  if (topic === V4_REPLAY_MODIFY_LIQUIDITY_TOPIC) {
    const decoded = decodeEventLog({
      abi: [V4ClReplayModifyLiquidityEventAbi],
      eventName: "ModifyLiquidity",
      topics,
      data: log.data,
      strict: true,
    });
    if (decoded.args.id.toLowerCase() !== pool.poolKey.toLowerCase()) {
      throw new FameClReplayLogNormalizationError(
        `${pool.id} V4 ModifyLiquidity PoolId mismatch.`,
      );
    }
    return {
      ...base,
      kind: "modify-liquidity",
      tickLower: decoded.args.tickLower,
      tickUpper: decoded.args.tickUpper,
      liquidityDelta: decoded.args.liquidityDelta,
    };
  }
  if (topic === V4_REPLAY_INITIALIZE_TOPIC) {
    const decoded = decodeEventLog({
      abi: [V4ClReplayInitializeEventAbi],
      eventName: "Initialize",
      topics,
      data: log.data,
      strict: true,
    });
    if (decoded.args.id.toLowerCase() !== pool.poolKey.toLowerCase()) {
      throw new FameClReplayLogNormalizationError(
        `${pool.id} V4 Initialize PoolId mismatch.`,
      );
    }
    return {
      ...base,
      kind: "initialize",
      sqrtPriceX96: decoded.args.sqrtPriceX96,
      tick: decoded.args.tick,
      lpFee: BigInt(decoded.args.fee),
      tickSpacing: decoded.args.tickSpacing,
    };
  }
  if (topic === V4_REPLAY_DONATE_TOPIC) {
    const decoded = decodeEventLog({
      abi: [V4ClReplayDonateEventAbi],
      eventName: "Donate",
      topics,
      data: log.data,
      strict: true,
    });
    if (decoded.args.id.toLowerCase() !== pool.poolKey.toLowerCase()) {
      throw new FameClReplayLogNormalizationError(
        `${pool.id} V4 Donate PoolId mismatch.`,
      );
    }
    return {
      ...base,
      kind: "donate",
    };
  }

  throw new FameClReplayLogNormalizationError(
    `${pool.id} V4 replay log has unsupported topic ${topic}.`,
  );
}

export function normalizeV4ClReplayLogs({
  pool,
  logs,
}: {
  pool: V4ClReplayPool;
  logs: readonly FameV4ClReplayRawLog[];
}): FameV4ClReplayNormalizedEvent[] {
  return sortedReplayLogs(logs).map((log) =>
    decodeV4ClReplayLog({ pool, log }),
  );
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

function orderedV4ReplayEvents(
  events: readonly FameV4ClReplayNormalizedEvent[],
): FameV4ClReplayNormalizedEvent[] {
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
  fee,
  observedThroughBlock,
  blockHash,
  parentHash,
  candidateId,
  sourceRegistryId,
  updatedAt,
}: {
  pool: ClReplayPool;
  seed: ClReplaySeedCapsule | null;
  events: readonly FameClReplayNormalizedEvent[];
  fee?: bigint;
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
  const replayFee = fee ?? BigInt(seed.latest.fee);
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
      assertTickAligned({
        tick: event.tickLower,
        tickSpacing: pool.tickSpacing,
      });
      assertTickAligned({
        tick: event.tickUpper,
        tickSpacing: pool.tickSpacing,
      });
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
    fee: replayFee,
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
      fee: replayFee,
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

export function applyV4ClReplayDeltas({
  pool,
  seed,
  events,
  observedThroughBlock,
  blockHash,
  parentHash,
  candidateId,
  reviewedPoolEvidence,
  zoraProvenance,
  sourceRegistryId,
  updatedAt,
}: {
  pool: V4ClReplayPool;
  seed: V4ClReplaySeedCapsule | null;
  events: readonly FameV4ClReplayNormalizedEvent[];
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  candidateId: string;
  reviewedPoolEvidence: FameV4ReviewedPoolEvidence;
  zoraProvenance?: FameV4ZoraVerifiedProvenance;
  sourceRegistryId: string;
  updatedAt: string;
}): FameV4ClReplayDeltaApplyResult {
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
  let lpFee = BigInt(seed.latest.lpFee);
  const protocolFee = BigInt(seed.latest.protocolFee);
  const manifest = fameV4ZoraQuoteLaneManifestForPool(pool.id);
  if (manifest === null) {
    return {
      status: "event-gap",
      reason: "pool-shape-mismatch",
      appliedEventCount: 0,
    };
  }
  const reviewedStaticFee = BigInt(manifest.reviewedPoolShape.fee);
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

  for (const event of orderedV4ReplayEvents(events)) {
    if (
      event.poolId !== pool.id ||
      event.poolKey.toLowerCase() !== pool.poolKey.toLowerCase()
    ) {
      return {
        status: "event-gap",
        reason: "pool-mismatch",
        appliedEventCount,
      };
    }

    if (event.kind === "swap") {
      if (event.lpFee !== reviewedStaticFee) {
        return {
          status: "event-gap",
          reason: "lp-fee-mismatch",
          appliedEventCount,
        };
      }
      sqrtPriceX96 = event.sqrtPriceX96;
      tick = event.tick;
      liquidity = event.liquidity;
      lpFee = event.lpFee;
      appliedEventCount += 1;
      continue;
    }

    if (event.kind === "initialize") {
      if (
        event.lpFee !== reviewedStaticFee ||
        event.tickSpacing !== pool.tickSpacing
      ) {
        return {
          status: "event-gap",
          reason: "pool-shape-mismatch",
          appliedEventCount,
        };
      }
      continue;
    }

    if (event.kind === "donate") {
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
      assertTickAligned({
        tick: event.tickLower,
        tickSpacing: pool.tickSpacing,
      });
      assertTickAligned({
        tick: event.tickUpper,
        tickSpacing: pool.tickSpacing,
      });
    } catch {
      return {
        status: "event-gap",
        reason: "invalid-tick-spacing",
        appliedEventCount,
      };
    }

    const lowerResult = applyLiquidityDelta({
      tickStates,
      tick: event.tickLower,
      grossDelta: event.liquidityDelta,
      netDelta: event.liquidityDelta,
    });
    const upperResult = applyLiquidityDelta({
      tickStates,
      tick: event.tickUpper,
      grossDelta: event.liquidityDelta,
      netDelta: -event.liquidityDelta,
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
      liquidity += event.liquidityDelta;
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
    lpFee,
    protocolFee,
    blockHash,
    parentHash,
    bitmapWords,
    initializedTicks,
  };

  return {
    status: "candidate",
    rows: v4ClReplayCandidateStateRowsFromSnapshot({
      pool,
      sqrtPriceX96,
      tick,
      liquidity,
      lpFee,
      protocolFee,
      observedThroughBlock,
      blockHash,
      parentHash,
      candidateId,
      stateHash: v4ClReplayStateHash({ pool, snapshot, observedThroughBlock }),
      reviewedPoolEvidence,
      zoraProvenance,
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

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return "Unknown error";
}

function safeDependencyErrorMessage(error: unknown): string {
  const raw = errorText(error);
  return (
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(
        (line) =>
          line.length > 0 &&
          !/\b(request body|response body|raw response|response headers|set-cookie|calldata|approval|swap request|private key|signer|authorization|api[-_ ]?key)\b|(?:^|[\s"'{}:,])(?:secret|token|access[_-]?token|refresh[_-]?token|authorization)(?:[-_ ]?(?:key|token))?["']?\s*[:=]/i.test(
            line,
          ),
      ) ?? "Dependency read failed."
  )
    .replace(/(?:https?|wss?):\/\/\S+/g, "[redacted-url]")
    .replace(/\b(?:bearer|token)\s+[a-z0-9._~+/=-]+/gi, "[redacted-secret]")
    .replace(/0x[a-fA-F0-9]{64,}/g, "[redacted-hex]");
}

function maintenanceReasonCode(
  reason: string | null | undefined,
): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (/^[a-z0-9][a-z0-9-]{0,79}$/u.test(trimmed)) return trimmed;
  return "dependency-error";
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

export async function getUniswapV4ClReplaySnapshot({
  client,
  pool,
  blockNumber,
}: {
  client: UniswapV4ReplayReadClient;
  pool: V4ClReplayPool;
  blockNumber: bigint;
}): Promise<FameV4ClReplaySnapshotRead> {
  const startedAtMs = Date.now();
  const stateViewAddress = pool.stateViewAddress;
  const poolKey = pool.poolKey;
  const blockBefore = await client.getBlock({ blockNumber });
  if (blockBefore.hash === null) {
    throw new Error(`Block ${blockNumber.toString()} has no hash.`);
  }

  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] =
    await Promise.all([
      client.getSlot0({
        stateViewAddress,
        poolKey,
        blockNumber,
      }),
      client.getLiquidity({
        stateViewAddress,
        poolKey,
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
                  stateViewAddress,
                  poolKey,
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
            stateViewAddress,
            poolKey,
            wordPosition,
            blockNumber,
          }),
        }),
      );
  const bitmapWords = wordReads;
  const initializedTickIndexes = bitmapWords.flatMap((word) =>
    initializedTicksForBitmapWord({
      wordPosition: word.wordPosition,
      bitmap: word.bitmap,
      tickSpacing: pool.tickSpacing,
    }),
  );
  const initializedTicks = client.getTickInfos
    ? (
        await mapInBatches(
          chunkArray(
            initializedTickIndexes,
            CL_REPLAY_PROVIDER_READ_BATCH_SIZE,
          ),
          1,
          (batch) =>
            client.getTickInfos
              ? client.getTickInfos({
                  stateViewAddress,
                  poolKey,
                  ticks: batch,
                  blockNumber,
                })
              : Promise.resolve([]),
        )
      )
        .flat()
        .map(({ tick: initializedTick, state }) => {
          const [liquidityGross, liquidityNet] = state;
          if (liquidityGross === 0n) {
            throw new Error(
              `Tick bitmap marked ${initializedTick.toString()} initialized but getTickInfo returned zero liquidityGross.`,
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
          const [liquidityGross, liquidityNet] = await client.getTickInfo({
            stateViewAddress,
            poolKey,
            tick: initializedTick,
            blockNumber,
          });
          if (liquidityGross === 0n) {
            throw new Error(
              `Tick bitmap marked ${initializedTick.toString()} initialized but getTickInfo returned zero liquidityGross.`,
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
      `Block identity changed while reading ${pool.id} V4 replay snapshot.`,
    );
  }

  return {
    sqrtPriceX96,
    tick,
    liquidity,
    lpFee: BigInt(lpFee),
    protocolFee: BigInt(protocolFee),
    blockHash: blockBefore.hash,
    parentHash: blockBefore.parentHash,
    bitmapWords,
    initializedTicks,
    providerReadCount:
      2 + 2 + wordPositions.length + initializedTickIndexes.length,
    durationMs: Date.now() - startedAtMs,
  };
}

export interface CreateViemPoolStateIndexerClientOptions {
  getLogsBlockRange?: number;
}

function getLogsBlockRangeFromOptions(
  options: CreateViemPoolStateIndexerClientOptions,
): bigint {
  const value = options.getLogsBlockRange ?? DEFAULT_RPC_GET_LOGS_BLOCK_RANGE;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("getLogsBlockRange must be a positive safe integer.");
  }
  return BigInt(value);
}

export function createViemPoolStateIndexerClient(
  client: typeof baseClient,
  options: CreateViemPoolStateIndexerClientOptions = {},
): FamePoolStateIndexerClient {
  const getLogsBlockRange = getLogsBlockRangeFromOptions(options);
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
    async getClReplayLogs({ pools, fromBlock, toBlock }) {
      if (pools.length === 0) return [];
      const logs: FameClReplayRawLog[] = [];
      for (const range of boundedBlockRanges({
        fromBlock,
        toBlock,
        maxRange: getLogsBlockRange,
      })) {
        const rangeLogs = await client.getLogs({
          address: pools.map((pool) => pool.poolAddress),
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
          events: [
            ClReplaySwapEventAbi,
            ClReplayMintEventAbi,
            ClReplayBurnEventAbi,
            ClReplayCollectEventAbi,
          ],
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
    async getV4ClReplayLogs({ pools, fromBlock, toBlock }) {
      if (pools.length === 0) return [];
      const logs: FameV4ClReplayRawLog[] = [];
      for (const range of boundedBlockRanges({
        fromBlock,
        toBlock,
        maxRange: getLogsBlockRange,
      })) {
        const rangeLogs = await client.getLogs({
          address: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolManager,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
          events: [
            V4ClReplaySwapEventAbi,
            V4ClReplayModifyLiquidityEventAbi,
            V4ClReplayInitializeEventAbi,
            V4ClReplayDonateEventAbi,
          ],
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
    async getV4ClReplaySnapshot({ pool, blockNumber }) {
      return getUniswapV4ClReplaySnapshot({
        client: {
          getBlock(options) {
            return client.getBlock(options);
          },
          getSlot0({
            stateViewAddress,
            poolKey,
            blockNumber: readBlockNumber,
          }) {
            return client.readContract({
              address: stateViewAddress,
              abi: UniswapV4StateViewSlot0Abi,
              functionName: "getSlot0",
              args: [poolKey],
              blockNumber: readBlockNumber,
            });
          },
          getLiquidity({
            stateViewAddress,
            poolKey,
            blockNumber: readBlockNumber,
          }) {
            return client.readContract({
              address: stateViewAddress,
              abi: UniswapV4StateViewLiquidityAbi,
              functionName: "getLiquidity",
              args: [poolKey],
              blockNumber: readBlockNumber,
            });
          },
          getTickBitmap({
            stateViewAddress,
            poolKey,
            wordPosition,
            blockNumber: readBlockNumber,
          }) {
            return client.readContract({
              address: stateViewAddress,
              abi: UniswapV4StateViewTickBitmapAbi,
              functionName: "getTickBitmap",
              args: [poolKey, wordPosition],
              blockNumber: readBlockNumber,
            });
          },
          async getTickBitmaps({
            stateViewAddress,
            poolKey,
            wordPositions,
            blockNumber: readBlockNumber,
          }) {
            const results = await client.multicall({
              contracts: wordPositions.map((wordPosition) => ({
                address: stateViewAddress,
                abi: UniswapV4StateViewTickBitmapAbi,
                functionName: "getTickBitmap",
                args: [poolKey, wordPosition],
              })),
              blockNumber: readBlockNumber,
              allowFailure: false,
            });
            return results.map((bitmap, index) => {
              const wordPosition = wordPositions[index];
              if (wordPosition === undefined) {
                throw new Error("Missing V4 tick bitmap word position.");
              }
              return { wordPosition, bitmap };
            });
          },
          getTickInfo({
            stateViewAddress,
            poolKey,
            tick,
            blockNumber: readBlockNumber,
          }) {
            return client.readContract({
              address: stateViewAddress,
              abi: UniswapV4StateViewTickInfoAbi,
              functionName: "getTickInfo",
              args: [poolKey, tick],
              blockNumber: readBlockNumber,
            });
          },
          async getTickInfos({
            stateViewAddress,
            poolKey,
            ticks,
            blockNumber: readBlockNumber,
          }) {
            const results = await client.multicall({
              contracts: ticks.map((tick) => ({
                address: stateViewAddress,
                abi: UniswapV4StateViewTickInfoAbi,
                functionName: "getTickInfo",
                args: [poolKey, tick],
              })),
              blockNumber: readBlockNumber,
              allowFailure: false,
            });
            return results.map((state, index) => {
              const tick = ticks[index];
              if (tick === undefined) {
                throw new Error("Missing V4 initialized tick index.");
              }
              return { tick, state };
            });
          },
        },
        pool,
        blockNumber,
      });
    },
    async getClReplayFee({ pool, blockNumber }) {
      const fee = await client.readContract({
        address: requirePoolAddress(pool),
        abi: SlipstreamFeeAbi,
        functionName: "fee",
        blockNumber,
      });
      return BigInt(fee);
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
  v4ZoraProvenance,
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
  v4ZoraProvenance?: FamePoolStateV4ZoraProvenanceEvidence;
  now?: Date;
}): Promise<FamePoolStateIndexerResult> {
  const startedAtMs = Date.now();
  const pools = quoteModelPools(registry);
  const clPools = clHeadPools(registry);
  const replayPools = clReplayPools(registry);
  const v4ReplayPools = v4ClReplayPools({
    registry,
    provenance: v4ZoraProvenance,
  });
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

  const writtenEvents = 0;
  const ignoredEvents = 0;
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
      message: safeDependencyErrorMessage(result.reason),
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
  const latestClReplayCandidateStates =
    await batchGetLatestClReplayCandidateStates({
      db,
      tableName,
      pools: replayPools,
    });
  const latestClReplayCandidateByPoolId = new Map(
    latestClReplayCandidateStates.map((state) => [state.latest.poolId, state]),
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
    replayPools.length === 0 && v4ReplayPools.length === 0
      ? null
      : await readBlockIdentity({ client, blockNumber: observedThroughBlock });
  const replayFromBlockByPoolId = new Map<string, number>();
  const trustedCursorCheckByPoolId = new Map<
    string,
    ClReplayTrustedCursorCheck
  >();
  const steadyStateCheckpointBootstrapPoolIds = new Set<string>();
  for (const pool of replayPools) {
    const latest = latestClReplayByPoolId.get(pool.id) ?? null;
    const latestCandidate =
      latestClReplayCandidateByPoolId.get(pool.id) ?? null;
    const latestForMaintenance =
      pool.replaySurface === "cl-replay-v1" ? latest : latestCandidate;
    const maintenance = latestClReplayMaintenanceByPoolId.get(pool.id) ?? null;
    const canAdvanceTrustedState = clReplayMaintenanceMatchesLatest({
      maintenance,
      latest: latestForMaintenance,
      sourceRegistryId,
    });
    if (
      clReplayMaintenanceMode === "steady-state" &&
      !canAdvanceTrustedState &&
      clReplayNeedsSteadyStateCheckpointBootstrap({
        maintenance,
        latest: latestForMaintenance,
        sourceRegistryId,
      })
    ) {
      steadyStateCheckpointBootstrapPoolIds.add(pool.id);
    }
    let trustedCursorCheck: ClReplayTrustedCursorCheck = {
      canAdvance: false,
      reason: null,
    };
    if (
      (clReplayMaintenanceMode === "checkpoint" ||
        clReplayMaintenanceMode === "steady-state") &&
      canAdvanceTrustedState &&
      maintenance !== null
    ) {
      try {
        const cursorIdentity = await readBlockIdentity({
          client,
          blockNumber: maintenance.cursorBlock,
        });
        trustedCursorCheck =
          cursorIdentity.blockHash === maintenance.cursorBlockHash
            ? { canAdvance: true, reason: null }
            : { canAdvance: false, reason: "cursor-block-hash-mismatch" };
      } catch (error) {
        trustedCursorCheck = {
          canAdvance: false,
          reason: maintenanceReasonCode(errorMessage(error)),
        };
      }
    }
    trustedCursorCheckByPoolId.set(pool.id, trustedCursorCheck);
    replayFromBlockByPoolId.set(
      pool.id,
      trustedCursorCheck.canAdvance && maintenance !== null
        ? maintenance.cursorBlock + 1
        : observedThroughBlock + 1,
    );
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

  const clReplaySnapshotPools =
    clReplayMaintenanceMode !== "steady-state"
      ? replayPools
      : replayPools.filter((pool) =>
          steadyStateCheckpointBootstrapPoolIds.has(pool.id),
        );
  const clReplayReads = await Promise.allSettled(
    clReplaySnapshotPools.map(async (pool) => {
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
    const pool = clReplaySnapshotPools[index];
    if (!pool) throw new Error("CL replay read result missing pool.");
    clReplayFailures.push({
      poolId: pool.id,
      message: safeDependencyErrorMessage(result.reason),
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
    clReplayRowsByPoolId.set(pool.id, rows);
    if (pool.replaySurface === "cl-replay-v1") {
      const result = await putLatestClReplayState({
        db,
        tableName,
        rows,
      });
      if (result === "written") clReplayWrittenPools += 1;
    }
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

  const latestV4ClReplayStates = await batchGetLatestV4ClReplayStates({
    db,
    tableName,
    pools: v4ReplayPools,
  });
  const latestV4ClReplayByPoolId = new Map(
    latestV4ClReplayStates.map((state) => [state.latest.poolId, state]),
  );
  const latestV4ClReplayCandidateStates =
    await batchGetLatestV4ClReplayCandidateStates({
      db,
      tableName,
      pools: v4ReplayPools,
    });
  const latestV4ClReplayCandidateByPoolId = new Map(
    latestV4ClReplayCandidateStates.map((state) => [
      state.latest.poolId,
      state,
    ]),
  );
  const latestV4ClReplayMaintenanceStates =
    await batchGetLatestV4ClReplayMaintenanceStates({
      db,
      tableName,
      pools: v4ReplayPools,
    });
  const latestV4ClReplayMaintenanceByPoolId = new Map(
    latestV4ClReplayMaintenanceStates.map((state) => [state.poolId, state]),
  );
  const v4ReplayFromBlockByPoolId = new Map<string, number>();
  const v4TrustedCursorCheckByPoolId = new Map<
    string,
    ClReplayTrustedCursorCheck
  >();
  const v4CheckpointBootstrapPoolIds = new Set<string>();
  for (const pool of v4ReplayPools) {
    const latest = latestV4ClReplayByPoolId.get(pool.id) ?? null;
    const latestCandidate =
      latestV4ClReplayCandidateByPoolId.get(pool.id) ?? null;
    const latestForMaintenance = latest ?? latestCandidate;
    const maintenance =
      latestV4ClReplayMaintenanceByPoolId.get(pool.id) ?? null;
    const canAdvanceTrustedState = v4ClReplayMaintenanceMatchesLatest({
      maintenance,
      latest: latestForMaintenance,
      sourceRegistryId,
    });
    if (
      clReplayMaintenanceMode !== "repair" &&
      !canAdvanceTrustedState &&
      v4ClReplayNeedsCheckpointBootstrap({
        maintenance,
        latest: latestForMaintenance,
        sourceRegistryId,
      })
    ) {
      v4CheckpointBootstrapPoolIds.add(pool.id);
    }
    let trustedCursorCheck: ClReplayTrustedCursorCheck = {
      canAdvance: false,
      reason: null,
    };
    if (
      clReplayMaintenanceMode !== "repair" &&
      canAdvanceTrustedState &&
      maintenance !== null
    ) {
      try {
        const cursorIdentity = await readBlockIdentity({
          client,
          blockNumber: maintenance.cursorBlock,
        });
        trustedCursorCheck =
          cursorIdentity.blockHash === maintenance.cursorBlockHash
            ? { canAdvance: true, reason: null }
            : { canAdvance: false, reason: "cursor-block-hash-mismatch" };
      } catch (error) {
        trustedCursorCheck = {
          canAdvance: false,
          reason: maintenanceReasonCode(errorMessage(error)),
        };
      }
    }
    v4TrustedCursorCheckByPoolId.set(pool.id, trustedCursorCheck);
    v4ReplayFromBlockByPoolId.set(
      pool.id,
      trustedCursorCheck.canAdvance && maintenance !== null
        ? maintenance.cursorBlock + 1
        : observedThroughBlock + 1,
    );
  }
  const v4ReplayScanFromBlock =
    v4ReplayFromBlockByPoolId.size === 0
      ? observedThroughBlock + 1
      : Math.min(...v4ReplayFromBlockByPoolId.values());
  const v4ClReplayRawLogs =
    v4ReplayPools.length === 0 || v4ReplayScanFromBlock > observedThroughBlock
      ? []
      : await client.getV4ClReplayLogs({
          pools: v4ReplayPools,
          fromBlock: BigInt(v4ReplayScanFromBlock),
          toBlock: safeBlock,
        });
  const v4ReplayPoolByPoolKey = new Map(
    v4ReplayPools.map((pool) => [pool.poolKey.toLowerCase(), pool]),
  );
  const v4ClReplayRawLogsByPoolId = new Map<string, FameV4ClReplayRawLog[]>();
  for (const log of v4ClReplayRawLogs) {
    const poolKey = log.topics[1]?.toLowerCase();
    if (!poolKey) continue;
    const pool = v4ReplayPoolByPoolKey.get(poolKey);
    if (!pool) continue;
    const poolLogs = v4ClReplayRawLogsByPoolId.get(pool.id) ?? [];
    poolLogs.push(log);
    v4ClReplayRawLogsByPoolId.set(pool.id, poolLogs);
  }

  const v4ClReplaySnapshotPools =
    clReplayMaintenanceMode === "repair"
      ? v4ReplayPools
      : v4ReplayPools.filter((pool) =>
          v4CheckpointBootstrapPoolIds.has(pool.id),
        );
  const v4ClReplayReads = await Promise.allSettled(
    v4ClReplaySnapshotPools.map(async (pool) => {
      const snapshot = await client.getV4ClReplaySnapshot({
        pool,
        blockNumber: safeBlock,
      });
      return {
        pool,
        snapshot,
      };
    }),
  );
  const v4ClReplaySnapshots: {
    pool: V4ClReplayPool;
    snapshot: FameV4ClReplaySnapshotRead;
  }[] = [];
  const v4ClReplayFailures: FameClReplaySnapshotFailure[] = [];
  v4ClReplayReads.forEach((result, index) => {
    if (result.status === "fulfilled") {
      v4ClReplaySnapshots.push(result.value);
      return;
    }
    const pool = v4ClReplaySnapshotPools[index];
    if (!pool) throw new Error("V4 CL replay read result missing pool.");
    v4ClReplayFailures.push({
      poolId: pool.id,
      message: safeDependencyErrorMessage(result.reason),
    });
  });

  let v4ClReplayWrittenPools = 0;
  const v4ClReplayMetrics: FameV4ClReplaySnapshotMetric[] = [];
  const v4ClReplayRowsByPoolId = new Map<string, FameV4ClReplayStateRows>();
  for (const { pool, snapshot } of v4ClReplaySnapshots) {
    const evidence = eligibleV4QuoteLaneEvidence({
      pool,
      provenance: v4ZoraProvenance,
    });
    const rows = v4ClReplayRowsFromSnapshot({
      pool,
      snapshot,
      observedThroughBlock,
      ...evidence,
      sourceRegistryId,
      updatedAt,
    });
    v4ClReplayRowsByPoolId.set(pool.id, rows);
    const result = await putLatestV4ClReplayState({
      db,
      tableName,
      rows,
    });
    if (result === "written") v4ClReplayWrittenPools += 1;
    v4ClReplayMetrics.push({
      poolId: pool.id,
      bitmapWordCount: rows.latest.bitmapWordCount,
      initializedTickCount: rows.latest.initializedTickCount,
      bitmapChunkCount: rows.latest.bitmapChunkCount,
      tickChunkCount: rows.latest.tickChunkCount,
      providerReadCount: snapshot.providerReadCount,
      durationMs: snapshot.durationMs,
      stateHash: rows.latest.stateHash,
      lpFee: rows.latest.lpFee,
      protocolFee: rows.latest.protocolFee,
    });
  }

  const clReplayMaintenanceMetrics: FameClReplayMaintenanceMetric[] = [];
  for (const pool of replayPools) {
    const snapshotRows = clReplayRowsByPoolId.get(pool.id);
    const steadyStateCheckpointBootstrap =
      clReplayMaintenanceMode === "steady-state" &&
      steadyStateCheckpointBootstrapPoolIds.has(pool.id) &&
      snapshotRows !== undefined;
    const latest = latestClReplayByPoolId.get(pool.id) ?? null;
    const latestCandidate =
      latestClReplayCandidateByPoolId.get(pool.id) ?? null;
    const latestForMaintenance =
      pool.replaySurface === "cl-replay-v1" ? latest : latestCandidate;
    const maintenance = latestClReplayMaintenanceByPoolId.get(pool.id) ?? null;
    const trustedCursorCheck = trustedCursorCheckByPoolId.get(pool.id) ?? {
      canAdvance: false,
      reason: null,
    };
    const snapshotSeed = snapshotRows
      ? clReplayCapsuleFromRows(snapshotRows)
      : null;
    const seed =
      clReplayMaintenanceMode === "repair" && snapshotSeed
        ? snapshotSeed
        : (clReplayMaintenanceMode === "checkpoint" ||
              steadyStateCheckpointBootstrap) &&
            snapshotSeed &&
            !trustedCursorCheck.canAdvance
          ? snapshotSeed
          : (latestForMaintenance ?? snapshotSeed);
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
        (clReplayMaintenanceMode === "checkpoint" ||
          clReplayMaintenanceMode === "repair") &&
        snapshotRows === undefined
      ) {
        applyResult = {
          status: "event-gap",
          reason:
            trustedCursorCheck.reason ??
            `${clReplayMaintenanceMode}-snapshot-required`,
          appliedEventCount: 0,
        };
      } else if (
        clReplayMaintenanceMode === "steady-state" &&
        !trustedCursorCheck.canAdvance &&
        !steadyStateCheckpointBootstrap
      ) {
        applyResult = {
          status: "event-gap",
          reason: trustedCursorCheck.reason ?? "trusted-cursor-required",
          appliedEventCount: 0,
        };
      } else if (
        replayFromBlockForPool <= observedThroughBlock &&
        observedThroughBlock - replayFromBlockForPool + 1 >
          Math.min(
            clReplayMaxRangeBlocks,
            clReplayReducerManifestForPool(pool)?.maxMaintenanceRangeBlocks ??
              clReplayMaxRangeBlocks,
          )
      ) {
        applyResult = {
          status: "event-gap",
          reason: "range-limit",
          appliedEventCount: 0,
        };
      } else {
        const events = normalizeClReplayLogs({ pool, logs: poolLogs });
        if (targetBlockIdentity === null) {
          throw new Error("target-block-unavailable");
        }
        const fee =
          snapshotRows === undefined
            ? await client.getClReplayFee({ pool, blockNumber: safeBlock })
            : BigInt(snapshotRows.latest.fee);
        applyResult = applyClReplayDeltas({
          pool,
          seed,
          events,
          fee,
          observedThroughBlock,
          blockHash:
            snapshotRows?.latest.blockHash ?? targetBlockIdentity.blockHash,
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
        reason:
          maintenanceReasonCode(errorMessage(error)) ?? "dependency-error",
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
        snapshotRows !== undefined
          ? snapshotRows.latest.stateHash === applyResult.rows.latest.stateHash
          : clReplayMaintenanceMode === "steady-state" &&
            trustedCursorCheck.canAdvance;
      if (clReplayTrustPromotion && driftClean) {
        if (pool.replaySurface === "cl-replay-v1") {
          quoteableRows = clReplayRowsFromCandidateRows({
            pool,
            rows: applyResult.rows,
          });
          await putLatestClReplayState({
            db,
            tableName,
            rows: quoteableRows,
          });
        }
        maintenanceStatus = "trusted";
        reason = null;
      } else if (clReplayTrustPromotion) {
        maintenanceStatus = "drift-failed";
        reason = "checkpoint-state-hash-mismatch";
      } else {
        maintenanceStatus =
          clReplayMaintenanceMode === "repair" ? "repairing" : "warming";
        reason =
          clReplayMaintenanceMode === "repair"
            ? "repair-not-promoted"
            : "shadow-not-promoted";
      }
    } else {
      maintenanceStatus = applyResult.status;
      reason = applyResult.reason;
    }

    const maintenanceReason = maintenanceReasonCode(reason);
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
        reason: maintenanceReason,
        candidateId,
      },
    });

    clReplayMaintenanceMetrics.push({
      poolId: pool.id,
      status: maintenanceStatus,
      reason: maintenanceReason,
      fromBlock: fromBlockForMetric,
      toBlock: observedThroughBlock,
      scannedLogCount: poolLogs.length,
      appliedEventCount: applyResult.appliedEventCount,
      candidateWritten,
      stateHash,
    });
  }

  const v4ClReplayMaintenanceMetrics: FameClReplayMaintenanceMetric[] = [];
  for (const pool of v4ReplayPools) {
    const evidence = eligibleV4QuoteLaneEvidence({
      pool,
      provenance: v4ZoraProvenance,
    });
    const snapshotRows = v4ClReplayRowsByPoolId.get(pool.id);
    const checkpointBootstrap =
      v4CheckpointBootstrapPoolIds.has(pool.id) && snapshotRows !== undefined;
    const repairSnapshot =
      clReplayMaintenanceMode === "repair" && snapshotRows !== undefined;
    const latest = latestV4ClReplayByPoolId.get(pool.id) ?? null;
    const latestCandidate =
      latestV4ClReplayCandidateByPoolId.get(pool.id) ?? null;
    const latestForMaintenance = latest ?? latestCandidate;
    const maintenance =
      latestV4ClReplayMaintenanceByPoolId.get(pool.id) ?? null;
    const trustedCursorCheck = v4TrustedCursorCheckByPoolId.get(pool.id) ?? {
      canAdvance: false,
      reason: null,
    };
    const snapshotSeed = snapshotRows
      ? v4ClReplayCapsuleFromRows(snapshotRows)
      : null;
    const seed =
      repairSnapshot || (checkpointBootstrap && !trustedCursorCheck.canAdvance)
        ? snapshotSeed
        : (latestForMaintenance ?? snapshotSeed);
    const replayFromBlockForPool =
      v4ReplayFromBlockByPoolId.get(pool.id) ?? observedThroughBlock + 1;
    const poolLogs = (v4ClReplayRawLogsByPoolId.get(pool.id) ?? []).filter(
      (log) =>
        safeNumber(log.blockNumber, "V4 CL replay log block number") >=
        replayFromBlockForPool,
    );
    const fromBlockForMetric =
      replayFromBlockForPool > observedThroughBlock
        ? observedThroughBlock
        : replayFromBlockForPool;

    let applyResult: FameV4ClReplayDeltaApplyResult;
    try {
      if (clReplayMaintenanceMode === "repair" && snapshotRows === undefined) {
        applyResult = {
          status: "event-gap",
          reason: trustedCursorCheck.reason ?? "repair-snapshot-required",
          appliedEventCount: 0,
        };
      } else if (
        !trustedCursorCheck.canAdvance &&
        !checkpointBootstrap &&
        !repairSnapshot
      ) {
        applyResult = {
          status: "event-gap",
          reason: trustedCursorCheck.reason ?? "trusted-cursor-required",
          appliedEventCount: 0,
        };
      } else if (
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
        const events = normalizeV4ClReplayLogs({ pool, logs: poolLogs });
        if (targetBlockIdentity === null) {
          throw new Error("target-block-unavailable");
        }
        applyResult = applyV4ClReplayDeltas({
          pool,
          seed,
          events,
          observedThroughBlock,
          blockHash:
            snapshotRows?.latest.blockHash ?? targetBlockIdentity.blockHash,
          parentHash:
            snapshotRows?.latest.parentHash ?? targetBlockIdentity.parentHash,
          candidateId: `v4-cl-replay-candidate-v1:${pool.id}:${observedThroughBlock.toString()}:${sourceRegistryId}`,
          ...evidence,
          sourceRegistryId,
          updatedAt,
        });
      }
    } catch (error) {
      applyResult = {
        status: "event-gap",
        reason:
          maintenanceReasonCode(errorMessage(error)) ?? "dependency-error",
        appliedEventCount: 0,
      };
    }

    let candidateWritten = false;
    let stateHash: Hex | null = null;
    let maintenanceStatus: FameClReplayMaintenanceMetric["status"] =
      "event-gap";
    let reason: string | null = null;
    let candidateId: string | null = null;
    let quoteableRows: FameV4ClReplayStateRows | null = null;
    if (applyResult.status === "candidate") {
      const writeResult = await putLatestV4ClReplayCandidateState({
        db,
        tableName,
        rows: applyResult.rows,
      });
      candidateWritten = writeResult === "written";
      stateHash = applyResult.rows.latest.stateHash;
      candidateId = applyResult.rows.latest.candidateId;
      const driftClean =
        snapshotRows !== undefined
          ? snapshotRows.latest.stateHash === applyResult.rows.latest.stateHash
          : trustedCursorCheck.canAdvance;
      if (clReplayTrustPromotion && driftClean) {
        quoteableRows = v4ClReplayRowsFromCandidateRows({
          pool,
          rows: applyResult.rows,
        });
        await putLatestV4ClReplayState({
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
        maintenanceStatus =
          clReplayMaintenanceMode === "repair" ? "repairing" : "warming";
        reason =
          clReplayMaintenanceMode === "repair"
            ? "repair-not-promoted"
            : "shadow-not-promoted";
      }
    } else {
      maintenanceStatus = applyResult.status;
      reason = applyResult.reason;
    }

    const maintenanceReason = maintenanceReasonCode(reason);
    await putLatestV4ClReplayMaintenanceState({
      db,
      tableName,
      state: {
        ...latestV4ClReplayMaintenanceStateKey(pool),
        stateKind: "v4-cl-replay-maintenance-v1",
        poolId: pool.id,
        chainId: pool.chainId,
        poolKey: pool.poolKey,
        stateViewAddress: pool.stateViewAddress,
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
        reason: maintenanceReason,
        candidateId,
      },
    });

    v4ClReplayMaintenanceMetrics.push({
      poolId: pool.id,
      status: maintenanceStatus,
      reason: maintenanceReason,
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
    syncEvents: 0,
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
    v4ClReplaySnapshots: v4ClReplaySnapshots.length,
    v4ClReplayWrittenPools,
    v4ClReplayFailedPools: v4ClReplayFailures.length,
    v4ClReplayFailures,
    v4ClReplayMetrics,
    v4ClReplayMaintenanceMetrics,
    clReplayMaintenanceMetrics,
    sourceRegistryId,
  };
}
