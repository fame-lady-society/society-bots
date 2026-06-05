import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { isAddress, isHex, type Address, type Hex } from "viem";
import {
  FAME_POOL_STATE_REGISTRY_SCHEMA_VERSION,
  type FamePoolStateV4ZoraProvenanceEvidence,
  type FamePoolStateRegistryEntry,
  type FamePoolStateRegistrySource,
  type FamePoolStateVenueFamily,
} from "../types.ts";

type PoolStateCommand =
  | BatchGetCommand
  | GetCommand
  | PutCommand
  | UpdateCommand;

export interface PoolStateDynamoResponse {
  Item?: Record<string, unknown>;
  Responses?: Record<string, Record<string, unknown>[]>;
  UnprocessedKeys?: Record<
    string,
    {
      Keys?: Record<string, unknown>[];
    }
  >;
}

export interface PoolStateDocumentClient {
  send(command: PoolStateCommand): Promise<PoolStateDynamoResponse>;
}

export const defaultDb: PoolStateDocumentClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.DYNAMODB_REGION,
  }),
  {
    marshallOptions: {
      convertEmptyValues: true,
    },
  },
) as PoolStateDocumentClient;

export interface FamePoolStateEventVersion {
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
}

export interface FamePoolLatestState {
  pk: string;
  sk: "latest";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  reserve0: string;
  reserve1: string;
  k: string;
  lastReserveChangeBlock: number;
  lastEventTransactionIndex: number;
  lastEventLogIndex: number;
  lastEventTransactionHash: Hex | null;
  observedThroughBlock: number;
  source: "sync-event" | "getReserves";
  sourceRegistryId: string;
  updatedAt: string;
}

export type FameClHeadSource = "pool-slot0-liquidity" | "v4-state-view";

export interface FameClHeadLatestState {
  pk: string;
  sk: "cl-head-snapshot-v1";
  stateKind: "cl-head-snapshot";
  poolId: string;
  chainId: number;
  poolAddress: Address | null;
  poolKey: Hex | null;
  token0: Address;
  token1: Address;
  venueFamily: FamePoolStateVenueFamily;
  feeBps: number;
  feeLabel: string;
  tickSpacing: number;
  stateViewAddress: Address | null;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  observedThroughBlock: number;
  source: FameClHeadSource;
  sourceRegistryId: string;
  updatedAt: string;
}

export type FameClReplaySource = "slipstream-pool-state";
export type FameV4ClReplaySource = "uniswap-v4-state-view";
export type FameV4ZoraVerifiedProvenance = Extract<
  FamePoolStateV4ZoraProvenanceEvidence,
  { status: "verified" }
>;

export interface FameClReplayBitmapWord {
  wordPosition: number;
  bitmap: Hex;
}

export interface FameClReplayInitializedTick {
  tick: number;
  liquidityGross: string;
  liquidityNet: string;
}

export interface FameClReplayLatestState extends Record<string, unknown> {
  pk: string;
  sk: "cl-replay-v1";
  stateKind: "cl-replay-v1";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  venueFamily: FamePoolStateVenueFamily;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  fee: string;
  feeSource: "pool-fee";
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  source: FameClReplaySource;
  sourceRegistryId: string;
  updatedAt: string;
  bitmapWordCount: number;
  initializedTickCount: number;
  bitmapChunkCount: number;
  tickChunkCount: number;
  minWordPosition: number | null;
  maxWordPosition: number | null;
  minTick: number | null;
  maxTick: number | null;
}

export type FameClReplayMaintenanceStatus =
  | "trusted"
  | "warming"
  | "drift-failed"
  | "repairing"
  | "event-gap";

export interface FameClReplayMaintenanceState extends Record<string, unknown> {
  pk: string;
  sk: "cl-replay-maintenance-v1";
  stateKind: "cl-replay-maintenance-v1";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  status: FameClReplayMaintenanceStatus;
  cursorBlock: number;
  cursorBlockHash: Hex;
  cursorTransactionIndex: number;
  cursorLogIndex: number;
  targetBlock: number;
  targetBlockHash: Hex;
  stateHash: Hex;
  sourceRegistryId: string;
  updatedAt: string;
  lastCheckpointBlock: number | null;
  lastCheckpointBlockHash: Hex | null;
  reason: string | null;
  candidateId: string | null;
}

export interface FameClReplayCandidateLatestState
  extends Record<string, unknown> {
  pk: string;
  sk: "cl-replay-candidate-v1";
  stateKind: "cl-replay-candidate-v1";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  venueFamily: FamePoolStateVenueFamily;
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  fee: string;
  feeSource: "pool-fee";
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  candidateId: string;
  stateHash: Hex;
  source: FameClReplaySource;
  sourceRegistryId: string;
  updatedAt: string;
  bitmapWordCount: number;
  initializedTickCount: number;
  bitmapChunkCount: number;
  tickChunkCount: number;
  minWordPosition: number | null;
  maxWordPosition: number | null;
  minTick: number | null;
  maxTick: number | null;
}

export interface FameV4ClReplayLatestState extends Record<string, unknown> {
  pk: string;
  sk: "v4-cl-replay-v1";
  stateKind: "v4-cl-replay-v1";
  poolId: string;
  chainId: number;
  poolKey: Hex;
  stateViewAddress: Address;
  token0: Address;
  token1: Address;
  venueFamily: "UniswapV4";
  tickSpacing: number;
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  lpFee: string;
  protocolFee: string;
  feeSource: "v4-slot0";
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  source: FameV4ClReplaySource;
  zoraProvenance: FameV4ZoraVerifiedProvenance;
  sourceRegistryId: string;
  updatedAt: string;
  bitmapWordCount: number;
  initializedTickCount: number;
  bitmapChunkCount: number;
  tickChunkCount: number;
  minWordPosition: number | null;
  maxWordPosition: number | null;
  minTick: number | null;
  maxTick: number | null;
}

export type FameClReplayBitmapChunkSortKey =
  `cl-replay-v1:${string}:bitmap:${number}`;

export type FameClReplayTickChunkSortKey =
  `cl-replay-v1:${string}:tick:${number}`;

export type FameClReplayCandidateBitmapChunkSortKey =
  `cl-replay-candidate-v1:${string}:bitmap:${number}`;

export type FameClReplayCandidateTickChunkSortKey =
  `cl-replay-candidate-v1:${string}:tick:${number}`;

export type FameV4ClReplayBitmapChunkSortKey =
  `v4-cl-replay-v1:${string}:bitmap:${number}`;

export type FameV4ClReplayTickChunkSortKey =
  `v4-cl-replay-v1:${string}:tick:${number}`;

export interface FameClReplayBitmapChunkState extends Record<string, unknown> {
  pk: string;
  sk: FameClReplayBitmapChunkSortKey;
  stateKind: "cl-replay-bitmap-chunk-v1";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  source: FameClReplaySource;
  sourceRegistryId: string;
  updatedAt: string;
  expiresAt: number;
  chunkIndex: number;
  bitmapWords: FameClReplayBitmapWord[];
}

export interface FameClReplayTickChunkState extends Record<string, unknown> {
  pk: string;
  sk: FameClReplayTickChunkSortKey;
  stateKind: "cl-replay-tick-chunk-v1";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  source: FameClReplaySource;
  sourceRegistryId: string;
  updatedAt: string;
  expiresAt: number;
  chunkIndex: number;
  initializedTicks: FameClReplayInitializedTick[];
}

export interface FameClReplayCandidateBitmapChunkState
  extends Record<string, unknown> {
  pk: string;
  sk: FameClReplayCandidateBitmapChunkSortKey;
  stateKind: "cl-replay-candidate-bitmap-chunk-v1";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  candidateId: string;
  stateHash: Hex;
  source: FameClReplaySource;
  sourceRegistryId: string;
  updatedAt: string;
  expiresAt: number;
  chunkIndex: number;
  bitmapWords: FameClReplayBitmapWord[];
}

export interface FameClReplayCandidateTickChunkState
  extends Record<string, unknown> {
  pk: string;
  sk: FameClReplayCandidateTickChunkSortKey;
  stateKind: "cl-replay-candidate-tick-chunk-v1";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  candidateId: string;
  stateHash: Hex;
  source: FameClReplaySource;
  sourceRegistryId: string;
  updatedAt: string;
  expiresAt: number;
  chunkIndex: number;
  initializedTicks: FameClReplayInitializedTick[];
}

export interface FameV4ClReplayBitmapChunkState
  extends Record<string, unknown> {
  pk: string;
  sk: FameV4ClReplayBitmapChunkSortKey;
  stateKind: "v4-cl-replay-bitmap-chunk-v1";
  poolId: string;
  chainId: number;
  poolKey: Hex;
  stateViewAddress: Address;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  source: FameV4ClReplaySource;
  sourceRegistryId: string;
  updatedAt: string;
  expiresAt: number;
  chunkIndex: number;
  bitmapWords: FameClReplayBitmapWord[];
}

export interface FameV4ClReplayTickChunkState
  extends Record<string, unknown> {
  pk: string;
  sk: FameV4ClReplayTickChunkSortKey;
  stateKind: "v4-cl-replay-tick-chunk-v1";
  poolId: string;
  chainId: number;
  poolKey: Hex;
  stateViewAddress: Address;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  source: FameV4ClReplaySource;
  sourceRegistryId: string;
  updatedAt: string;
  expiresAt: number;
  chunkIndex: number;
  initializedTicks: FameClReplayInitializedTick[];
}

export interface FameClReplayStateRows {
  latest: FameClReplayLatestState;
  bitmapChunks: FameClReplayBitmapChunkState[];
  tickChunks: FameClReplayTickChunkState[];
}

export interface FameClReplayStateCapsule {
  latest: FameClReplayLatestState;
  bitmapWords: FameClReplayBitmapWord[];
  initializedTicks: FameClReplayInitializedTick[];
}

export interface FameClReplayCandidateStateRows {
  latest: FameClReplayCandidateLatestState;
  bitmapChunks: FameClReplayCandidateBitmapChunkState[];
  tickChunks: FameClReplayCandidateTickChunkState[];
}

export interface FameV4ClReplayStateRows {
  latest: FameV4ClReplayLatestState;
  bitmapChunks: FameV4ClReplayBitmapChunkState[];
  tickChunks: FameV4ClReplayTickChunkState[];
}

export interface FameClReplayCandidateStateCapsule {
  latest: FameClReplayCandidateLatestState;
  bitmapWords: FameClReplayBitmapWord[];
  initializedTicks: FameClReplayInitializedTick[];
}

export interface FameV4ClReplayStateCapsule {
  latest: FameV4ClReplayLatestState;
  bitmapWords: FameClReplayBitmapWord[];
  initializedTicks: FameClReplayInitializedTick[];
}

export interface FamePoolStateCursor {
  pk: string;
  sk: "cursor";
  chainId: number;
  observedThroughBlock: number;
  sourceRegistryId: string;
  updatedAt: string;
}

export type PutLatestPoolStateResult = "written" | "ignored";

export type FameClHeadSnapshotRegistryEntry = FamePoolStateRegistryEntry & {
  stateSurface: "cl-head-snapshot";
  tickSpacing: number;
};

export type FameClReplayRegistryEntry = FameClHeadSnapshotRegistryEntry & {
  venue: "aerodrome-slipstream";
  poolAddress: Address;
};

export type FameV4ClReplayRegistryEntry = FameClHeadSnapshotRegistryEntry & {
  venue: "uniswap-v4";
  poolAddress: null;
  poolKey: Hex;
  stateViewAddress: Address;
  venueFamily: "UniswapV4";
};

export class PoolStateIncompleteBatchReadError extends Error {
  constructor(tableName: string, unprocessedKeyCount: number) {
    super(
      `DynamoDB returned ${unprocessedKeyCount.toString()} unprocessed keys for ${tableName} batch read.`,
    );
    this.name = "PoolStateIncompleteBatchReadError";
  }
}

export class PoolStateInvalidItemError extends Error {
  constructor(recordType: string, field: string, message: string) {
    super(`Invalid ${recordType} DynamoDB item at ${field}: ${message}.`);
    this.name = "PoolStateInvalidItemError";
  }
}

export function latestPoolStateKey(
  chainId: number,
  poolAddress: Address,
): { pk: string; sk: "latest" } {
  return {
    pk: `pool:${chainId.toString()}:${poolAddress.toLowerCase()}`,
    sk: "latest",
  };
}

function clHeadPoolIdentity(pool: FameClHeadSnapshotRegistryEntry): string {
  if (pool.poolAddress !== null) {
    return `address:${pool.poolAddress.toLowerCase()}`;
  }
  if (pool.poolKey !== null) return `pool-key:${pool.poolKey.toLowerCase()}`;
  throw new Error(`CL head pool ${pool.id} must have poolAddress or poolKey.`);
}

export function latestClHeadStateKey(pool: FameClHeadSnapshotRegistryEntry): {
  pk: string;
  sk: "cl-head-snapshot-v1";
} {
  return {
    pk: `pool:${pool.chainId.toString()}:${clHeadPoolIdentity(pool)}`,
    sk: "cl-head-snapshot-v1",
  };
}

function clReplayPoolIdentity(pool: FameClReplayRegistryEntry): string {
  return `address:${pool.poolAddress.toLowerCase()}`;
}

function v4ClReplayPoolIdentity(pool: {
  poolKey: Hex;
}): string {
  return `pool-key:${pool.poolKey.toLowerCase()}`;
}

export function latestClReplayStateKey(pool: FameClReplayRegistryEntry): {
  pk: string;
  sk: "cl-replay-v1";
} {
  return {
    pk: `pool:${pool.chainId.toString()}:${clReplayPoolIdentity(pool)}`,
    sk: "cl-replay-v1",
  };
}

export function latestClReplayMaintenanceStateKey(
  pool: FameClReplayRegistryEntry,
): {
  pk: string;
  sk: "cl-replay-maintenance-v1";
} {
  return {
    pk: `pool:${pool.chainId.toString()}:${clReplayPoolIdentity(pool)}`,
    sk: "cl-replay-maintenance-v1",
  };
}

export function latestClReplayCandidateStateKey(
  pool: FameClReplayRegistryEntry,
): {
  pk: string;
  sk: "cl-replay-candidate-v1";
} {
  return {
    pk: `pool:${pool.chainId.toString()}:${clReplayPoolIdentity(pool)}`,
    sk: "cl-replay-candidate-v1",
  };
}

export function latestV4ClReplayStateKey(pool: {
  chainId: number;
  poolKey: Hex;
}): {
  pk: string;
  sk: "v4-cl-replay-v1";
} {
  return {
    pk: `pool:${pool.chainId.toString()}:${v4ClReplayPoolIdentity(pool)}`,
    sk: "v4-cl-replay-v1",
  };
}

function clReplayAddressKey(chainId: number, poolAddress: Address): string {
  return `pool:${chainId.toString()}:address:${poolAddress.toLowerCase()}`;
}

function clReplayBitmapChunkKey(
  pool: { chainId: number; poolAddress: Address },
  snapshotId: string,
  chunkIndex: number,
): { pk: string; sk: FameClReplayBitmapChunkSortKey } {
  return {
    pk: clReplayAddressKey(pool.chainId, pool.poolAddress),
    sk: `cl-replay-v1:${snapshotId}:bitmap:${chunkIndex}`,
  };
}

function clReplayTickChunkKey(
  pool: { chainId: number; poolAddress: Address },
  snapshotId: string,
  chunkIndex: number,
): { pk: string; sk: FameClReplayTickChunkSortKey } {
  return {
    pk: clReplayAddressKey(pool.chainId, pool.poolAddress),
    sk: `cl-replay-v1:${snapshotId}:tick:${chunkIndex}`,
  };
}

function clReplayCandidateBitmapChunkKey(
  pool: { chainId: number; poolAddress: Address },
  candidateId: string,
  chunkIndex: number,
): { pk: string; sk: FameClReplayCandidateBitmapChunkSortKey } {
  return {
    pk: clReplayAddressKey(pool.chainId, pool.poolAddress),
    sk: `cl-replay-candidate-v1:${candidateId}:bitmap:${chunkIndex}`,
  };
}

function clReplayCandidateTickChunkKey(
  pool: { chainId: number; poolAddress: Address },
  candidateId: string,
  chunkIndex: number,
): { pk: string; sk: FameClReplayCandidateTickChunkSortKey } {
  return {
    pk: clReplayAddressKey(pool.chainId, pool.poolAddress),
    sk: `cl-replay-candidate-v1:${candidateId}:tick:${chunkIndex}`,
  };
}

function v4ClReplayBitmapChunkKey(
  pool: { chainId: number; poolKey: Hex },
  snapshotId: string,
  chunkIndex: number,
): { pk: string; sk: FameV4ClReplayBitmapChunkSortKey } {
  return {
    pk: `pool:${pool.chainId.toString()}:${v4ClReplayPoolIdentity(pool)}`,
    sk: `v4-cl-replay-v1:${snapshotId}:bitmap:${chunkIndex}`,
  };
}

function v4ClReplayTickChunkKey(
  pool: { chainId: number; poolKey: Hex },
  snapshotId: string,
  chunkIndex: number,
): { pk: string; sk: FameV4ClReplayTickChunkSortKey } {
  return {
    pk: `pool:${pool.chainId.toString()}:${v4ClReplayPoolIdentity(pool)}`,
    sk: `v4-cl-replay-v1:${snapshotId}:tick:${chunkIndex}`,
  };
}

export function cursorKey(chainId: number): { pk: string; sk: "cursor" } {
  return {
    pk: `cursor:${chainId.toString()}:quote-model-v1`,
    sk: "cursor",
  };
}

export function sourceRegistryIdFor(
  registrySource: Pick<
    FamePoolStateRegistrySource,
    "poolsJsonHash" | "solverRoutesJsonHash" | "activationLedgerHash"
  >,
): string {
  return `pool-state-registry-v${FAME_POOL_STATE_REGISTRY_SCHEMA_VERSION.toString()}:${registrySource.poolsJsonHash}:${registrySource.solverRoutesJsonHash}:${registrySource.activationLedgerHash}`;
}

export function comparePoolStateEventVersions(
  left: FamePoolStateEventVersion,
  right: FamePoolStateEventVersion,
): number {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber - right.blockNumber;
  }
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}

function itemToLatestPoolState(
  item?: Record<string, unknown> | null,
): FamePoolLatestState | null {
  return item ? parseLatestPoolStateItem(item) : null;
}

function itemToCursor(
  item?: Record<string, unknown> | null,
): FamePoolStateCursor | null {
  return item ? parseCursorItem(item) : null;
}

function itemToLatestClHeadState(
  item?: Record<string, unknown> | null,
): FameClHeadLatestState | null {
  return item ? parseLatestClHeadStateItem(item) : null;
}

function itemToLatestClReplayState(
  item?: Record<string, unknown> | null,
): FameClReplayLatestState | null {
  return item ? parseLatestClReplayStateItem(item) : null;
}

function itemToLatestClReplayMaintenanceState(
  item?: Record<string, unknown> | null,
): FameClReplayMaintenanceState | null {
  return item ? parseLatestClReplayMaintenanceStateItem(item) : null;
}

function itemToLatestClReplayCandidateState(
  item?: Record<string, unknown> | null,
): FameClReplayCandidateLatestState | null {
  return item ? parseLatestClReplayCandidateStateItem(item) : null;
}

function itemToLatestV4ClReplayState(
  item?: Record<string, unknown> | null,
): FameV4ClReplayLatestState | null {
  return item ? parseLatestV4ClReplayStateItem(item) : null;
}

function invalidItem(
  recordType: string,
  field: string,
  message: string,
): never {
  throw new PoolStateInvalidItemError(recordType, field, message);
}

function stringField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): string {
  const value = item[field];
  if (typeof value !== "string" || value.length === 0) {
    invalidItem(recordType, field, "expected a non-empty string");
  }
  return value;
}

function numberField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): number {
  const value = item[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidItem(recordType, field, "expected a non-negative safe integer");
  }
  return value;
}

function integerField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): number {
  const value = item[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    invalidItem(recordType, field, "expected a safe integer");
  }
  return value;
}

function finiteNumberField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): number {
  const value = item[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidItem(recordType, field, "expected a finite number");
  }
  return value;
}

function nullableIntegerField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): number | null {
  const value = item[field];
  if (value === null) return null;
  return integerField(item, recordType, field);
}

function nullableStringField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): string | null {
  const value = item[field];
  if (value === null) return null;
  return stringField(item, recordType, field);
}

function recordField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): Record<string, unknown> {
  const value = item[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidItem(recordType, field, "expected an object");
  }
  return value as Record<string, unknown>;
}

function nullableBytes32HexField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): Hex | null {
  const value = item[field];
  if (value === null) return null;
  return bytes32HexField(item, recordType, field);
}

function decimalStringField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): string {
  const value = stringField(item, recordType, field);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    invalidItem(recordType, field, "expected a canonical decimal string");
  }
  return value;
}

function signedDecimalStringField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): string {
  const value = stringField(item, recordType, field);
  if (!/^-?(0|[1-9][0-9]*)$/.test(value) || value === "-0") {
    invalidItem(
      recordType,
      field,
      "expected a canonical signed decimal string",
    );
  }
  return value;
}

function bytes32HexField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): Hex {
  const value = stringField(item, recordType, field);
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    invalidItem(recordType, field, "expected a canonical bytes32 hex string");
  }
  return value as Hex;
}

function uint256HexField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): Hex {
  const value = stringField(item, recordType, field);
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    invalidItem(recordType, field, "expected a canonical uint256 hex string");
  }
  return value as Hex;
}

function clReplayBitmapChunkSortKeyField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClReplayBitmapChunkSortKey {
  const value = stringField(item, recordType, field);
  if (!/^cl-replay-v1:.+:bitmap:[0-9]+$/.test(value)) {
    invalidItem(recordType, field, "expected a CL replay bitmap chunk key");
  }
  return value as FameClReplayBitmapChunkSortKey;
}

function clReplayTickChunkSortKeyField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClReplayTickChunkSortKey {
  const value = stringField(item, recordType, field);
  if (!/^cl-replay-v1:.+:tick:[0-9]+$/.test(value)) {
    invalidItem(recordType, field, "expected a CL replay tick chunk key");
  }
  return value as FameClReplayTickChunkSortKey;
}

function clReplayCandidateBitmapChunkSortKeyField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClReplayCandidateBitmapChunkSortKey {
  const value = stringField(item, recordType, field);
  if (!/^cl-replay-candidate-v1:.+:bitmap:[0-9]+$/.test(value)) {
    invalidItem(
      recordType,
      field,
      "expected a CL replay candidate bitmap chunk key",
    );
  }
  return value as FameClReplayCandidateBitmapChunkSortKey;
}

function clReplayCandidateTickChunkSortKeyField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClReplayCandidateTickChunkSortKey {
  const value = stringField(item, recordType, field);
  if (!/^cl-replay-candidate-v1:.+:tick:[0-9]+$/.test(value)) {
    invalidItem(
      recordType,
      field,
      "expected a CL replay candidate tick chunk key",
    );
  }
  return value as FameClReplayCandidateTickChunkSortKey;
}

function v4ClReplayBitmapChunkSortKeyField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameV4ClReplayBitmapChunkSortKey {
  const value = stringField(item, recordType, field);
  if (!/^v4-cl-replay-v1:.+:bitmap:[0-9]+$/.test(value)) {
    invalidItem(
      recordType,
      field,
      "expected a V4 CL replay bitmap chunk key",
    );
  }
  return value as FameV4ClReplayBitmapChunkSortKey;
}

function v4ClReplayTickChunkSortKeyField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameV4ClReplayTickChunkSortKey {
  const value = stringField(item, recordType, field);
  if (!/^v4-cl-replay-v1:.+:tick:[0-9]+$/.test(value)) {
    invalidItem(recordType, field, "expected a V4 CL replay tick chunk key");
  }
  return value as FameV4ClReplayTickChunkSortKey;
}

function arrayField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): Record<string, unknown>[] {
  const value = item[field];
  if (!Array.isArray(value)) {
    invalidItem(recordType, field, "expected an array");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      invalidItem(
        recordType,
        `${field}[${index.toString()}]`,
        "expected an object",
      );
    }
    return entry as Record<string, unknown>;
  });
}

function literalField<const Value extends string>(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
  expected: Value,
): Value {
  const value = item[field];
  if (value !== expected) {
    invalidItem(recordType, field, `expected ${expected}`);
  }
  return expected;
}

function sourceField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FamePoolLatestState["source"] {
  const value = item[field];
  if (value !== "sync-event" && value !== "getReserves") {
    invalidItem(recordType, field, "expected sync-event or getReserves");
  }
  return value;
}

function clHeadSourceField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClHeadSource {
  const value = item[field];
  if (value !== "pool-slot0-liquidity" && value !== "v4-state-view") {
    invalidItem(
      recordType,
      field,
      "expected pool-slot0-liquidity or v4-state-view",
    );
  }
  return value;
}

function clReplaySourceField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClReplaySource {
  const value = item[field];
  if (value !== "slipstream-pool-state") {
    invalidItem(recordType, field, "expected slipstream-pool-state");
  }
  return value;
}

function v4ClReplaySourceField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameV4ClReplaySource {
  const value = item[field];
  if (value !== "uniswap-v4-state-view") {
    invalidItem(recordType, field, "expected uniswap-v4-state-view");
  }
  return value;
}

function v4ZoraVerifiedProvenanceField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameV4ZoraVerifiedProvenance {
  const provenance = recordField(item, recordType, field);
  return {
    status: literalField(provenance, recordType, "status", "verified"),
    source: v4ZoraProvenanceSourceField(provenance, recordType, "source"),
    chainId: v4ZoraProvenanceChainIdField(
      provenance,
      recordType,
      "chainId",
    ),
    factoryAddress: addressField(provenance, recordType, "factoryAddress"),
    coinAddress: addressField(provenance, recordType, "coinAddress"),
    poolKey: bytes32HexField(provenance, recordType, "poolKey"),
    poolId: bytes32HexField(provenance, recordType, "poolId"),
    transactionHash: bytes32HexField(
      provenance,
      recordType,
      "transactionHash",
    ),
    eventName: nullableStringField(provenance, recordType, "eventName"),
  };
}

function v4ZoraProvenanceChainIdField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): 8453 {
  const value = item[field];
  if (value !== 8453) {
    invalidItem(recordType, field, "expected chain id 8453");
  }
  return 8453;
}

function v4ZoraProvenanceSourceField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameV4ZoraVerifiedProvenance["source"] {
  const value = item[field];
  if (
    value !== "zora-factory-event" &&
    value !== "zora-factory-transaction-trace"
  ) {
    invalidItem(
      recordType,
      field,
      "expected a Zora provenance evidence source",
    );
  }
  return value;
}

function clReplayMaintenanceStatusField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClReplayMaintenanceStatus {
  const value = item[field];
  if (
    value !== "trusted" &&
    value !== "warming" &&
    value !== "drift-failed" &&
    value !== "repairing" &&
    value !== "event-gap"
  ) {
    invalidItem(
      recordType,
      field,
      "expected trusted, warming, drift-failed, repairing, or event-gap",
    );
  }
  return value;
}

function venueFamilyField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): FamePoolStateVenueFamily {
  const value = item[field];
  if (
    value !== "AerodromeV2" &&
    value !== "NativeWrap" &&
    value !== "Slipstream" &&
    value !== "Slipstream2" &&
    value !== "Solidly" &&
    value !== "UniswapV2" &&
    value !== "UniswapV3" &&
    value !== "UniswapV4"
  ) {
    invalidItem(recordType, field, "expected a FAME pool venue family");
  }
  return value;
}

function addressField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): Address {
  const value = stringField(item, recordType, field);
  if (!isAddress(value, { strict: false })) {
    invalidItem(recordType, field, "expected an EVM address");
  }
  return value as Address;
}

function nullableAddressField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): Address | null {
  const value = item[field];
  if (value === null) return null;
  return addressField(item, recordType, field);
}

function nullableHexField(
  item: Record<string, unknown>,
  recordType: string,
  field: string,
): Hex | null {
  const value = item[field];
  if (value === null) return null;
  if (typeof value !== "string" || !isHex(value)) {
    invalidItem(recordType, field, "expected a hex string or null");
  }
  return value;
}

function parseLatestPoolStateItem(
  item: Record<string, unknown>,
): FamePoolLatestState {
  const recordType = "latest pool-state";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: literalField(item, recordType, "sk", "latest"),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: addressField(item, recordType, "poolAddress"),
    token0: addressField(item, recordType, "token0"),
    token1: addressField(item, recordType, "token1"),
    reserve0: stringField(item, recordType, "reserve0"),
    reserve1: stringField(item, recordType, "reserve1"),
    k: stringField(item, recordType, "k"),
    lastReserveChangeBlock: numberField(
      item,
      recordType,
      "lastReserveChangeBlock",
    ),
    lastEventTransactionIndex: numberField(
      item,
      recordType,
      "lastEventTransactionIndex",
    ),
    lastEventLogIndex: numberField(item, recordType, "lastEventLogIndex"),
    lastEventTransactionHash: nullableHexField(
      item,
      recordType,
      "lastEventTransactionHash",
    ),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    source: sourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
  };
}

function parseLatestClHeadStateItem(
  item: Record<string, unknown>,
): FameClHeadLatestState {
  const recordType = "latest CL head-state";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: literalField(item, recordType, "sk", "cl-head-snapshot-v1"),
    stateKind: literalField(item, recordType, "stateKind", "cl-head-snapshot"),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: nullableAddressField(item, recordType, "poolAddress"),
    poolKey: nullableHexField(item, recordType, "poolKey"),
    token0: addressField(item, recordType, "token0"),
    token1: addressField(item, recordType, "token1"),
    venueFamily: venueFamilyField(item, recordType, "venueFamily"),
    feeBps: finiteNumberField(item, recordType, "feeBps"),
    feeLabel: stringField(item, recordType, "feeLabel"),
    tickSpacing: numberField(item, recordType, "tickSpacing"),
    stateViewAddress: nullableAddressField(
      item,
      recordType,
      "stateViewAddress",
    ),
    sqrtPriceX96: stringField(item, recordType, "sqrtPriceX96"),
    tick: integerField(item, recordType, "tick"),
    liquidity: stringField(item, recordType, "liquidity"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    source: clHeadSourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
  };
}

function parseReplayBitmapWord(
  value: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClReplayBitmapWord {
  const wordPosition = value.wordPosition;
  const bitmap = value.bitmap;
  if (typeof wordPosition !== "number" || !Number.isSafeInteger(wordPosition)) {
    invalidItem(recordType, `${field}.wordPosition`, "expected a safe integer");
  }
  if (typeof bitmap !== "string" || !/^0x[0-9a-f]{64}$/.test(bitmap)) {
    invalidItem(
      recordType,
      `${field}.bitmap`,
      "expected a canonical uint256 hex string",
    );
  }
  return {
    wordPosition,
    bitmap: bitmap as Hex,
  };
}

function parseReplayInitializedTick(
  value: Record<string, unknown>,
  recordType: string,
  field: string,
): FameClReplayInitializedTick {
  const tick = value.tick;
  const liquidityGross = value.liquidityGross;
  const liquidityNet = value.liquidityNet;
  if (typeof tick !== "number" || !Number.isSafeInteger(tick)) {
    invalidItem(recordType, `${field}.tick`, "expected a safe integer");
  }
  if (
    typeof liquidityGross !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(liquidityGross)
  ) {
    invalidItem(
      recordType,
      `${field}.liquidityGross`,
      "expected a canonical decimal string",
    );
  }
  if (
    typeof liquidityNet !== "string" ||
    !/^-?(0|[1-9][0-9]*)$/.test(liquidityNet) ||
    liquidityNet === "-0"
  ) {
    invalidItem(
      recordType,
      `${field}.liquidityNet`,
      "expected a canonical signed decimal string",
    );
  }
  return {
    tick,
    liquidityGross,
    liquidityNet,
  };
}

function parseLatestClReplayStateItem(
  item: Record<string, unknown>,
): FameClReplayLatestState {
  const recordType = "latest CL replay-state";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: literalField(item, recordType, "sk", "cl-replay-v1"),
    stateKind: literalField(item, recordType, "stateKind", "cl-replay-v1"),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: addressField(item, recordType, "poolAddress"),
    token0: addressField(item, recordType, "token0"),
    token1: addressField(item, recordType, "token1"),
    venueFamily: venueFamilyField(item, recordType, "venueFamily"),
    tickSpacing: numberField(item, recordType, "tickSpacing"),
    sqrtPriceX96: decimalStringField(item, recordType, "sqrtPriceX96"),
    tick: integerField(item, recordType, "tick"),
    liquidity: decimalStringField(item, recordType, "liquidity"),
    fee: decimalStringField(item, recordType, "fee"),
    feeSource: literalField(item, recordType, "feeSource", "pool-fee"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    snapshotId: stringField(item, recordType, "snapshotId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: clReplaySourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    bitmapWordCount: numberField(item, recordType, "bitmapWordCount"),
    initializedTickCount: numberField(item, recordType, "initializedTickCount"),
    bitmapChunkCount: numberField(item, recordType, "bitmapChunkCount"),
    tickChunkCount: numberField(item, recordType, "tickChunkCount"),
    minWordPosition: nullableIntegerField(item, recordType, "minWordPosition"),
    maxWordPosition: nullableIntegerField(item, recordType, "maxWordPosition"),
    minTick: nullableIntegerField(item, recordType, "minTick"),
    maxTick: nullableIntegerField(item, recordType, "maxTick"),
  };
}

function parseLatestClReplayMaintenanceStateItem(
  item: Record<string, unknown>,
): FameClReplayMaintenanceState {
  const recordType = "CL replay maintenance";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: literalField(item, recordType, "sk", "cl-replay-maintenance-v1"),
    stateKind: literalField(
      item,
      recordType,
      "stateKind",
      "cl-replay-maintenance-v1",
    ),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: addressField(item, recordType, "poolAddress"),
    status: clReplayMaintenanceStatusField(item, recordType, "status"),
    cursorBlock: numberField(item, recordType, "cursorBlock"),
    cursorBlockHash: bytes32HexField(item, recordType, "cursorBlockHash"),
    cursorTransactionIndex: numberField(
      item,
      recordType,
      "cursorTransactionIndex",
    ),
    cursorLogIndex: numberField(item, recordType, "cursorLogIndex"),
    targetBlock: numberField(item, recordType, "targetBlock"),
    targetBlockHash: bytes32HexField(item, recordType, "targetBlockHash"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    lastCheckpointBlock: nullableIntegerField(
      item,
      recordType,
      "lastCheckpointBlock",
    ),
    lastCheckpointBlockHash: nullableBytes32HexField(
      item,
      recordType,
      "lastCheckpointBlockHash",
    ),
    reason: nullableStringField(item, recordType, "reason"),
    candidateId: nullableStringField(item, recordType, "candidateId"),
  };
}

function parseLatestClReplayCandidateStateItem(
  item: Record<string, unknown>,
): FameClReplayCandidateLatestState {
  const recordType = "latest CL replay candidate";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: literalField(item, recordType, "sk", "cl-replay-candidate-v1"),
    stateKind: literalField(
      item,
      recordType,
      "stateKind",
      "cl-replay-candidate-v1",
    ),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: addressField(item, recordType, "poolAddress"),
    token0: addressField(item, recordType, "token0"),
    token1: addressField(item, recordType, "token1"),
    venueFamily: venueFamilyField(item, recordType, "venueFamily"),
    tickSpacing: numberField(item, recordType, "tickSpacing"),
    sqrtPriceX96: decimalStringField(item, recordType, "sqrtPriceX96"),
    tick: integerField(item, recordType, "tick"),
    liquidity: decimalStringField(item, recordType, "liquidity"),
    fee: decimalStringField(item, recordType, "fee"),
    feeSource: literalField(item, recordType, "feeSource", "pool-fee"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    candidateId: stringField(item, recordType, "candidateId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: clReplaySourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    bitmapWordCount: numberField(item, recordType, "bitmapWordCount"),
    initializedTickCount: numberField(item, recordType, "initializedTickCount"),
    bitmapChunkCount: numberField(item, recordType, "bitmapChunkCount"),
    tickChunkCount: numberField(item, recordType, "tickChunkCount"),
    minWordPosition: nullableIntegerField(item, recordType, "minWordPosition"),
    maxWordPosition: nullableIntegerField(item, recordType, "maxWordPosition"),
    minTick: nullableIntegerField(item, recordType, "minTick"),
    maxTick: nullableIntegerField(item, recordType, "maxTick"),
  };
}

function parseLatestV4ClReplayStateItem(
  item: Record<string, unknown>,
): FameV4ClReplayLatestState {
  const recordType = "latest V4 CL replay-state";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: literalField(item, recordType, "sk", "v4-cl-replay-v1"),
    stateKind: literalField(item, recordType, "stateKind", "v4-cl-replay-v1"),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolKey: bytes32HexField(item, recordType, "poolKey"),
    stateViewAddress: addressField(item, recordType, "stateViewAddress"),
    token0: addressField(item, recordType, "token0"),
    token1: addressField(item, recordType, "token1"),
    venueFamily: literalField(item, recordType, "venueFamily", "UniswapV4"),
    tickSpacing: numberField(item, recordType, "tickSpacing"),
    sqrtPriceX96: decimalStringField(item, recordType, "sqrtPriceX96"),
    tick: integerField(item, recordType, "tick"),
    liquidity: decimalStringField(item, recordType, "liquidity"),
    lpFee: decimalStringField(item, recordType, "lpFee"),
    protocolFee: decimalStringField(item, recordType, "protocolFee"),
    feeSource: literalField(item, recordType, "feeSource", "v4-slot0"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    snapshotId: stringField(item, recordType, "snapshotId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: v4ClReplaySourceField(item, recordType, "source"),
    zoraProvenance: v4ZoraVerifiedProvenanceField(
      item,
      recordType,
      "zoraProvenance",
    ),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    bitmapWordCount: numberField(item, recordType, "bitmapWordCount"),
    initializedTickCount: numberField(item, recordType, "initializedTickCount"),
    bitmapChunkCount: numberField(item, recordType, "bitmapChunkCount"),
    tickChunkCount: numberField(item, recordType, "tickChunkCount"),
    minWordPosition: nullableIntegerField(item, recordType, "minWordPosition"),
    maxWordPosition: nullableIntegerField(item, recordType, "maxWordPosition"),
    minTick: nullableIntegerField(item, recordType, "minTick"),
    maxTick: nullableIntegerField(item, recordType, "maxTick"),
  };
}

function parseClReplayBitmapChunkItem(
  item: Record<string, unknown>,
): FameClReplayBitmapChunkState {
  const recordType = "CL replay bitmap chunk";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: clReplayBitmapChunkSortKeyField(item, recordType, "sk"),
    stateKind: literalField(
      item,
      recordType,
      "stateKind",
      "cl-replay-bitmap-chunk-v1",
    ),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: addressField(item, recordType, "poolAddress"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    snapshotId: stringField(item, recordType, "snapshotId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: clReplaySourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    expiresAt: numberField(item, recordType, "expiresAt"),
    chunkIndex: numberField(item, recordType, "chunkIndex"),
    bitmapWords: arrayField(item, recordType, "bitmapWords").map(
      (entry, index) =>
        parseReplayBitmapWord(
          entry,
          recordType,
          `bitmapWords[${index.toString()}]`,
        ),
    ),
  };
}

function parseClReplayTickChunkItem(
  item: Record<string, unknown>,
): FameClReplayTickChunkState {
  const recordType = "CL replay tick chunk";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: clReplayTickChunkSortKeyField(item, recordType, "sk"),
    stateKind: literalField(
      item,
      recordType,
      "stateKind",
      "cl-replay-tick-chunk-v1",
    ),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: addressField(item, recordType, "poolAddress"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    snapshotId: stringField(item, recordType, "snapshotId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: clReplaySourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    expiresAt: numberField(item, recordType, "expiresAt"),
    chunkIndex: numberField(item, recordType, "chunkIndex"),
    initializedTicks: arrayField(item, recordType, "initializedTicks").map(
      (entry, index) =>
        parseReplayInitializedTick(
          entry,
          recordType,
          `initializedTicks[${index.toString()}]`,
        ),
    ),
  };
}

function parseClReplayCandidateBitmapChunkItem(
  item: Record<string, unknown>,
): FameClReplayCandidateBitmapChunkState {
  const recordType = "CL replay candidate bitmap chunk";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: clReplayCandidateBitmapChunkSortKeyField(item, recordType, "sk"),
    stateKind: literalField(
      item,
      recordType,
      "stateKind",
      "cl-replay-candidate-bitmap-chunk-v1",
    ),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: addressField(item, recordType, "poolAddress"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    candidateId: stringField(item, recordType, "candidateId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: clReplaySourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    expiresAt: numberField(item, recordType, "expiresAt"),
    chunkIndex: numberField(item, recordType, "chunkIndex"),
    bitmapWords: arrayField(item, recordType, "bitmapWords").map(
      (entry, index) =>
        parseReplayBitmapWord(
          entry,
          recordType,
          `bitmapWords[${index.toString()}]`,
        ),
    ),
  };
}

function parseClReplayCandidateTickChunkItem(
  item: Record<string, unknown>,
): FameClReplayCandidateTickChunkState {
  const recordType = "CL replay candidate tick chunk";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: clReplayCandidateTickChunkSortKeyField(item, recordType, "sk"),
    stateKind: literalField(
      item,
      recordType,
      "stateKind",
      "cl-replay-candidate-tick-chunk-v1",
    ),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolAddress: addressField(item, recordType, "poolAddress"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    candidateId: stringField(item, recordType, "candidateId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: clReplaySourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    expiresAt: numberField(item, recordType, "expiresAt"),
    chunkIndex: numberField(item, recordType, "chunkIndex"),
    initializedTicks: arrayField(item, recordType, "initializedTicks").map(
      (entry, index) =>
        parseReplayInitializedTick(
          entry,
          recordType,
          `initializedTicks[${index.toString()}]`,
        ),
    ),
  };
}

function parseV4ClReplayBitmapChunkItem(
  item: Record<string, unknown>,
): FameV4ClReplayBitmapChunkState {
  const recordType = "V4 CL replay bitmap chunk";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: v4ClReplayBitmapChunkSortKeyField(item, recordType, "sk"),
    stateKind: literalField(
      item,
      recordType,
      "stateKind",
      "v4-cl-replay-bitmap-chunk-v1",
    ),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolKey: bytes32HexField(item, recordType, "poolKey"),
    stateViewAddress: addressField(item, recordType, "stateViewAddress"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    snapshotId: stringField(item, recordType, "snapshotId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: v4ClReplaySourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    expiresAt: numberField(item, recordType, "expiresAt"),
    chunkIndex: numberField(item, recordType, "chunkIndex"),
    bitmapWords: arrayField(item, recordType, "bitmapWords").map(
      (entry, index) =>
        parseReplayBitmapWord(
          entry,
          recordType,
          `bitmapWords[${index.toString()}]`,
        ),
    ),
  };
}

function parseV4ClReplayTickChunkItem(
  item: Record<string, unknown>,
): FameV4ClReplayTickChunkState {
  const recordType = "V4 CL replay tick chunk";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: v4ClReplayTickChunkSortKeyField(item, recordType, "sk"),
    stateKind: literalField(
      item,
      recordType,
      "stateKind",
      "v4-cl-replay-tick-chunk-v1",
    ),
    poolId: stringField(item, recordType, "poolId"),
    chainId: numberField(item, recordType, "chainId"),
    poolKey: bytes32HexField(item, recordType, "poolKey"),
    stateViewAddress: addressField(item, recordType, "stateViewAddress"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    blockHash: bytes32HexField(item, recordType, "blockHash"),
    parentHash: bytes32HexField(item, recordType, "parentHash"),
    snapshotId: stringField(item, recordType, "snapshotId"),
    stateHash: bytes32HexField(item, recordType, "stateHash"),
    source: v4ClReplaySourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
    expiresAt: numberField(item, recordType, "expiresAt"),
    chunkIndex: numberField(item, recordType, "chunkIndex"),
    initializedTicks: arrayField(item, recordType, "initializedTicks").map(
      (entry, index) =>
        parseReplayInitializedTick(
          entry,
          recordType,
          `initializedTicks[${index.toString()}]`,
        ),
    ),
  };
}

function parseCursorItem(item: Record<string, unknown>): FamePoolStateCursor {
  const recordType = "pool-state cursor";
  return {
    pk: stringField(item, recordType, "pk"),
    sk: literalField(item, recordType, "sk", "cursor"),
    chainId: numberField(item, recordType, "chainId"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
  };
}

function unprocessedKeyCount(
  response: PoolStateDynamoResponse,
  tableName: string,
): number {
  return response.UnprocessedKeys?.[tableName]?.Keys?.length ?? 0;
}

function dynamoKeyString(key: { pk: string; sk: string }): string {
  return `${key.pk}\u0000${key.sk}`;
}

function itemDynamoKeyString(
  item: Record<string, unknown>,
  recordType: string,
): string {
  return dynamoKeyString({
    pk: stringField(item, recordType, "pk"),
    sk: stringField(item, recordType, "sk"),
  });
}

async function batchGetPoolStateItems({
  db,
  tableName,
  keys,
}: {
  db: PoolStateDocumentClient;
  tableName: string;
  keys: readonly { pk: string; sk: string }[];
}): Promise<Record<string, unknown>[]> {
  const batchSize = 100;
  const items: Record<string, unknown>[] = [];
  for (let index = 0; index < keys.length; index += batchSize) {
    const response = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: keys.slice(index, index + batchSize),
          },
        },
      }),
    );
    const incompleteKeyCount = unprocessedKeyCount(response, tableName);
    if (incompleteKeyCount > 0) {
      throw new PoolStateIncompleteBatchReadError(
        tableName,
        incompleteKeyCount,
      );
    }
    items.push(...(response.Responses?.[tableName] ?? []));
  }
  return items;
}

function replayChunkMatchesLatest(
  latest: FameClReplayLatestState,
  chunk: FameClReplayBitmapChunkState | FameClReplayTickChunkState,
): boolean {
  return (
    chunk.pk === latest.pk &&
    chunk.poolId === latest.poolId &&
    chunk.chainId === latest.chainId &&
    chunk.poolAddress.toLowerCase() === latest.poolAddress.toLowerCase() &&
    chunk.observedThroughBlock === latest.observedThroughBlock &&
    chunk.blockHash === latest.blockHash &&
    chunk.parentHash === latest.parentHash &&
    chunk.snapshotId === latest.snapshotId &&
    chunk.stateHash === latest.stateHash &&
    chunk.source === latest.source &&
    chunk.sourceRegistryId === latest.sourceRegistryId
  );
}

function strictlyIncreasingNumbers(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) return false;
  }
  return true;
}

function replayCapsuleMatchesPointer(
  latest: FameClReplayLatestState,
  bitmapWords: readonly FameClReplayBitmapWord[],
  initializedTicks: readonly FameClReplayInitializedTick[],
): boolean {
  const wordPositions = bitmapWords.map((word) => word.wordPosition);
  const tickIndexes = initializedTicks.map((tick) => tick.tick);
  return (
    bitmapWords.length === latest.bitmapWordCount &&
    initializedTicks.length === latest.initializedTickCount &&
    minOrNull(wordPositions) === latest.minWordPosition &&
    maxOrNull(wordPositions) === latest.maxWordPosition &&
    minOrNull(tickIndexes) === latest.minTick &&
    maxOrNull(tickIndexes) === latest.maxTick &&
    strictlyIncreasingNumbers(wordPositions) &&
    strictlyIncreasingNumbers(tickIndexes)
  );
}

function replayCandidateChunkMatchesLatest(
  latest: FameClReplayCandidateLatestState,
  chunk:
    | FameClReplayCandidateBitmapChunkState
    | FameClReplayCandidateTickChunkState,
): boolean {
  return (
    chunk.pk === latest.pk &&
    chunk.poolId === latest.poolId &&
    chunk.chainId === latest.chainId &&
    chunk.poolAddress.toLowerCase() === latest.poolAddress.toLowerCase() &&
    chunk.observedThroughBlock === latest.observedThroughBlock &&
    chunk.blockHash === latest.blockHash &&
    chunk.parentHash === latest.parentHash &&
    chunk.candidateId === latest.candidateId &&
    chunk.stateHash === latest.stateHash &&
    chunk.source === latest.source &&
    chunk.sourceRegistryId === latest.sourceRegistryId
  );
}

function replayCandidateCapsuleMatchesPointer(
  latest: FameClReplayCandidateLatestState,
  bitmapWords: readonly FameClReplayBitmapWord[],
  initializedTicks: readonly FameClReplayInitializedTick[],
): boolean {
  const wordPositions = bitmapWords.map((word) => word.wordPosition);
  const tickIndexes = initializedTicks.map((tick) => tick.tick);
  return (
    bitmapWords.length === latest.bitmapWordCount &&
    initializedTicks.length === latest.initializedTickCount &&
    minOrNull(wordPositions) === latest.minWordPosition &&
    maxOrNull(wordPositions) === latest.maxWordPosition &&
    minOrNull(tickIndexes) === latest.minTick &&
    maxOrNull(tickIndexes) === latest.maxTick &&
    strictlyIncreasingNumbers(wordPositions) &&
    strictlyIncreasingNumbers(tickIndexes)
  );
}

function v4ReplayChunkMatchesLatest(
  latest: FameV4ClReplayLatestState,
  chunk: FameV4ClReplayBitmapChunkState | FameV4ClReplayTickChunkState,
): boolean {
  return (
    chunk.pk === latest.pk &&
    chunk.poolId === latest.poolId &&
    chunk.chainId === latest.chainId &&
    chunk.poolKey.toLowerCase() === latest.poolKey.toLowerCase() &&
    chunk.stateViewAddress.toLowerCase() ===
      latest.stateViewAddress.toLowerCase() &&
    chunk.observedThroughBlock === latest.observedThroughBlock &&
    chunk.blockHash === latest.blockHash &&
    chunk.parentHash === latest.parentHash &&
    chunk.snapshotId === latest.snapshotId &&
    chunk.stateHash === latest.stateHash &&
    chunk.source === latest.source &&
    chunk.sourceRegistryId === latest.sourceRegistryId
  );
}

function v4ReplayCapsuleMatchesPointer(
  latest: FameV4ClReplayLatestState,
  bitmapWords: readonly FameClReplayBitmapWord[],
  initializedTicks: readonly FameClReplayInitializedTick[],
): boolean {
  const wordPositions = bitmapWords.map((word) => word.wordPosition);
  const tickIndexes = initializedTicks.map((tick) => tick.tick);
  return (
    bitmapWords.length === latest.bitmapWordCount &&
    initializedTicks.length === latest.initializedTickCount &&
    minOrNull(wordPositions) === latest.minWordPosition &&
    maxOrNull(wordPositions) === latest.maxWordPosition &&
    minOrNull(tickIndexes) === latest.minTick &&
    maxOrNull(tickIndexes) === latest.maxTick &&
    strictlyIncreasingNumbers(wordPositions) &&
    strictlyIncreasingNumbers(tickIndexes)
  );
}

function completeReplayCapsuleFromItems({
  latest,
  itemsByKey,
}: {
  latest: FameClReplayLatestState;
  itemsByKey: ReadonlyMap<string, Record<string, unknown>>;
}): FameClReplayStateCapsule | null {
  const bitmapChunks: FameClReplayBitmapChunkState[] = [];
  for (
    let chunkIndex = 0;
    chunkIndex < latest.bitmapChunkCount;
    chunkIndex += 1
  ) {
    const key = clReplayBitmapChunkKey(latest, latest.snapshotId, chunkIndex);
    const item = itemsByKey.get(dynamoKeyString(key));
    if (!item) return null;
    const chunk = parseClReplayBitmapChunkItem(item);
    if (
      chunk.chunkIndex !== chunkIndex ||
      chunk.sk !== key.sk ||
      !replayChunkMatchesLatest(latest, chunk)
    ) {
      return null;
    }
    bitmapChunks.push(chunk);
  }

  const tickChunks: FameClReplayTickChunkState[] = [];
  for (
    let chunkIndex = 0;
    chunkIndex < latest.tickChunkCount;
    chunkIndex += 1
  ) {
    const key = clReplayTickChunkKey(latest, latest.snapshotId, chunkIndex);
    const item = itemsByKey.get(dynamoKeyString(key));
    if (!item) return null;
    const chunk = parseClReplayTickChunkItem(item);
    if (
      chunk.chunkIndex !== chunkIndex ||
      chunk.sk !== key.sk ||
      !replayChunkMatchesLatest(latest, chunk)
    ) {
      return null;
    }
    tickChunks.push(chunk);
  }

  const bitmapWords = bitmapChunks.flatMap((chunk) => chunk.bitmapWords);
  const initializedTicks = tickChunks.flatMap(
    (chunk) => chunk.initializedTicks,
  );
  if (!replayCapsuleMatchesPointer(latest, bitmapWords, initializedTicks)) {
    return null;
  }

  return {
    latest,
    bitmapWords,
    initializedTicks,
  };
}

function completeReplayCandidateCapsuleFromItems({
  latest,
  itemsByKey,
}: {
  latest: FameClReplayCandidateLatestState;
  itemsByKey: ReadonlyMap<string, Record<string, unknown>>;
}): FameClReplayCandidateStateCapsule | null {
  const bitmapChunks: FameClReplayCandidateBitmapChunkState[] = [];
  for (
    let chunkIndex = 0;
    chunkIndex < latest.bitmapChunkCount;
    chunkIndex += 1
  ) {
    const key = clReplayCandidateBitmapChunkKey(
      latest,
      latest.candidateId,
      chunkIndex,
    );
    const item = itemsByKey.get(dynamoKeyString(key));
    if (!item) return null;
    const chunk = parseClReplayCandidateBitmapChunkItem(item);
    if (
      chunk.chunkIndex !== chunkIndex ||
      chunk.sk !== key.sk ||
      !replayCandidateChunkMatchesLatest(latest, chunk)
    ) {
      return null;
    }
    bitmapChunks.push(chunk);
  }

  const tickChunks: FameClReplayCandidateTickChunkState[] = [];
  for (
    let chunkIndex = 0;
    chunkIndex < latest.tickChunkCount;
    chunkIndex += 1
  ) {
    const key = clReplayCandidateTickChunkKey(
      latest,
      latest.candidateId,
      chunkIndex,
    );
    const item = itemsByKey.get(dynamoKeyString(key));
    if (!item) return null;
    const chunk = parseClReplayCandidateTickChunkItem(item);
    if (
      chunk.chunkIndex !== chunkIndex ||
      chunk.sk !== key.sk ||
      !replayCandidateChunkMatchesLatest(latest, chunk)
    ) {
      return null;
    }
    tickChunks.push(chunk);
  }

  const bitmapWords = bitmapChunks.flatMap((chunk) => chunk.bitmapWords);
  const initializedTicks = tickChunks.flatMap(
    (chunk) => chunk.initializedTicks,
  );
  if (
    !replayCandidateCapsuleMatchesPointer(latest, bitmapWords, initializedTicks)
  ) {
    return null;
  }

  return {
    latest,
    bitmapWords,
    initializedTicks,
  };
}

function completeV4ReplayCapsuleFromItems({
  latest,
  itemsByKey,
}: {
  latest: FameV4ClReplayLatestState;
  itemsByKey: ReadonlyMap<string, Record<string, unknown>>;
}): FameV4ClReplayStateCapsule | null {
  const bitmapChunks: FameV4ClReplayBitmapChunkState[] = [];
  for (
    let chunkIndex = 0;
    chunkIndex < latest.bitmapChunkCount;
    chunkIndex += 1
  ) {
    const key = v4ClReplayBitmapChunkKey(latest, latest.snapshotId, chunkIndex);
    const item = itemsByKey.get(dynamoKeyString(key));
    if (!item) return null;
    const chunk = parseV4ClReplayBitmapChunkItem(item);
    if (
      chunk.chunkIndex !== chunkIndex ||
      chunk.sk !== key.sk ||
      !v4ReplayChunkMatchesLatest(latest, chunk)
    ) {
      return null;
    }
    bitmapChunks.push(chunk);
  }

  const tickChunks: FameV4ClReplayTickChunkState[] = [];
  for (
    let chunkIndex = 0;
    chunkIndex < latest.tickChunkCount;
    chunkIndex += 1
  ) {
    const key = v4ClReplayTickChunkKey(latest, latest.snapshotId, chunkIndex);
    const item = itemsByKey.get(dynamoKeyString(key));
    if (!item) return null;
    const chunk = parseV4ClReplayTickChunkItem(item);
    if (
      chunk.chunkIndex !== chunkIndex ||
      chunk.sk !== key.sk ||
      !v4ReplayChunkMatchesLatest(latest, chunk)
    ) {
      return null;
    }
    tickChunks.push(chunk);
  }

  const bitmapWords = bitmapChunks.flatMap((chunk) => chunk.bitmapWords);
  const initializedTicks = tickChunks.flatMap(
    (chunk) => chunk.initializedTicks,
  );
  if (!v4ReplayCapsuleMatchesPointer(latest, bitmapWords, initializedTicks)) {
    return null;
  }

  return {
    latest,
    bitmapWords,
    initializedTicks,
  };
}

export function latestStateFromReserves(options: {
  pool: FamePoolStateRegistryEntry & { poolAddress: Address };
  reserve0: bigint;
  reserve1: bigint;
  observedThroughBlock: number;
  version: FamePoolStateEventVersion;
  transactionHash: Hex | null;
  source: FamePoolLatestState["source"];
  sourceRegistryId: string;
  updatedAt: string;
}): FamePoolLatestState {
  const key = latestPoolStateKey(
    options.pool.chainId,
    options.pool.poolAddress,
  );
  return {
    ...key,
    poolId: options.pool.id,
    chainId: options.pool.chainId,
    poolAddress: options.pool.poolAddress,
    token0: options.pool.token0,
    token1: options.pool.token1,
    reserve0: options.reserve0.toString(),
    reserve1: options.reserve1.toString(),
    k: (options.reserve0 * options.reserve1).toString(),
    lastReserveChangeBlock: options.version.blockNumber,
    lastEventTransactionIndex: options.version.transactionIndex,
    lastEventLogIndex: options.version.logIndex,
    lastEventTransactionHash: options.transactionHash,
    observedThroughBlock: options.observedThroughBlock,
    source: options.source,
    sourceRegistryId: options.sourceRegistryId,
    updatedAt: options.updatedAt,
  };
}

export function latestClHeadStateFromSnapshot(options: {
  pool: FameClHeadSnapshotRegistryEntry;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  observedThroughBlock: number;
  source: FameClHeadSource;
  sourceRegistryId: string;
  updatedAt: string;
}): FameClHeadLatestState {
  if (options.pool.fee.status !== "available") {
    throw new Error(`CL head pool ${options.pool.id} must have fee metadata.`);
  }
  const key = latestClHeadStateKey(options.pool);
  return {
    ...key,
    stateKind: "cl-head-snapshot",
    poolId: options.pool.id,
    chainId: options.pool.chainId,
    poolAddress: options.pool.poolAddress,
    poolKey: options.pool.poolKey,
    token0: options.pool.token0,
    token1: options.pool.token1,
    venueFamily: options.pool.venueFamily,
    feeBps: options.pool.fee.feeBps,
    feeLabel: options.pool.fee.label,
    tickSpacing: options.pool.tickSpacing,
    stateViewAddress: options.pool.stateViewAddress,
    sqrtPriceX96: options.sqrtPriceX96.toString(),
    tick: options.tick,
    liquidity: options.liquidity.toString(),
    observedThroughBlock: options.observedThroughBlock,
    source: options.source,
    sourceRegistryId: options.sourceRegistryId,
    updatedAt: options.updatedAt,
  };
}

export const CL_REPLAY_DEFAULT_BITMAP_WORDS_PER_CHUNK = 128;
export const CL_REPLAY_DEFAULT_TICKS_PER_CHUNK = 128;
export const CL_REPLAY_CHUNK_TTL_SECONDS = 2 * 60 * 60;

function assertNonNegativeBigInt(value: bigint, field: string): void {
  if (value < 0n) {
    throw new Error(`CL replay snapshot ${field} must be non-negative.`);
  }
}

function assertPositiveChunkSize(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `CL replay snapshot ${field} must be a positive safe integer.`,
    );
  }
}

function epochSecondsFromIsoTimestamp(value: string, field: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`CL replay snapshot ${field} must be an ISO timestamp.`);
  }
  return Math.floor(milliseconds / 1_000);
}

function expiresAtFromIsoTimestamp(value: string, field: string): number {
  const expiresAt =
    epochSecondsFromIsoTimestamp(value, field) + CL_REPLAY_CHUNK_TTL_SECONDS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error(
      `CL replay snapshot ${field} must produce a valid DynamoDB TTL timestamp.`,
    );
  }
  return expiresAt;
}

function canonicalUint256Hex(value: bigint): Hex {
  if (value < 0n || value >= 2n ** 256n) {
    throw new Error("CL replay bitmap word must fit uint256.");
  }
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

function chunkArray<T>(values: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function assertStrictlyIncreasing(
  values: readonly number[],
  field: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      throw new Error(
        `CL replay snapshot ${field} values must be unique and sorted.`,
      );
    }
  }
}

function minOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : values[0];
}

function maxOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : values[values.length - 1];
}

export function clReplayStateRowsFromSnapshot(options: {
  pool: FameClReplayRegistryEntry;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  fee: bigint;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  sourceRegistryId: string;
  updatedAt: string;
  bitmapWords: readonly { wordPosition: number; bitmap: bigint }[];
  initializedTicks: readonly {
    tick: number;
    liquidityGross: bigint;
    liquidityNet: bigint;
  }[];
  bitmapChunkSize?: number;
  tickChunkSize?: number;
}): FameClReplayStateRows {
  assertNonNegativeBigInt(options.sqrtPriceX96, "sqrtPriceX96");
  assertNonNegativeBigInt(options.liquidity, "liquidity");
  assertNonNegativeBigInt(options.fee, "fee");

  const bitmapChunkSize =
    options.bitmapChunkSize ?? CL_REPLAY_DEFAULT_BITMAP_WORDS_PER_CHUNK;
  const tickChunkSize =
    options.tickChunkSize ?? CL_REPLAY_DEFAULT_TICKS_PER_CHUNK;
  assertPositiveChunkSize(bitmapChunkSize, "bitmapChunkSize");
  assertPositiveChunkSize(tickChunkSize, "tickChunkSize");

  const bitmapWords = [...options.bitmapWords]
    .sort((left, right) => left.wordPosition - right.wordPosition)
    .map((word) => ({
      wordPosition: word.wordPosition,
      bitmap: canonicalUint256Hex(word.bitmap),
    }));
  const initializedTicks = [...options.initializedTicks]
    .sort((left, right) => left.tick - right.tick)
    .map((tick) => {
      assertNonNegativeBigInt(tick.liquidityGross, "liquidityGross");
      return {
        tick: tick.tick,
        liquidityGross: tick.liquidityGross.toString(),
        liquidityNet: tick.liquidityNet.toString(),
      };
    });

  const chunkExpiresAt = expiresAtFromIsoTimestamp(
    options.updatedAt,
    "updatedAt",
  );

  assertStrictlyIncreasing(
    bitmapWords.map((word) => word.wordPosition),
    "bitmap word",
  );
  assertStrictlyIncreasing(
    initializedTicks.map((tick) => tick.tick),
    "initialized tick",
  );

  const latest = {
    ...latestClReplayStateKey(options.pool),
    stateKind: "cl-replay-v1",
    poolId: options.pool.id,
    chainId: options.pool.chainId,
    poolAddress: options.pool.poolAddress,
    token0: options.pool.token0,
    token1: options.pool.token1,
    venueFamily: options.pool.venueFamily,
    tickSpacing: options.pool.tickSpacing,
    sqrtPriceX96: options.sqrtPriceX96.toString(),
    tick: options.tick,
    liquidity: options.liquidity.toString(),
    fee: options.fee.toString(),
    feeSource: "pool-fee",
    observedThroughBlock: options.observedThroughBlock,
    blockHash: options.blockHash,
    parentHash: options.parentHash,
    snapshotId: options.snapshotId,
    stateHash: options.stateHash,
    source: "slipstream-pool-state",
    sourceRegistryId: options.sourceRegistryId,
    updatedAt: options.updatedAt,
    bitmapWordCount: bitmapWords.length,
    initializedTickCount: initializedTicks.length,
    bitmapChunkCount: Math.ceil(bitmapWords.length / bitmapChunkSize),
    tickChunkCount: Math.ceil(initializedTicks.length / tickChunkSize),
    minWordPosition: minOrNull(bitmapWords.map((word) => word.wordPosition)),
    maxWordPosition: maxOrNull(bitmapWords.map((word) => word.wordPosition)),
    minTick: minOrNull(initializedTicks.map((tick) => tick.tick)),
    maxTick: maxOrNull(initializedTicks.map((tick) => tick.tick)),
  } satisfies FameClReplayLatestState;

  const bitmapChunks = chunkArray(bitmapWords, bitmapChunkSize).map(
    (chunk, chunkIndex) =>
      ({
        ...clReplayBitmapChunkKey(options.pool, options.snapshotId, chunkIndex),
        stateKind: "cl-replay-bitmap-chunk-v1",
        poolId: options.pool.id,
        chainId: options.pool.chainId,
        poolAddress: options.pool.poolAddress,
        observedThroughBlock: options.observedThroughBlock,
        blockHash: options.blockHash,
        parentHash: options.parentHash,
        snapshotId: options.snapshotId,
        stateHash: options.stateHash,
        source: "slipstream-pool-state",
        sourceRegistryId: options.sourceRegistryId,
        updatedAt: options.updatedAt,
        expiresAt: chunkExpiresAt,
        chunkIndex,
        bitmapWords: chunk,
      }) satisfies FameClReplayBitmapChunkState,
  );

  const tickChunks = chunkArray(initializedTicks, tickChunkSize).map(
    (chunk, chunkIndex) =>
      ({
        ...clReplayTickChunkKey(options.pool, options.snapshotId, chunkIndex),
        stateKind: "cl-replay-tick-chunk-v1",
        poolId: options.pool.id,
        chainId: options.pool.chainId,
        poolAddress: options.pool.poolAddress,
        observedThroughBlock: options.observedThroughBlock,
        blockHash: options.blockHash,
        parentHash: options.parentHash,
        snapshotId: options.snapshotId,
        stateHash: options.stateHash,
        source: "slipstream-pool-state",
        sourceRegistryId: options.sourceRegistryId,
        updatedAt: options.updatedAt,
        expiresAt: chunkExpiresAt,
        chunkIndex,
        initializedTicks: chunk,
      }) satisfies FameClReplayTickChunkState,
  );

  return {
    latest,
    bitmapChunks,
    tickChunks,
  };
}

export function v4ClReplayStateRowsFromSnapshot(options: {
  pool: FameV4ClReplayRegistryEntry;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  zoraProvenance: FameV4ZoraVerifiedProvenance;
  sourceRegistryId: string;
  updatedAt: string;
  bitmapWords: readonly { wordPosition: number; bitmap: bigint }[];
  initializedTicks: readonly {
    tick: number;
    liquidityGross: bigint;
    liquidityNet: bigint;
  }[];
  bitmapChunkSize?: number;
  tickChunkSize?: number;
}): FameV4ClReplayStateRows {
  assertNonNegativeBigInt(options.sqrtPriceX96, "sqrtPriceX96");
  assertNonNegativeBigInt(options.liquidity, "liquidity");
  assertNonNegativeBigInt(options.lpFee, "lpFee");
  assertNonNegativeBigInt(options.protocolFee, "protocolFee");

  const bitmapChunkSize =
    options.bitmapChunkSize ?? CL_REPLAY_DEFAULT_BITMAP_WORDS_PER_CHUNK;
  const tickChunkSize =
    options.tickChunkSize ?? CL_REPLAY_DEFAULT_TICKS_PER_CHUNK;
  assertPositiveChunkSize(bitmapChunkSize, "bitmapChunkSize");
  assertPositiveChunkSize(tickChunkSize, "tickChunkSize");

  const bitmapWords = [...options.bitmapWords]
    .sort((left, right) => left.wordPosition - right.wordPosition)
    .map((word) => ({
      wordPosition: word.wordPosition,
      bitmap: canonicalUint256Hex(word.bitmap),
    }));
  const initializedTicks = [...options.initializedTicks]
    .sort((left, right) => left.tick - right.tick)
    .map((tick) => {
      assertNonNegativeBigInt(tick.liquidityGross, "liquidityGross");
      return {
        tick: tick.tick,
        liquidityGross: tick.liquidityGross.toString(),
        liquidityNet: tick.liquidityNet.toString(),
      };
    });

  const chunkExpiresAt = expiresAtFromIsoTimestamp(
    options.updatedAt,
    "updatedAt",
  );

  assertStrictlyIncreasing(
    bitmapWords.map((word) => word.wordPosition),
    "bitmap word",
  );
  assertStrictlyIncreasing(
    initializedTicks.map((tick) => tick.tick),
    "initialized tick",
  );

  const latest = {
    ...latestV4ClReplayStateKey(options.pool),
    stateKind: "v4-cl-replay-v1",
    poolId: options.pool.id,
    chainId: options.pool.chainId,
    poolKey: options.pool.poolKey,
    stateViewAddress: options.pool.stateViewAddress,
    token0: options.pool.token0,
    token1: options.pool.token1,
    venueFamily: options.pool.venueFamily,
    tickSpacing: options.pool.tickSpacing,
    sqrtPriceX96: options.sqrtPriceX96.toString(),
    tick: options.tick,
    liquidity: options.liquidity.toString(),
    lpFee: options.lpFee.toString(),
    protocolFee: options.protocolFee.toString(),
    feeSource: "v4-slot0",
    observedThroughBlock: options.observedThroughBlock,
    blockHash: options.blockHash,
    parentHash: options.parentHash,
    snapshotId: options.snapshotId,
    stateHash: options.stateHash,
    source: "uniswap-v4-state-view",
    zoraProvenance: options.zoraProvenance,
    sourceRegistryId: options.sourceRegistryId,
    updatedAt: options.updatedAt,
    bitmapWordCount: bitmapWords.length,
    initializedTickCount: initializedTicks.length,
    bitmapChunkCount: Math.ceil(bitmapWords.length / bitmapChunkSize),
    tickChunkCount: Math.ceil(initializedTicks.length / tickChunkSize),
    minWordPosition: minOrNull(bitmapWords.map((word) => word.wordPosition)),
    maxWordPosition: maxOrNull(bitmapWords.map((word) => word.wordPosition)),
    minTick: minOrNull(initializedTicks.map((tick) => tick.tick)),
    maxTick: maxOrNull(initializedTicks.map((tick) => tick.tick)),
  } satisfies FameV4ClReplayLatestState;

  const bitmapChunks = chunkArray(bitmapWords, bitmapChunkSize).map(
    (chunk, chunkIndex) =>
      ({
        ...v4ClReplayBitmapChunkKey(
          options.pool,
          options.snapshotId,
          chunkIndex,
        ),
        stateKind: "v4-cl-replay-bitmap-chunk-v1",
        poolId: options.pool.id,
        chainId: options.pool.chainId,
        poolKey: options.pool.poolKey,
        stateViewAddress: options.pool.stateViewAddress,
        observedThroughBlock: options.observedThroughBlock,
        blockHash: options.blockHash,
        parentHash: options.parentHash,
        snapshotId: options.snapshotId,
        stateHash: options.stateHash,
        source: "uniswap-v4-state-view",
        sourceRegistryId: options.sourceRegistryId,
        updatedAt: options.updatedAt,
        expiresAt: chunkExpiresAt,
        chunkIndex,
        bitmapWords: chunk,
      }) satisfies FameV4ClReplayBitmapChunkState,
  );

  const tickChunks = chunkArray(initializedTicks, tickChunkSize).map(
    (chunk, chunkIndex) =>
      ({
        ...v4ClReplayTickChunkKey(
          options.pool,
          options.snapshotId,
          chunkIndex,
        ),
        stateKind: "v4-cl-replay-tick-chunk-v1",
        poolId: options.pool.id,
        chainId: options.pool.chainId,
        poolKey: options.pool.poolKey,
        stateViewAddress: options.pool.stateViewAddress,
        observedThroughBlock: options.observedThroughBlock,
        blockHash: options.blockHash,
        parentHash: options.parentHash,
        snapshotId: options.snapshotId,
        stateHash: options.stateHash,
        source: "uniswap-v4-state-view",
        sourceRegistryId: options.sourceRegistryId,
        updatedAt: options.updatedAt,
        expiresAt: chunkExpiresAt,
        chunkIndex,
        initializedTicks: chunk,
      }) satisfies FameV4ClReplayTickChunkState,
  );

  return {
    latest,
    bitmapChunks,
    tickChunks,
  };
}

export function clReplayCandidateStateRowsFromSnapshot(options: {
  pool: FameClReplayRegistryEntry;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  fee: bigint;
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  candidateId: string;
  stateHash: Hex;
  sourceRegistryId: string;
  updatedAt: string;
  bitmapWords: readonly { wordPosition: number; bitmap: bigint }[];
  initializedTicks: readonly {
    tick: number;
    liquidityGross: bigint;
    liquidityNet: bigint;
  }[];
  bitmapChunkSize?: number;
  tickChunkSize?: number;
}): FameClReplayCandidateStateRows {
  if (options.candidateId.length === 0) {
    throw new Error("CL replay candidateId must be non-empty.");
  }
  assertNonNegativeBigInt(options.sqrtPriceX96, "sqrtPriceX96");
  assertNonNegativeBigInt(options.liquidity, "liquidity");
  assertNonNegativeBigInt(options.fee, "fee");

  const bitmapChunkSize =
    options.bitmapChunkSize ?? CL_REPLAY_DEFAULT_BITMAP_WORDS_PER_CHUNK;
  const tickChunkSize =
    options.tickChunkSize ?? CL_REPLAY_DEFAULT_TICKS_PER_CHUNK;
  assertPositiveChunkSize(bitmapChunkSize, "bitmapChunkSize");
  assertPositiveChunkSize(tickChunkSize, "tickChunkSize");

  const bitmapWords = [...options.bitmapWords]
    .sort((left, right) => left.wordPosition - right.wordPosition)
    .map((word) => ({
      wordPosition: word.wordPosition,
      bitmap: canonicalUint256Hex(word.bitmap),
    }));
  const initializedTicks = [...options.initializedTicks]
    .sort((left, right) => left.tick - right.tick)
    .map((tick) => {
      assertNonNegativeBigInt(tick.liquidityGross, "liquidityGross");
      return {
        tick: tick.tick,
        liquidityGross: tick.liquidityGross.toString(),
        liquidityNet: tick.liquidityNet.toString(),
      };
    });

  const chunkExpiresAt = expiresAtFromIsoTimestamp(
    options.updatedAt,
    "updatedAt",
  );

  assertStrictlyIncreasing(
    bitmapWords.map((word) => word.wordPosition),
    "bitmap word",
  );
  assertStrictlyIncreasing(
    initializedTicks.map((tick) => tick.tick),
    "initialized tick",
  );

  const latest = {
    ...latestClReplayCandidateStateKey(options.pool),
    stateKind: "cl-replay-candidate-v1",
    poolId: options.pool.id,
    chainId: options.pool.chainId,
    poolAddress: options.pool.poolAddress,
    token0: options.pool.token0,
    token1: options.pool.token1,
    venueFamily: options.pool.venueFamily,
    tickSpacing: options.pool.tickSpacing,
    sqrtPriceX96: options.sqrtPriceX96.toString(),
    tick: options.tick,
    liquidity: options.liquidity.toString(),
    fee: options.fee.toString(),
    feeSource: "pool-fee",
    observedThroughBlock: options.observedThroughBlock,
    blockHash: options.blockHash,
    parentHash: options.parentHash,
    candidateId: options.candidateId,
    stateHash: options.stateHash,
    source: "slipstream-pool-state",
    sourceRegistryId: options.sourceRegistryId,
    updatedAt: options.updatedAt,
    bitmapWordCount: bitmapWords.length,
    initializedTickCount: initializedTicks.length,
    bitmapChunkCount: Math.ceil(bitmapWords.length / bitmapChunkSize),
    tickChunkCount: Math.ceil(initializedTicks.length / tickChunkSize),
    minWordPosition: minOrNull(bitmapWords.map((word) => word.wordPosition)),
    maxWordPosition: maxOrNull(bitmapWords.map((word) => word.wordPosition)),
    minTick: minOrNull(initializedTicks.map((tick) => tick.tick)),
    maxTick: maxOrNull(initializedTicks.map((tick) => tick.tick)),
  } satisfies FameClReplayCandidateLatestState;

  const bitmapChunks = chunkArray(bitmapWords, bitmapChunkSize).map(
    (chunk, chunkIndex) =>
      ({
        ...clReplayCandidateBitmapChunkKey(
          options.pool,
          options.candidateId,
          chunkIndex,
        ),
        stateKind: "cl-replay-candidate-bitmap-chunk-v1",
        poolId: options.pool.id,
        chainId: options.pool.chainId,
        poolAddress: options.pool.poolAddress,
        observedThroughBlock: options.observedThroughBlock,
        blockHash: options.blockHash,
        parentHash: options.parentHash,
        candidateId: options.candidateId,
        stateHash: options.stateHash,
        source: "slipstream-pool-state",
        sourceRegistryId: options.sourceRegistryId,
        updatedAt: options.updatedAt,
        expiresAt: chunkExpiresAt,
        chunkIndex,
        bitmapWords: chunk,
      }) satisfies FameClReplayCandidateBitmapChunkState,
  );

  const tickChunks = chunkArray(initializedTicks, tickChunkSize).map(
    (chunk, chunkIndex) =>
      ({
        ...clReplayCandidateTickChunkKey(
          options.pool,
          options.candidateId,
          chunkIndex,
        ),
        stateKind: "cl-replay-candidate-tick-chunk-v1",
        poolId: options.pool.id,
        chainId: options.pool.chainId,
        poolAddress: options.pool.poolAddress,
        observedThroughBlock: options.observedThroughBlock,
        blockHash: options.blockHash,
        parentHash: options.parentHash,
        candidateId: options.candidateId,
        stateHash: options.stateHash,
        source: "slipstream-pool-state",
        sourceRegistryId: options.sourceRegistryId,
        updatedAt: options.updatedAt,
        expiresAt: chunkExpiresAt,
        chunkIndex,
        initializedTicks: chunk,
      }) satisfies FameClReplayCandidateTickChunkState,
  );

  return {
    latest,
    bitmapChunks,
    tickChunks,
  };
}

export async function getLatestPoolState({
  db = defaultDb,
  tableName,
  chainId,
  poolAddress,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  chainId: number;
  poolAddress: Address;
}): Promise<FamePoolLatestState | null> {
  const response = await db.send(
    new GetCommand({
      TableName: tableName,
      Key: latestPoolStateKey(chainId, poolAddress),
    }),
  );
  return itemToLatestPoolState(response.Item);
}

export async function batchGetLatestPoolStates({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly (FamePoolStateRegistryEntry & { poolAddress: Address })[];
}): Promise<FamePoolLatestState[]> {
  if (pools.length === 0) return [];
  const response = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [tableName]: {
          Keys: pools.map((pool) =>
            latestPoolStateKey(pool.chainId, pool.poolAddress),
          ),
        },
      },
    }),
  );
  const incompleteKeyCount = unprocessedKeyCount(response, tableName);
  if (incompleteKeyCount > 0) {
    throw new PoolStateIncompleteBatchReadError(tableName, incompleteKeyCount);
  }
  return (response.Responses?.[tableName] ?? [])
    .map(itemToLatestPoolState)
    .filter((item): item is FamePoolLatestState => item !== null);
}

export async function getLatestClHeadState({
  db = defaultDb,
  tableName,
  pool,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pool: FameClHeadSnapshotRegistryEntry;
}): Promise<FameClHeadLatestState | null> {
  const response = await db.send(
    new GetCommand({
      TableName: tableName,
      Key: latestClHeadStateKey(pool),
    }),
  );
  return itemToLatestClHeadState(response.Item);
}

export async function batchGetLatestClHeadStates({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly FameClHeadSnapshotRegistryEntry[];
}): Promise<FameClHeadLatestState[]> {
  if (pools.length === 0) return [];
  const response = await db.send(
    new BatchGetCommand({
      RequestItems: {
        [tableName]: {
          Keys: pools.map((pool) => latestClHeadStateKey(pool)),
        },
      },
    }),
  );
  const incompleteKeyCount = unprocessedKeyCount(response, tableName);
  if (incompleteKeyCount > 0) {
    throw new PoolStateIncompleteBatchReadError(tableName, incompleteKeyCount);
  }
  return (response.Responses?.[tableName] ?? [])
    .map(itemToLatestClHeadState)
    .filter((item): item is FameClHeadLatestState => item !== null);
}

function assertClReplayLatestChunkBounds(
  latest: FameClReplayLatestState,
): void {
  if (latest.bitmapWordCount === 0) {
    if (latest.bitmapChunkCount !== 0) {
      throw new PoolStateInvalidItemError(
        "latest CL replay-state",
        "bitmapChunkCount",
        "must be 0 when bitmapWordCount is 0",
      );
    }
  } else if (
    latest.bitmapChunkCount < 1 ||
    latest.bitmapChunkCount > latest.bitmapWordCount
  ) {
    throw new PoolStateInvalidItemError(
      "latest CL replay-state",
      "bitmapChunkCount",
      "must be between 1 and bitmapWordCount",
    );
  }

  if (latest.initializedTickCount === 0) {
    if (latest.tickChunkCount !== 0) {
      throw new PoolStateInvalidItemError(
        "latest CL replay-state",
        "tickChunkCount",
        "must be 0 when initializedTickCount is 0",
      );
    }
  } else if (
    latest.tickChunkCount < 1 ||
    latest.tickChunkCount > latest.initializedTickCount
  ) {
    throw new PoolStateInvalidItemError(
      "latest CL replay-state",
      "tickChunkCount",
      "must be between 1 and initializedTickCount",
    );
  }
}

function assertClReplayCandidateChunkBounds(
  latest: FameClReplayCandidateLatestState,
): void {
  if (latest.bitmapWordCount === 0) {
    if (latest.bitmapChunkCount !== 0) {
      throw new PoolStateInvalidItemError(
        "latest CL replay candidate",
        "bitmapChunkCount",
        "must be 0 when bitmapWordCount is 0",
      );
    }
  } else if (
    latest.bitmapChunkCount < 1 ||
    latest.bitmapChunkCount > latest.bitmapWordCount
  ) {
    throw new PoolStateInvalidItemError(
      "latest CL replay candidate",
      "bitmapChunkCount",
      "must be between 1 and bitmapWordCount",
    );
  }

  if (latest.initializedTickCount === 0) {
    if (latest.tickChunkCount !== 0) {
      throw new PoolStateInvalidItemError(
        "latest CL replay candidate",
        "tickChunkCount",
        "must be 0 when initializedTickCount is 0",
      );
    }
  } else if (
    latest.tickChunkCount < 1 ||
    latest.tickChunkCount > latest.initializedTickCount
  ) {
    throw new PoolStateInvalidItemError(
      "latest CL replay candidate",
      "tickChunkCount",
      "must be between 1 and initializedTickCount",
    );
  }
}

function assertV4ClReplayLatestChunkBounds(
  latest: FameV4ClReplayLatestState,
): void {
  if (latest.bitmapWordCount === 0) {
    if (latest.bitmapChunkCount !== 0) {
      throw new PoolStateInvalidItemError(
        "latest V4 CL replay-state",
        "bitmapChunkCount",
        "must be 0 when bitmapWordCount is 0",
      );
    }
  } else if (
    latest.bitmapChunkCount < 1 ||
    latest.bitmapChunkCount > latest.bitmapWordCount
  ) {
    throw new PoolStateInvalidItemError(
      "latest V4 CL replay-state",
      "bitmapChunkCount",
      "must be between 1 and bitmapWordCount",
    );
  }

  if (latest.initializedTickCount === 0) {
    if (latest.tickChunkCount !== 0) {
      throw new PoolStateInvalidItemError(
        "latest V4 CL replay-state",
        "tickChunkCount",
        "must be 0 when initializedTickCount is 0",
      );
    }
  } else if (
    latest.tickChunkCount < 1 ||
    latest.tickChunkCount > latest.initializedTickCount
  ) {
    throw new PoolStateInvalidItemError(
      "latest V4 CL replay-state",
      "tickChunkCount",
      "must be between 1 and initializedTickCount",
    );
  }
}

export async function batchGetLatestClReplayMaintenanceStates({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly FameClReplayRegistryEntry[];
}): Promise<FameClReplayMaintenanceState[]> {
  if (pools.length === 0) return [];

  const latestItems = await batchGetPoolStateItems({
    db,
    tableName,
    keys: pools.map((pool) => latestClReplayMaintenanceStateKey(pool)),
  });
  return latestItems
    .map(itemToLatestClReplayMaintenanceState)
    .filter((item): item is FameClReplayMaintenanceState => item !== null);
}

export async function batchGetLatestClReplayPointers({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly FameClReplayRegistryEntry[];
}): Promise<FameClReplayLatestState[]> {
  if (pools.length === 0) return [];

  const latestItems = await batchGetPoolStateItems({
    db,
    tableName,
    keys: pools.map((pool) => latestClReplayStateKey(pool)),
  });
  return latestItems
    .map(itemToLatestClReplayState)
    .filter((item): item is FameClReplayLatestState => item !== null)
    .map((latest) => {
      assertClReplayLatestChunkBounds(latest);
      return latest;
    });
}

export async function batchGetClReplayStateCapsules({
  db = defaultDb,
  tableName,
  latestStates,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  latestStates: readonly FameClReplayLatestState[];
}): Promise<FameClReplayStateCapsule[]> {
  if (latestStates.length === 0) return [];

  const chunkKeys = latestStates.flatMap((latest) => [
    ...Array.from({ length: latest.bitmapChunkCount }, (_, chunkIndex) =>
      clReplayBitmapChunkKey(latest, latest.snapshotId, chunkIndex),
    ),
    ...Array.from({ length: latest.tickChunkCount }, (_, chunkIndex) =>
      clReplayTickChunkKey(latest, latest.snapshotId, chunkIndex),
    ),
  ]);
  const chunkItems =
    chunkKeys.length === 0
      ? []
      : await batchGetPoolStateItems({
          db,
          tableName,
          keys: chunkKeys,
        });
  const itemsByKey = new Map(
    chunkItems.map((item) => [
      itemDynamoKeyString(item, "CL replay chunk"),
      item,
    ]),
  );

  return latestStates
    .map((latest) => completeReplayCapsuleFromItems({ latest, itemsByKey }))
    .filter((state): state is FameClReplayStateCapsule => state !== null);
}

export async function batchGetLatestClReplayStates({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly FameClReplayRegistryEntry[];
}): Promise<FameClReplayStateCapsule[]> {
  const latestStates = await batchGetLatestClReplayPointers({
    db,
    tableName,
    pools,
  });
  return batchGetClReplayStateCapsules({
    db,
    tableName,
    latestStates,
  });
}

export async function batchGetLatestV4ClReplayPointers({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly FameV4ClReplayRegistryEntry[];
}): Promise<FameV4ClReplayLatestState[]> {
  if (pools.length === 0) return [];

  const latestItems = await batchGetPoolStateItems({
    db,
    tableName,
    keys: pools.map((pool) => latestV4ClReplayStateKey(pool)),
  });
  return latestItems
    .map(itemToLatestV4ClReplayState)
    .filter((item): item is FameV4ClReplayLatestState => item !== null)
    .map((latest) => {
      assertV4ClReplayLatestChunkBounds(latest);
      return latest;
    });
}

export async function batchGetV4ClReplayStateCapsules({
  db = defaultDb,
  tableName,
  latestStates,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  latestStates: readonly FameV4ClReplayLatestState[];
}): Promise<FameV4ClReplayStateCapsule[]> {
  if (latestStates.length === 0) return [];

  const chunkKeys = latestStates.flatMap((latest) => [
    ...Array.from({ length: latest.bitmapChunkCount }, (_, chunkIndex) =>
      v4ClReplayBitmapChunkKey(latest, latest.snapshotId, chunkIndex),
    ),
    ...Array.from({ length: latest.tickChunkCount }, (_, chunkIndex) =>
      v4ClReplayTickChunkKey(latest, latest.snapshotId, chunkIndex),
    ),
  ]);
  const chunkItems =
    chunkKeys.length === 0
      ? []
      : await batchGetPoolStateItems({
          db,
          tableName,
          keys: chunkKeys,
        });
  const itemsByKey = new Map(
    chunkItems.map((item) => [
      itemDynamoKeyString(item, "V4 CL replay chunk"),
      item,
    ]),
  );

  return latestStates
    .map((latest) => completeV4ReplayCapsuleFromItems({ latest, itemsByKey }))
    .filter((state): state is FameV4ClReplayStateCapsule => state !== null);
}

export async function batchGetLatestV4ClReplayStates({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly FameV4ClReplayRegistryEntry[];
}): Promise<FameV4ClReplayStateCapsule[]> {
  const latestStates = await batchGetLatestV4ClReplayPointers({
    db,
    tableName,
    pools,
  });
  return batchGetV4ClReplayStateCapsules({
    db,
    tableName,
    latestStates,
  });
}

export async function batchGetLatestClReplayCandidatePointers({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly FameClReplayRegistryEntry[];
}): Promise<FameClReplayCandidateLatestState[]> {
  if (pools.length === 0) return [];

  const latestItems = await batchGetPoolStateItems({
    db,
    tableName,
    keys: pools.map((pool) => latestClReplayCandidateStateKey(pool)),
  });
  return latestItems
    .map(itemToLatestClReplayCandidateState)
    .filter((item): item is FameClReplayCandidateLatestState => item !== null)
    .map((latest) => {
      assertClReplayCandidateChunkBounds(latest);
      return latest;
    });
}

export async function batchGetClReplayCandidateStateCapsules({
  db = defaultDb,
  tableName,
  latestStates,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  latestStates: readonly FameClReplayCandidateLatestState[];
}): Promise<FameClReplayCandidateStateCapsule[]> {
  if (latestStates.length === 0) return [];

  const chunkKeys = latestStates.flatMap((latest) => [
    ...Array.from({ length: latest.bitmapChunkCount }, (_, chunkIndex) =>
      clReplayCandidateBitmapChunkKey(latest, latest.candidateId, chunkIndex),
    ),
    ...Array.from({ length: latest.tickChunkCount }, (_, chunkIndex) =>
      clReplayCandidateTickChunkKey(latest, latest.candidateId, chunkIndex),
    ),
  ]);
  const chunkItems =
    chunkKeys.length === 0
      ? []
      : await batchGetPoolStateItems({
          db,
          tableName,
          keys: chunkKeys,
        });
  const itemsByKey = new Map(
    chunkItems.map((item) => [
      itemDynamoKeyString(item, "CL replay candidate chunk"),
      item,
    ]),
  );

  return latestStates
    .map((latest) =>
      completeReplayCandidateCapsuleFromItems({ latest, itemsByKey }),
    )
    .filter(
      (state): state is FameClReplayCandidateStateCapsule => state !== null,
    );
}

export async function batchGetLatestClReplayCandidateStates({
  db = defaultDb,
  tableName,
  pools,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  pools: readonly FameClReplayRegistryEntry[];
}): Promise<FameClReplayCandidateStateCapsule[]> {
  const latestStates = await batchGetLatestClReplayCandidatePointers({
    db,
    tableName,
    pools,
  });
  return batchGetClReplayCandidateStateCapsules({
    db,
    tableName,
    latestStates,
  });
}

export async function putLatestPoolState({
  db = defaultDb,
  tableName,
  state,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  state: FamePoolLatestState;
}): Promise<PutLatestPoolStateResult> {
  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: state,
        ConditionExpression:
          "attribute_not_exists(pk) OR (observedThroughBlock <= :observedThroughBlock AND (lastReserveChangeBlock < :block OR (lastReserveChangeBlock = :block AND lastEventTransactionIndex < :transactionIndex) OR (lastReserveChangeBlock = :block AND lastEventTransactionIndex = :transactionIndex AND lastEventLogIndex < :logIndex)))",
        ExpressionAttributeValues: {
          ":observedThroughBlock": state.observedThroughBlock,
          ":block": state.lastReserveChangeBlock,
          ":transactionIndex": state.lastEventTransactionIndex,
          ":logIndex": state.lastEventLogIndex,
        },
      }),
    );
    return "written";
  } catch (error) {
    if (isConditionalCheckFailed(error)) return "ignored";
    throw error;
  }
}

export async function putLatestClHeadState({
  db = defaultDb,
  tableName,
  state,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  state: FameClHeadLatestState;
}): Promise<PutLatestPoolStateResult> {
  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: state,
        ConditionExpression:
          "attribute_not_exists(pk) OR observedThroughBlock < :observedThroughBlock OR (observedThroughBlock = :observedThroughBlock AND sourceRegistryId = :sourceRegistryId)",
        ExpressionAttributeValues: {
          ":observedThroughBlock": state.observedThroughBlock,
          ":sourceRegistryId": state.sourceRegistryId,
        },
      }),
    );
    return "written";
  } catch (error) {
    if (isConditionalCheckFailed(error)) return "ignored";
    throw error;
  }
}

export async function putLatestClReplayState({
  db = defaultDb,
  tableName,
  rows,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  rows: FameClReplayStateRows;
}): Promise<PutLatestPoolStateResult> {
  for (const chunk of [...rows.bitmapChunks, ...rows.tickChunks]) {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: chunk,
      }),
    );
  }

  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: rows.latest,
        ConditionExpression:
          "attribute_not_exists(pk) OR observedThroughBlock < :observedThroughBlock OR (observedThroughBlock = :observedThroughBlock AND sourceRegistryId = :sourceRegistryId)",
        ExpressionAttributeValues: {
          ":observedThroughBlock": rows.latest.observedThroughBlock,
          ":sourceRegistryId": rows.latest.sourceRegistryId,
        },
      }),
    );
    return "written";
  } catch (error) {
    if (isConditionalCheckFailed(error)) return "ignored";
    throw error;
  }
}

export async function putLatestV4ClReplayState({
  db = defaultDb,
  tableName,
  rows,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  rows: FameV4ClReplayStateRows;
}): Promise<PutLatestPoolStateResult> {
  for (const chunk of [...rows.bitmapChunks, ...rows.tickChunks]) {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: chunk,
      }),
    );
  }

  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: rows.latest,
        ConditionExpression:
          "attribute_not_exists(pk) OR observedThroughBlock < :observedThroughBlock OR (observedThroughBlock = :observedThroughBlock AND sourceRegistryId = :sourceRegistryId)",
        ExpressionAttributeValues: {
          ":observedThroughBlock": rows.latest.observedThroughBlock,
          ":sourceRegistryId": rows.latest.sourceRegistryId,
        },
      }),
    );
    return "written";
  } catch (error) {
    if (isConditionalCheckFailed(error)) return "ignored";
    throw error;
  }
}

export async function putLatestClReplayMaintenanceState({
  db = defaultDb,
  tableName,
  state,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  state: FameClReplayMaintenanceState;
}): Promise<PutLatestPoolStateResult> {
  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: state,
        ConditionExpression:
          "attribute_not_exists(pk) OR cursorBlock < :cursorBlock OR (cursorBlock = :cursorBlock AND cursorTransactionIndex < :cursorTransactionIndex) OR (cursorBlock = :cursorBlock AND cursorTransactionIndex = :cursorTransactionIndex AND cursorLogIndex < :cursorLogIndex) OR (cursorBlock = :cursorBlock AND cursorTransactionIndex = :cursorTransactionIndex AND cursorLogIndex = :cursorLogIndex AND sourceRegistryId = :sourceRegistryId)",
        ExpressionAttributeValues: {
          ":cursorBlock": state.cursorBlock,
          ":cursorTransactionIndex": state.cursorTransactionIndex,
          ":cursorLogIndex": state.cursorLogIndex,
          ":sourceRegistryId": state.sourceRegistryId,
        },
      }),
    );
    return "written";
  } catch (error) {
    if (isConditionalCheckFailed(error)) return "ignored";
    throw error;
  }
}

export async function putLatestClReplayCandidateState({
  db = defaultDb,
  tableName,
  rows,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  rows: FameClReplayCandidateStateRows;
}): Promise<PutLatestPoolStateResult> {
  for (const chunk of [...rows.bitmapChunks, ...rows.tickChunks]) {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: chunk,
      }),
    );
  }

  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: rows.latest,
        ConditionExpression:
          "attribute_not_exists(pk) OR observedThroughBlock < :observedThroughBlock OR (observedThroughBlock = :observedThroughBlock AND sourceRegistryId = :sourceRegistryId)",
        ExpressionAttributeValues: {
          ":observedThroughBlock": rows.latest.observedThroughBlock,
          ":sourceRegistryId": rows.latest.sourceRegistryId,
        },
      }),
    );
    return "written";
  } catch (error) {
    if (isConditionalCheckFailed(error)) return "ignored";
    throw error;
  }
}

export async function putSeedPoolStateIfAbsent({
  db = defaultDb,
  tableName,
  state,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  state: FamePoolLatestState;
}): Promise<PutLatestPoolStateResult> {
  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: state,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return "written";
  } catch (error) {
    if (isConditionalCheckFailed(error)) return "ignored";
    throw error;
  }
}

export async function markPoolObservedThroughBlock({
  db = defaultDb,
  tableName,
  chainId,
  poolAddress,
  observedThroughBlock,
  sourceRegistryId,
  updatedAt,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  chainId: number;
  poolAddress: Address;
  observedThroughBlock: number;
  sourceRegistryId: string;
  updatedAt: string;
}): Promise<void> {
  try {
    await db.send(
      new UpdateCommand({
        TableName: tableName,
        Key: latestPoolStateKey(chainId, poolAddress),
        UpdateExpression:
          "SET observedThroughBlock = :observedThroughBlock, sourceRegistryId = :sourceRegistryId, updatedAt = :updatedAt",
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(observedThroughBlock) OR observedThroughBlock < :observedThroughBlock)",
        ExpressionAttributeValues: {
          ":observedThroughBlock": observedThroughBlock,
          ":sourceRegistryId": sourceRegistryId,
          ":updatedAt": updatedAt,
        },
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) return;
    throw error;
  }
}

export async function getPoolStateCursor({
  db = defaultDb,
  tableName,
  chainId,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  chainId: number;
}): Promise<FamePoolStateCursor | null> {
  const response = await db.send(
    new GetCommand({
      TableName: tableName,
      Key: cursorKey(chainId),
    }),
  );
  return itemToCursor(response.Item);
}

export async function setPoolStateCursor({
  db = defaultDb,
  tableName,
  chainId,
  observedThroughBlock,
  sourceRegistryId,
  updatedAt,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  chainId: number;
  observedThroughBlock: number;
  sourceRegistryId: string;
  updatedAt: string;
}): Promise<void> {
  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...cursorKey(chainId),
          chainId,
          observedThroughBlock,
          sourceRegistryId,
          updatedAt,
        } satisfies FamePoolStateCursor,
        ConditionExpression:
          "attribute_not_exists(pk) OR observedThroughBlock < :observedThroughBlock",
        ExpressionAttributeValues: {
          ":observedThroughBlock": observedThroughBlock,
        },
      }),
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) return;
    throw error;
  }
}
