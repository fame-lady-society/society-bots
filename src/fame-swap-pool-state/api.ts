import { isAddress, type Address, type Hex } from "viem";
import {
  batchGetClReplayStateCapsules,
  batchGetLatestV4ClReplayPointers,
  batchGetV4ClReplayStateCapsules,
  batchGetLatestClReplayPointers,
  batchGetLatestClHeadStates,
  batchGetLatestPoolStates,
  sourceRegistryIdFor,
  type FameClHeadLatestState,
  type FameClHeadSnapshotRegistryEntry,
  type FameClReplayRegistryEntry,
  type FameClReplayStateCapsule,
  type FameClReplayLatestState,
  type FameV4ClReplayLatestState,
  type FameV4ClReplayRegistryEntry,
  type FameV4ReviewedPoolEvidence,
  type FameV4ClReplayStateCapsule,
  type FameV4ZoraVerifiedProvenance,
  type FamePoolLatestState,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import { fameV4ZoraQuoteLaneManifestForPool } from "./v4-zora-manifests.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
  FamePoolStateUnsupportedReason,
  FamePoolStateVenueFamily,
} from "./types.ts";

export type FamePoolStateStatus = "fresh" | "stale" | "unknown" | "unsupported";
export type FamePoolStateRequestStateSurface =
  | "cl-head-snapshot"
  | "cl-replay-v1"
  | "v4-cl-replay-v1";

export type FamePoolStateRequestKey =
  | {
      poolId: string;
      chainId?: never;
      poolAddress?: never;
    }
  | {
      poolId?: never;
      chainId: number;
      poolAddress: Address;
    };

export interface FamePoolStateBatchRequest {
  currentBlock: number;
  maxFreshnessBlocks?: number;
  stateSurfaces?: FamePoolStateRequestStateSurface[];
  pools: FamePoolStateRequestKey[];
}

interface FameClReplayResponseBase {
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
  source: "slipstream-pool-state";
  sourceRegistryId: string;
  maxFreshnessBlocks: number;
  bitmapWordCount: number;
  initializedTickCount: number;
  bitmapChunkCount: number;
  tickChunkCount: number;
  minWordPosition: number | null;
  maxWordPosition: number | null;
  minTick: number | null;
  maxTick: number | null;
}

interface FameClReplayFreshResponseEntry extends FameClReplayResponseBase {
  status: "fresh";
  bitmapWords: {
    wordPosition: number;
    bitmap: Hex;
  }[];
  initializedTicks: {
    tick: number;
    liquidityGross: string;
    liquidityNet: string;
  }[];
}

interface FameClReplayStaleResponseEntry extends FameClReplayResponseBase {
  status: "stale";
}

interface FameV4ClReplayResponseBase {
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
  source: "uniswap-v4-state-view";
  reviewedPoolEvidence: FameV4ReviewedPoolEvidence;
  zoraProvenance?: FameV4ZoraVerifiedProvenance;
  sourceRegistryId: string;
  maxFreshnessBlocks: number;
  bitmapWordCount: number;
  initializedTickCount: number;
  bitmapChunkCount: number;
  tickChunkCount: number;
  minWordPosition: number | null;
  maxWordPosition: number | null;
  minTick: number | null;
  maxTick: number | null;
}

interface FameV4ClReplayFreshResponseEntry
  extends FameV4ClReplayResponseBase {
  status: "fresh";
  bitmapWords: {
    wordPosition: number;
    bitmap: Hex;
  }[];
  initializedTicks: {
    tick: number;
    liquidityGross: string;
    liquidityNet: string;
  }[];
}

interface FameV4ClReplayStaleResponseEntry
  extends FameV4ClReplayResponseBase {
  status: "stale";
}

export type FamePoolStateResponseEntry =
  | {
      status: Extract<FamePoolStateStatus, "fresh" | "stale">;
      poolId: string;
      chainId: number;
      poolAddress: Address;
      token0: Address;
      token1: Address;
      reserve0: string;
      reserve1: string;
      k: string;
      observedThroughBlock: number;
      lastReserveChangeBlock: number;
      source: FamePoolLatestState["source"];
      quoteModel: "constant-product-reserves";
      maxFreshnessBlocks: number;
    }
  | {
      status: Extract<FamePoolStateStatus, "fresh" | "stale">;
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
      source: FameClHeadLatestState["source"];
      sourceRegistryId: string;
      maxFreshnessBlocks: number;
    }
  | FameClReplayFreshResponseEntry
  | FameClReplayStaleResponseEntry
  | FameV4ClReplayFreshResponseEntry
  | FameV4ClReplayStaleResponseEntry
  | {
      status: Extract<FamePoolStateStatus, "unsupported">;
      poolId: string;
      chainId: number;
      poolAddress: Address | null;
      unsupportedReason: FamePoolStateUnsupportedReason;
    }
  | {
      status: Extract<FamePoolStateStatus, "unknown">;
      requested: FamePoolStateRequestKey;
      reason: "missing-indexed-state" | "missing-registry-entry";
    };

export interface FamePoolStateBatchResponse {
  sourceRegistryId: string;
  currentBlock: number;
  producerMaxFreshnessBlocks: number;
  effectiveMaxFreshnessBlocks: number;
  pools: FamePoolStateResponseEntry[];
}

type QuoteModelPool = FamePoolStateRegistryEntry & { poolAddress: Address };
type ClHeadPool = FameClHeadSnapshotRegistryEntry;
type ClReplayPool = FameClReplayRegistryEntry;
type V4ClReplayPool = FameV4ClReplayRegistryEntry;

export class FamePoolStateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamePoolStateRequestError";
  }
}

export function isFamePoolStateRequestError(
  error: unknown,
): error is FamePoolStateRequestError {
  return error instanceof FamePoolStateRequestError;
}

function apiError(path: string, message: string): never {
  throw new FamePoolStateRequestError(
    `FAME pool-state request invalid at ${path}: ${message}.`,
  );
}

function parseObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    apiError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    apiError(path, "expected a non-empty string");
  }
  return value;
}

function parseInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    apiError(path, "expected a non-negative safe integer");
  }
  return value;
}

function parseAddress(value: unknown, path: string): Address {
  const parsed = parseString(value, path);
  if (!isAddress(parsed, { strict: false })) {
    apiError(path, "expected an EVM address");
  }
  return parsed as Address;
}

function optionalField(
  record: Record<string, unknown>,
  key: string,
): unknown | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function parsePoolKey(value: unknown, path: string): FamePoolStateRequestKey {
  const record = parseObject(value, path);
  const keys = Object.keys(record);
  const poolId = optionalField(record, "poolId");
  const chainId = optionalField(record, "chainId");
  const poolAddress = optionalField(record, "poolAddress");
  const hasPoolId = poolId !== undefined;
  const hasChainId = chainId !== undefined;
  const hasPoolAddress = poolAddress !== undefined;

  if (
    hasPoolId &&
    !hasChainId &&
    !hasPoolAddress &&
    keys.every((key) => key === "poolId")
  ) {
    return {
      poolId: parseString(poolId, `${path}.poolId`),
    };
  }

  if (
    !hasPoolId &&
    hasChainId &&
    hasPoolAddress &&
    keys.every((key) => key === "chainId" || key === "poolAddress")
  ) {
    return {
      chainId: parseInteger(chainId, `${path}.chainId`),
      poolAddress: parseAddress(poolAddress, `${path}.poolAddress`),
    };
  }

  apiError(
    path,
    "expected exactly one key shape: poolId or chainId and poolAddress",
  );
}

function parseStateSurfaces(
  value: unknown,
  path: string,
): FamePoolStateRequestStateSurface[] {
  if (!Array.isArray(value)) {
    apiError(path, "expected an array");
  }
  return value.map((item, index) => {
    const parsed = parseString(item, `${path}[${index.toString()}]`);
    if (
      parsed !== "cl-head-snapshot" &&
      parsed !== "cl-replay-v1" &&
      parsed !== "v4-cl-replay-v1"
    ) {
      apiError(
        `${path}[${index.toString()}]`,
        "expected cl-head-snapshot, cl-replay-v1, or v4-cl-replay-v1",
      );
    }
    return parsed;
  });
}

export function parseFamePoolStateBatchRequest(
  value: unknown,
): FamePoolStateBatchRequest {
  const record = parseObject(value, "$");
  const poolsValue = optionalField(record, "pools");
  if (!Array.isArray(poolsValue)) {
    apiError("$.pools", "expected an array");
  }

  const maxFreshnessBlocks = optionalField(record, "maxFreshnessBlocks");
  const stateSurfaces = optionalField(record, "stateSurfaces");
  return {
    currentBlock: parseInteger(
      optionalField(record, "currentBlock"),
      "$.currentBlock",
    ),
    ...(maxFreshnessBlocks === undefined
      ? {}
      : {
          maxFreshnessBlocks: parseInteger(
            maxFreshnessBlocks,
            "$.maxFreshnessBlocks",
          ),
        }),
    ...(stateSurfaces === undefined
      ? {}
      : {
          stateSurfaces: parseStateSurfaces(stateSurfaces, "$.stateSurfaces"),
        }),
    pools: poolsValue.map((pool, index) =>
      parsePoolKey(pool, `$.pools[${index}]`),
    ),
  };
}

function registryMaps(registry: FamePoolStateRegistryFile) {
  const byPoolId = new Map(registry.pools.map((pool) => [pool.id, pool]));
  const byAddress = new Map(
    registry.pools
      .filter(
        (pool): pool is FamePoolStateRegistryEntry & { poolAddress: Address } =>
          pool.poolAddress !== null,
      )
      .map((pool) => [
        `${pool.chainId.toString()}:${pool.poolAddress.toLowerCase()}`,
        pool,
      ]),
  );
  return {
    byPoolId,
    byAddress,
  };
}

function registryEntryFor(
  key: FamePoolStateRequestKey,
  registry: ReturnType<typeof registryMaps>,
): FamePoolStateRegistryEntry | undefined {
  if (key.poolId) return registry.byPoolId.get(key.poolId);
  if (key.chainId === undefined || !key.poolAddress) return undefined;
  return registry.byAddress.get(
    `${key.chainId.toString()}:${key.poolAddress.toLowerCase()}`,
  );
}

function isQuoteModelPool(
  pool: FamePoolStateRegistryEntry,
): pool is QuoteModelPool {
  return pool.capability === "quote-model" && pool.poolAddress !== null;
}

function isClHeadPool(pool: FamePoolStateRegistryEntry): pool is ClHeadPool {
  return pool.stateSurface === "cl-head-snapshot" && pool.tickSpacing !== null;
}

function isClReplayPool(
  pool: FamePoolStateRegistryEntry,
): pool is ClReplayPool {
  return (
    pool.replaySurface === "cl-replay-v1" &&
    pool.stateSurface === "cl-head-snapshot" &&
    pool.tickSpacing !== null &&
    pool.poolAddress !== null &&
    pool.venue === "aerodrome-slipstream"
  );
}

function isV4ClReplayPool(
  pool: FamePoolStateRegistryEntry,
): pool is V4ClReplayPool {
  return (
    fameV4ZoraQuoteLaneManifestForPool(pool.id) !== null &&
    pool.venue === "uniswap-v4" &&
    pool.venueFamily === "UniswapV4" &&
    pool.poolAddress === null &&
    pool.poolKey !== null &&
    pool.stateViewAddress !== null &&
    pool.stateSurface === "cl-head-snapshot" &&
    pool.tickSpacing !== null
  );
}

function freshnessStatus(options: {
  state: { observedThroughBlock: number };
  currentBlock: number;
  maxFreshnessBlocks: number;
}): Extract<FamePoolStateStatus, "fresh" | "stale"> {
  if (options.state.observedThroughBlock > options.currentBlock) {
    return "stale";
  }
  return options.currentBlock - options.state.observedThroughBlock <=
    options.maxFreshnessBlocks
    ? "fresh"
    : "stale";
}

function addressStateKey(chainId: number, poolAddress: Address): string {
  return `${chainId.toString()}:${poolAddress.toLowerCase()}`;
}

function nullableHexEqual(
  left: Address | Hex | null,
  right: Address | Hex | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function clHeadStateMatchesRegistry({
  state,
  entry,
  sourceRegistryId,
}: {
  state: FameClHeadLatestState;
  entry: ClHeadPool;
  sourceRegistryId: string;
}): boolean {
  if (entry.fee.status !== "available") return false;
  return (
    state.sourceRegistryId === sourceRegistryId &&
    state.poolId === entry.id &&
    state.chainId === entry.chainId &&
    nullableHexEqual(state.poolAddress, entry.poolAddress) &&
    nullableHexEqual(state.poolKey, entry.poolKey) &&
    state.token0.toLowerCase() === entry.token0.toLowerCase() &&
    state.token1.toLowerCase() === entry.token1.toLowerCase() &&
    state.venueFamily === entry.venueFamily &&
    state.feeBps === entry.fee.feeBps &&
    state.feeLabel === entry.fee.label &&
    state.tickSpacing === entry.tickSpacing &&
    nullableHexEqual(state.stateViewAddress, entry.stateViewAddress)
  );
}

function clReplayLatestStateMatchesRegistry({
  latest,
  entry,
  sourceRegistryId,
}: {
  latest: FameClReplayLatestState;
  entry: ClReplayPool;
  sourceRegistryId: string;
}): boolean {
  return (
    latest.sourceRegistryId === sourceRegistryId &&
    latest.poolId === entry.id &&
    latest.chainId === entry.chainId &&
    latest.poolAddress.toLowerCase() === entry.poolAddress.toLowerCase() &&
    latest.token0.toLowerCase() === entry.token0.toLowerCase() &&
    latest.token1.toLowerCase() === entry.token1.toLowerCase() &&
    latest.venueFamily === entry.venueFamily &&
    latest.tickSpacing === entry.tickSpacing
  );
}

function clReplayStateMatchesRegistry({
  state,
  entry,
  sourceRegistryId,
}: {
  state: FameClReplayStateCapsule;
  entry: ClReplayPool;
  sourceRegistryId: string;
}): boolean {
  const latest = state.latest;
  return (
    clReplayLatestStateMatchesRegistry({ latest, entry, sourceRegistryId }) &&
    latest.bitmapWordCount === state.bitmapWords.length &&
    latest.initializedTickCount === state.initializedTicks.length
  );
}

function v4ClReplayLatestStateMatchesRegistry({
  latest,
  entry,
  sourceRegistryId,
}: {
  latest: FameV4ClReplayLatestState;
  entry: V4ClReplayPool;
  sourceRegistryId: string;
}): boolean {
  const manifest = fameV4ZoraQuoteLaneManifestForPool(entry.id);
  if (manifest === null) return false;
  const reviewed = latest.reviewedPoolEvidence;
  const provenanceOk =
    manifest.provenanceRequired &&
    latest.zoraProvenance !== undefined
      ? latest.zoraProvenance.status === "verified" &&
        latest.zoraProvenance.chainId === entry.chainId &&
        latest.zoraProvenance.coinAddress.toLowerCase() ===
          entry.token1.toLowerCase() &&
        latest.zoraProvenance.poolKey.toLowerCase() ===
          entry.poolKey.toLowerCase() &&
        latest.zoraProvenance.poolId.toLowerCase() ===
          entry.poolKey.toLowerCase()
      : !manifest.provenanceRequired && latest.zoraProvenance === undefined;
  return (
    latest.sourceRegistryId === sourceRegistryId &&
    latest.poolId === entry.id &&
    latest.chainId === entry.chainId &&
    latest.poolKey.toLowerCase() === entry.poolKey.toLowerCase() &&
    latest.stateViewAddress.toLowerCase() ===
      entry.stateViewAddress.toLowerCase() &&
    reviewed.status === "verified" &&
    reviewed.source === "reviewed-v4-manifest" &&
    reviewed.manifestVersion === manifest.version &&
    reviewed.poolId === manifest.poolId &&
    reviewed.poolKey.toLowerCase() === entry.poolKey.toLowerCase() &&
    reviewed.staticFee === manifest.reviewedPoolShape.fee.toString() &&
    reviewed.hookAddress.toLowerCase() ===
      manifest.reviewedPoolShape.hooks.toLowerCase() &&
    reviewed.hookData.toLowerCase() ===
      manifest.reviewedPoolShape.hookData.toLowerCase() &&
    reviewed.protocolFeeStatus === "zero" &&
    provenanceOk &&
    latest.token0.toLowerCase() === entry.token0.toLowerCase() &&
    latest.token1.toLowerCase() === entry.token1.toLowerCase() &&
    latest.venueFamily === entry.venueFamily &&
    latest.tickSpacing === entry.tickSpacing
  );
}

function v4ClReplayStateMatchesRegistry({
  state,
  entry,
  sourceRegistryId,
}: {
  state: FameV4ClReplayStateCapsule;
  entry: V4ClReplayPool;
  sourceRegistryId: string;
}): boolean {
  const latest = state.latest;
  return (
    v4ClReplayLatestStateMatchesRegistry({
      latest,
      entry,
      sourceRegistryId,
    }) &&
    latest.bitmapWordCount === state.bitmapWords.length &&
    latest.initializedTickCount === state.initializedTicks.length
  );
}

function clReplayResponseBase({
  latest,
  maxFreshnessBlocks,
}: {
  latest: FameClReplayLatestState;
  maxFreshnessBlocks: number;
}): FameClReplayResponseBase {
  return {
    stateKind: "cl-replay-v1",
    poolId: latest.poolId,
    chainId: latest.chainId,
    poolAddress: latest.poolAddress,
    token0: latest.token0,
    token1: latest.token1,
    venueFamily: latest.venueFamily,
    tickSpacing: latest.tickSpacing,
    sqrtPriceX96: latest.sqrtPriceX96,
    tick: latest.tick,
    liquidity: latest.liquidity,
    fee: latest.fee,
    feeSource: latest.feeSource,
    observedThroughBlock: latest.observedThroughBlock,
    blockHash: latest.blockHash,
    parentHash: latest.parentHash,
    snapshotId: latest.snapshotId,
    stateHash: latest.stateHash,
    source: latest.source,
    sourceRegistryId: latest.sourceRegistryId,
    maxFreshnessBlocks,
    bitmapWordCount: latest.bitmapWordCount,
    initializedTickCount: latest.initializedTickCount,
    bitmapChunkCount: latest.bitmapChunkCount,
    tickChunkCount: latest.tickChunkCount,
    minWordPosition: latest.minWordPosition,
    maxWordPosition: latest.maxWordPosition,
    minTick: latest.minTick,
    maxTick: latest.maxTick,
  };
}

function v4ClReplayResponseBase({
  latest,
  maxFreshnessBlocks,
}: {
  latest: FameV4ClReplayLatestState;
  maxFreshnessBlocks: number;
}): FameV4ClReplayResponseBase {
  return {
    stateKind: "v4-cl-replay-v1",
    poolId: latest.poolId,
    chainId: latest.chainId,
    poolKey: latest.poolKey,
    stateViewAddress: latest.stateViewAddress,
    token0: latest.token0,
    token1: latest.token1,
    venueFamily: latest.venueFamily,
    tickSpacing: latest.tickSpacing,
    sqrtPriceX96: latest.sqrtPriceX96,
    tick: latest.tick,
    liquidity: latest.liquidity,
    lpFee: latest.lpFee,
    protocolFee: latest.protocolFee,
    feeSource: latest.feeSource,
    observedThroughBlock: latest.observedThroughBlock,
    blockHash: latest.blockHash,
    parentHash: latest.parentHash,
    snapshotId: latest.snapshotId,
    stateHash: latest.stateHash,
    source: latest.source,
    reviewedPoolEvidence: latest.reviewedPoolEvidence,
    ...(latest.zoraProvenance
      ? { zoraProvenance: latest.zoraProvenance }
      : {}),
    sourceRegistryId: latest.sourceRegistryId,
    maxFreshnessBlocks,
    bitmapWordCount: latest.bitmapWordCount,
    initializedTickCount: latest.initializedTickCount,
    bitmapChunkCount: latest.bitmapChunkCount,
    tickChunkCount: latest.tickChunkCount,
    minWordPosition: latest.minWordPosition,
    maxWordPosition: latest.maxWordPosition,
    minTick: latest.minTick,
    maxTick: latest.maxTick,
  };
}

function unsupportedReasonForEntry(
  entry: FamePoolStateRegistryEntry,
): FamePoolStateUnsupportedReason {
  if (entry.unsupportedReason) return entry.unsupportedReason;
  if (entry.stateSurface === "cl-head-snapshot")
    return "concentrated-liquidity";
  return "unsupported-venue";
}

export async function handleFamePoolStateBatchRequest({
  request,
  tableName,
  db,
  registry = famePoolStateRegistry,
  producerMaxFreshnessBlocks = 120,
  maxBatchSize = 64,
}: {
  request: unknown;
  tableName: string;
  db?: PoolStateDocumentClient;
  registry?: FamePoolStateRegistryFile;
  producerMaxFreshnessBlocks?: number;
  maxBatchSize?: number;
}): Promise<FamePoolStateBatchResponse> {
  const parsed = parseFamePoolStateBatchRequest(request);
  if (parsed.pools.length > maxBatchSize) {
    apiError("$.pools", `expected at most ${maxBatchSize.toString()} pools`);
  }

  const effectiveMaxFreshnessBlocks = Math.min(
    parsed.maxFreshnessBlocks ?? producerMaxFreshnessBlocks,
    producerMaxFreshnessBlocks,
  );
  const sourceRegistryId = sourceRegistryIdFor(registry.source);
  const maps = registryMaps(registry);
  const includeClHeadSnapshots =
    parsed.stateSurfaces?.includes("cl-head-snapshot") ?? false;
  const includeClReplay =
    parsed.stateSurfaces?.includes("cl-replay-v1") ?? false;
  const includeV4ClReplay =
    parsed.stateSurfaces?.includes("v4-cl-replay-v1") ?? false;
  const entries = parsed.pools.map((pool) => ({
    request: pool,
    entry: registryEntryFor(pool, maps),
  }));
  const quoteModelPoolsById = new Map(
    entries
      .map(({ entry }) => entry)
      .filter(
        (entry): entry is QuoteModelPool =>
          entry !== undefined && isQuoteModelPool(entry),
      )
      .map((entry) => [entry.id, entry]),
  );
  const clHeadPoolsById = new Map(
    includeClHeadSnapshots
      ? entries
          .map(({ entry }) => entry)
          .filter(
            (entry): entry is ClHeadPool =>
              entry !== undefined && isClHeadPool(entry),
          )
          .map((entry) => [entry.id, entry])
      : [],
  );
  const clReplayPoolsById = new Map(
    includeClReplay
      ? entries
          .map(({ entry }) => entry)
          .filter(
            (entry): entry is ClReplayPool =>
              entry !== undefined && isClReplayPool(entry),
          )
          .map((entry) => [entry.id, entry])
      : [],
  );
  const v4ClReplayPoolsById = new Map(
    includeV4ClReplay
      ? entries
          .map(({ entry }) => entry)
          .filter(
            (entry): entry is V4ClReplayPool =>
              entry !== undefined && isV4ClReplayPool(entry),
          )
          .map((entry) => [entry.id, entry])
      : [],
  );
  const states = await batchGetLatestPoolStates({
    db,
    tableName,
    pools: [...quoteModelPoolsById.values()],
  });
  const clHeadStates = await batchGetLatestClHeadStates({
    db,
    tableName,
    pools: [...clHeadPoolsById.values()],
  });
  const clReplayLatestStates = await batchGetLatestClReplayPointers({
    db,
    tableName,
    pools: [...clReplayPoolsById.values()],
  });
  const v4ClReplayLatestStates = await batchGetLatestV4ClReplayPointers({
    db,
    tableName,
    pools: [...v4ClReplayPoolsById.values()],
  });
  const freshClReplayLatestStates = clReplayLatestStates.filter((latest) => {
    const entry = clReplayPoolsById.get(latest.poolId);
    return (
      entry !== undefined &&
      clReplayLatestStateMatchesRegistry({ latest, entry, sourceRegistryId }) &&
      freshnessStatus({
        state: latest,
        currentBlock: parsed.currentBlock,
        maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
      }) === "fresh"
    );
  });
  const clReplayStates = await batchGetClReplayStateCapsules({
    db,
    tableName,
    latestStates: freshClReplayLatestStates,
  });
  const freshV4ClReplayLatestStates = v4ClReplayLatestStates.filter(
    (latest) => {
      const entry = v4ClReplayPoolsById.get(latest.poolId);
      return (
        entry !== undefined &&
        v4ClReplayLatestStateMatchesRegistry({
          latest,
          entry,
          sourceRegistryId,
        }) &&
        freshnessStatus({
          state: latest,
          currentBlock: parsed.currentBlock,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        }) === "fresh"
      );
    },
  );
  const v4ClReplayStates = await batchGetV4ClReplayStateCapsules({
    db,
    tableName,
    latestStates: freshV4ClReplayLatestStates,
  });
  const statesByAddress = new Map(
    states.map((state) => [
      addressStateKey(state.chainId, state.poolAddress),
      state,
    ]),
  );
  const clHeadStatesByPoolId = new Map(
    clHeadStates.map((state) => [state.poolId, state]),
  );
  const clReplayStatesByPoolId = new Map(
    clReplayStates.map((state) => [state.latest.poolId, state]),
  );
  const clReplayLatestStatesByPoolId = new Map(
    clReplayLatestStates.map((state) => [state.poolId, state]),
  );
  const v4ClReplayStatesByPoolId = new Map(
    v4ClReplayStates.map((state) => [state.latest.poolId, state]),
  );
  const v4ClReplayLatestStatesByPoolId = new Map(
    v4ClReplayLatestStates.map((state) => [state.poolId, state]),
  );

  return {
    sourceRegistryId,
    currentBlock: parsed.currentBlock,
    producerMaxFreshnessBlocks,
    effectiveMaxFreshnessBlocks,
    pools: entries.map(({ request: requested, entry }) => {
      if (!entry) {
        return {
          status: "unknown",
          requested,
          reason: "missing-registry-entry",
        };
      }
      if (includeV4ClReplay && isV4ClReplayPool(entry)) {
        const latest = v4ClReplayLatestStatesByPoolId.get(entry.id);
        if (
          !latest ||
          !v4ClReplayLatestStateMatchesRegistry({
            latest,
            entry,
            sourceRegistryId,
          })
        ) {
          return {
            status: "unknown",
            requested,
            reason: "missing-indexed-state",
          };
        }
        const status = freshnessStatus({
          state: latest,
          currentBlock: parsed.currentBlock,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });

        const baseReplayResponse = v4ClReplayResponseBase({
          latest,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });

        if (status === "stale") {
          return {
            status,
            ...baseReplayResponse,
          };
        }

        const state = v4ClReplayStatesByPoolId.get(entry.id);
        if (
          !state ||
          !v4ClReplayStateMatchesRegistry({
            state,
            entry,
            sourceRegistryId,
          })
        ) {
          return {
            status: "unknown",
            requested,
            reason: "missing-indexed-state",
          };
        }

        return {
          status,
          ...baseReplayResponse,
          bitmapWords: state.bitmapWords,
          initializedTicks: state.initializedTicks,
        };
      }
      if (includeClReplay && isClReplayPool(entry)) {
        const latest = clReplayLatestStatesByPoolId.get(entry.id);
        if (
          !latest ||
          !clReplayLatestStateMatchesRegistry({
            latest,
            entry,
            sourceRegistryId,
          })
        ) {
          return {
            status: "unknown",
            requested,
            reason: "missing-indexed-state",
          };
        }
        const status = freshnessStatus({
          state: latest,
          currentBlock: parsed.currentBlock,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });

        const baseReplayResponse = clReplayResponseBase({
          latest,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });

        if (status === "stale") {
          return {
            status,
            ...baseReplayResponse,
          };
        }

        const state = clReplayStatesByPoolId.get(entry.id);
        if (
          !state ||
          !clReplayStateMatchesRegistry({ state, entry, sourceRegistryId })
        ) {
          return {
            status: "unknown",
            requested,
            reason: "missing-indexed-state",
          };
        }

        return {
          status,
          ...baseReplayResponse,
          bitmapWords: state.bitmapWords,
          initializedTicks: state.initializedTicks,
        };
      }
      if (includeClHeadSnapshots && isClHeadPool(entry)) {
        const state = clHeadStatesByPoolId.get(entry.id);
        if (
          !state ||
          !clHeadStateMatchesRegistry({ state, entry, sourceRegistryId })
        ) {
          return {
            status: "unknown",
            requested,
            reason: "missing-indexed-state",
          };
        }

        return {
          status: freshnessStatus({
            state,
            currentBlock: parsed.currentBlock,
            maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
          }),
          stateKind: "cl-head-snapshot",
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: state.poolAddress,
          poolKey: state.poolKey,
          token0: state.token0,
          token1: state.token1,
          venueFamily: state.venueFamily,
          feeBps: state.feeBps,
          feeLabel: state.feeLabel,
          tickSpacing: state.tickSpacing,
          stateViewAddress: state.stateViewAddress,
          sqrtPriceX96: state.sqrtPriceX96,
          tick: state.tick,
          liquidity: state.liquidity,
          observedThroughBlock: state.observedThroughBlock,
          source: state.source,
          sourceRegistryId: state.sourceRegistryId,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        };
      }
      if (!isQuoteModelPool(entry)) {
        return {
          status: "unsupported",
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
          unsupportedReason: unsupportedReasonForEntry(entry),
        };
      }

      const state = statesByAddress.get(
        addressStateKey(entry.chainId, entry.poolAddress),
      );
      if (!state) {
        return {
          status: "unknown",
          requested,
          reason: "missing-indexed-state",
        };
      }

      return {
        status: freshnessStatus({
          state,
          currentBlock: parsed.currentBlock,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        }),
        poolId: entry.id,
        chainId: entry.chainId,
        poolAddress: entry.poolAddress,
        token0: state.token0,
        token1: state.token1,
        reserve0: state.reserve0,
        reserve1: state.reserve1,
        k: state.k,
        observedThroughBlock: state.observedThroughBlock,
        lastReserveChangeBlock: state.lastReserveChangeBlock,
        source: state.source,
        quoteModel: "constant-product-reserves",
        maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
      };
    }),
  };
}
