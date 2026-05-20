import { isAddress, type Address, type Hex } from "viem";
import {
  batchGetLatestClHeadStates,
  batchGetLatestPoolStates,
  sourceRegistryIdFor,
  type FameClHeadLatestState,
  type FameClHeadSnapshotRegistryEntry,
  type FamePoolLatestState,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
  FamePoolStateUnsupportedReason,
  FamePoolStateVenueFamily,
} from "./types.ts";

export type FamePoolStateStatus = "fresh" | "stale" | "unknown" | "unsupported";
export type FamePoolStateRequestStateSurface = "cl-head-snapshot";

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
    if (parsed !== "cl-head-snapshot") {
      apiError(`${path}[${index.toString()}]`, "expected cl-head-snapshot");
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
          stateSurfaces: parseStateSurfaces(
            stateSurfaces,
            "$.stateSurfaces",
          ),
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

function unsupportedReasonForEntry(
  entry: FamePoolStateRegistryEntry,
): FamePoolStateUnsupportedReason {
  if (entry.unsupportedReason) return entry.unsupportedReason;
  if (entry.stateSurface === "cl-head-snapshot") return "concentrated-liquidity";
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
  const maps = registryMaps(registry);
  const includeClHeadSnapshots =
    parsed.stateSurfaces?.includes("cl-head-snapshot") ?? false;
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
  const statesByAddress = new Map(
    states.map((state) => [
      addressStateKey(state.chainId, state.poolAddress),
      state,
    ]),
  );
  const clHeadStatesByPoolId = new Map(
    clHeadStates.map((state) => [state.poolId, state]),
  );

  const sourceRegistryId = sourceRegistryIdFor(registry.source);

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
