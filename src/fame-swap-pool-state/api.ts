import { isAddress, type Address } from "viem";
import {
  batchGetLatestPoolStates,
  sourceRegistryIdFor,
  type FamePoolLatestState,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
  FamePoolStateUnsupportedReason,
} from "./types.ts";

export type FamePoolStateStatus = "fresh" | "stale" | "unknown" | "unsupported";

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

export function parseFamePoolStateBatchRequest(
  value: unknown,
): FamePoolStateBatchRequest {
  const record = parseObject(value, "$");
  const poolsValue = optionalField(record, "pools");
  if (!Array.isArray(poolsValue)) {
    apiError("$.pools", "expected an array");
  }

  const maxFreshnessBlocks = optionalField(record, "maxFreshnessBlocks");
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

function freshnessStatus(options: {
  state: FamePoolLatestState;
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
  const states = await batchGetLatestPoolStates({
    db,
    tableName,
    pools: [...quoteModelPoolsById.values()],
  });
  const statesByAddress = new Map(
    states.map((state) => [
      addressStateKey(state.chainId, state.poolAddress),
      state,
    ]),
  );

  return {
    sourceRegistryId: sourceRegistryIdFor(registry.source),
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
      if (!isQuoteModelPool(entry)) {
        return {
          status: "unsupported",
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
          unsupportedReason: entry.unsupportedReason ?? "unsupported-venue",
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
