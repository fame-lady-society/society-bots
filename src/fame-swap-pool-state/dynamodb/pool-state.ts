import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { isAddress, isHex, type Address, type Hex } from "viem";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateVenueFamily,
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

export function latestClHeadStateKey(
  pool: FameClHeadSnapshotRegistryEntry,
): { pk: string; sk: "cl-head-snapshot-v1" } {
  return {
    pk: `pool:${pool.chainId.toString()}:${clHeadPoolIdentity(pool)}`,
    sk: "cl-head-snapshot-v1",
  };
}

export function cursorKey(chainId: number): { pk: string; sk: "cursor" } {
  return {
    pk: `cursor:${chainId.toString()}:quote-model-v1`,
    sk: "cursor",
  };
}

export function sourceRegistryIdFor(
  registrySource: { poolsJsonHash: Hex; solverRoutesJsonHash: Hex },
): string {
  return `${registrySource.poolsJsonHash}:${registrySource.solverRoutesJsonHash}`;
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

function invalidItem(recordType: string, field: string, message: string): never {
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
    stateViewAddress: nullableAddressField(item, recordType, "stateViewAddress"),
    sqrtPriceX96: stringField(item, recordType, "sqrtPriceX96"),
    tick: integerField(item, recordType, "tick"),
    liquidity: stringField(item, recordType, "liquidity"),
    observedThroughBlock: numberField(item, recordType, "observedThroughBlock"),
    source: clHeadSourceField(item, recordType, "source"),
    sourceRegistryId: stringField(item, recordType, "sourceRegistryId"),
    updatedAt: stringField(item, recordType, "updatedAt"),
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
  const key = latestPoolStateKey(options.pool.chainId, options.pool.poolAddress);
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
