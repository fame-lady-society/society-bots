import { readFileSync } from "node:fs";
import { isAddress, isHex, type Address, type Hex } from "viem";
import {
  FAME_POOL_STATE_REGISTRY_SCHEMA_VERSION,
  type FamePoolStateCapability,
  type FamePoolStateFeeDescriptor,
  type FamePoolStateQuoteModel,
  type FamePoolStateReplaySurface,
  type FamePoolStateRegistryDirection,
  type FamePoolStateRegistryEntry,
  type FamePoolStateRegistryFile,
  type FamePoolStateRegistrySource,
  type FamePoolStateSurface,
  type FamePoolStateUnsupportedReason,
  type FamePoolStateVenue,
  type FamePoolStateVenueFamily,
} from "../types.ts";

const venueValues = [
  "aerodrome-slipstream",
  "aerodrome-slipstream2",
  "aerodrome-v2",
  "native-wrap",
  "solidly",
  "uniswap-v2",
  "uniswap-v3",
  "uniswap-v4",
] as const satisfies readonly FamePoolStateVenue[];

const venueFamilyValues = [
  "AerodromeV2",
  "NativeWrap",
  "Slipstream",
  "Slipstream2",
  "Solidly",
  "UniswapV2",
  "UniswapV3",
  "UniswapV4",
] as const satisfies readonly FamePoolStateVenueFamily[];

const capabilityValues = [
  "market-state",
  "quote-model",
  "tracked-only",
] as const satisfies readonly FamePoolStateCapability[];

const quoteModelValues = [
  "constant-product-reserves",
] as const satisfies readonly FamePoolStateQuoteModel[];

const stateSurfaceValues = [
  "cl-head-snapshot",
  "constant-product-reserves",
] as const satisfies readonly FamePoolStateSurface[];

const replaySurfaceValues = [
  "cl-replay-v1",
] as const satisfies readonly FamePoolStateReplaySurface[];

const unsupportedReasonValues = [
  "concentrated-liquidity",
  "missing-fee-metadata",
  "native-wrap",
  "stable-pool",
  "unsupported-venue",
] as const satisfies readonly FamePoolStateUnsupportedReason[];

function registryError(path: string, message: string): never {
  throw new Error(`FAME pool-state registry invalid at ${path}: ${message}.`);
}

function parseObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    registryError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function field(
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(record, key)) {
    registryError(`${path}.${key}`, "missing required field");
  }
  return record[key];
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    registryError(path, "expected a non-empty string");
  }
  return value;
}

function parseNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    registryError(path, "expected a finite number");
  }
  return value;
}

function parseInteger(value: unknown, path: string): number {
  const parsed = parseNumber(value, path);
  if (!Number.isInteger(parsed)) {
    registryError(path, "expected an integer");
  }
  return parsed;
}

function parseIntegerOrNull(value: unknown, path: string): number | null {
  return value === null ? null : parseInteger(value, path);
}

function parseBooleanOrNull(value: unknown, path: string): boolean | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  registryError(path, "expected a boolean or null");
}

function parseAddress(value: unknown, path: string): Address {
  const parsed = parseString(value, path);
  if (!isAddress(parsed, { strict: false })) {
    registryError(path, "must be an EVM address");
  }
  return parsed as Address;
}

function parseAddressOrNull(value: unknown, path: string): Address | null {
  return value === null ? null : parseAddress(value, path);
}

function parseHex(value: unknown, path: string): Hex {
  const parsed = parseString(value, path);
  if (!isHex(parsed, { strict: true })) {
    registryError(path, "must be a hex string");
  }
  return parsed as Hex;
}

function parseHexOrNull(value: unknown, path: string): Hex | null {
  return value === null ? null : parseHex(value, path);
}

function parseEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const parsed = parseString(value, path);
  if (!allowed.includes(parsed as T)) {
    registryError(path, `expected one of ${allowed.join(", ")}`);
  }
  return parsed as T;
}

function parseNullableEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T | null {
  return value === null ? null : parseEnum(value, path, allowed);
}

function parseFee(value: unknown, path: string): FamePoolStateFeeDescriptor {
  const record = parseObject(value, path);
  const status = parseEnum(field(record, "status", path), `${path}.status`, [
    "available",
    "unavailable",
  ] as const);

  if (status === "available") {
    return {
      status,
      feeBps: parseNumber(field(record, "feeBps", path), `${path}.feeBps`),
      label: parseString(field(record, "label", path), `${path}.label`),
      source: parseEnum(field(record, "source", path), `${path}.source`, [
        "pool-metadata",
      ] as const),
    };
  }

  return {
    status,
    reason: parseString(field(record, "reason", path), `${path}.reason`),
  };
}

function parseSource(
  value: unknown,
  path: string,
): FamePoolStateRegistrySource {
  const record = parseObject(value, path);
  return {
    repo: parseEnum(field(record, "repo", path), `${path}.repo`, [
      "www",
    ] as const),
    schemaVersion: parseInteger(
      field(record, "schemaVersion", path),
      `${path}.schemaVersion`,
    ),
    pinnedBaseBlock: parseInteger(
      field(record, "pinnedBaseBlock", path),
      `${path}.pinnedBaseBlock`,
    ),
    poolsJsonHash: parseHex(
      field(record, "poolsJsonHash", path),
      `${path}.poolsJsonHash`,
    ),
    poolsContentHash: parseHex(
      field(record, "poolsContentHash", path),
      `${path}.poolsContentHash`,
    ),
    solverRoutesJsonHash: parseHex(
      field(record, "solverRoutesJsonHash", path),
      `${path}.solverRoutesJsonHash`,
    ),
    solverRoutesContentHash: parseHex(
      field(record, "solverRoutesContentHash", path),
      `${path}.solverRoutesContentHash`,
    ),
  };
}

function parseDirection(
  value: unknown,
  path: string,
): FamePoolStateRegistryDirection {
  const record = parseObject(value, path);
  return {
    tokenIn: parseAddress(field(record, "tokenIn", path), `${path}.tokenIn`),
    tokenOut: parseAddress(field(record, "tokenOut", path), `${path}.tokenOut`),
  };
}

function parseEntry(value: unknown, path: string): FamePoolStateRegistryEntry {
  const record = parseObject(value, path);
  const capability = parseEnum(
    field(record, "capability", path),
    `${path}.capability`,
    capabilityValues,
  );
  const chainId = parseInteger(
    field(record, "chainId", path),
    `${path}.chainId`,
  );
  if (chainId !== 8453) {
    registryError(`${path}.chainId`, "expected Base mainnet chain id 8453");
  }
  const entry: FamePoolStateRegistryEntry = {
    id: parseString(field(record, "id", path), `${path}.id`),
    chainId,
    venue: parseEnum(
      field(record, "venue", path),
      `${path}.venue`,
      venueValues,
    ),
    venueFamily: parseEnum(
      field(record, "venueFamily", path),
      `${path}.venueFamily`,
      venueFamilyValues,
    ),
    router: parseAddress(field(record, "router", path), `${path}.router`),
    poolAddress: parseAddressOrNull(
      field(record, "poolAddress", path),
      `${path}.poolAddress`,
    ),
    poolKey: parseHexOrNull(field(record, "poolKey", path), `${path}.poolKey`),
    token0: parseAddress(field(record, "token0", path), `${path}.token0`),
    token1: parseAddress(field(record, "token1", path), `${path}.token1`),
    stable: parseBooleanOrNull(field(record, "stable", path), `${path}.stable`),
    fee: parseFee(field(record, "fee", path), `${path}.fee`),
    tickSpacing: parseIntegerOrNull(
      field(record, "tickSpacing", path),
      `${path}.tickSpacing`,
    ),
    stateViewAddress: parseAddressOrNull(
      field(record, "stateViewAddress", path),
      `${path}.stateViewAddress`,
    ),
    capability,
    stateSurface: parseNullableEnum(
      field(record, "stateSurface", path),
      `${path}.stateSurface`,
      stateSurfaceValues,
    ),
    replaySurface: parseNullableEnum(
      field(record, "replaySurface", path),
      `${path}.replaySurface`,
      replaySurfaceValues,
    ),
    quoteModel: parseNullableEnum(
      field(record, "quoteModel", path),
      `${path}.quoteModel`,
      quoteModelValues,
    ),
    unsupportedReason: parseNullableEnum(
      field(record, "unsupportedReason", path),
      `${path}.unsupportedReason`,
      unsupportedReasonValues,
    ),
  };

  if (entry.capability === "quote-model") {
    if (entry.fee.status !== "available") {
      registryError(path, "quote-model pool must have fee metadata");
    }
    if (entry.quoteModel !== "constant-product-reserves") {
      registryError(
        path,
        "quote-model pool must use constant-product reserves",
      );
    }
    if (entry.stateSurface !== "constant-product-reserves") {
      registryError(path, "quote-model pool must use reserve state surface");
    }
    if (entry.unsupportedReason !== null) {
      registryError(path, "quote-model pool cannot have unsupportedReason");
    }
    if (entry.replaySurface !== null) {
      registryError(path, "quote-model pool cannot have replaySurface");
    }
    if (entry.poolAddress === null) {
      registryError(path, "quote-model pool must have a poolAddress");
    }
    if (entry.stateViewAddress !== null) {
      registryError(path, "quote-model pool cannot have stateViewAddress");
    }
  } else if (entry.capability === "market-state") {
    if (entry.fee.status !== "available") {
      registryError(path, "market-state pool must have fee metadata");
    }
    if (entry.quoteModel !== null) {
      registryError(path, "market-state pool cannot have quoteModel");
    }
    if (entry.unsupportedReason !== null) {
      registryError(path, "market-state pool cannot have unsupportedReason");
    }
    if (entry.stateSurface !== "cl-head-snapshot") {
      registryError(path, "market-state pool must use CL head state surface");
    }
    if (entry.tickSpacing === null) {
      registryError(path, "market-state pool must have tickSpacing");
    }
    if (entry.venue === "uniswap-v4") {
      if (entry.poolKey === null) {
        registryError(path, "Uniswap V4 market-state pool must have poolKey");
      }
      if (entry.stateViewAddress === null) {
        registryError(
          path,
          "Uniswap V4 market-state pool must have stateViewAddress",
        );
      }
    } else if (entry.poolAddress === null) {
      registryError(
        path,
        "address-backed market-state pool must have poolAddress",
      );
    }
    if (entry.replaySurface !== null) {
      if (entry.id !== "slipstream-usdc-weth-100") {
        registryError(
          path,
          "only slipstream-usdc-weth-100 can have replaySurface",
        );
      }
      if (entry.venue !== "aerodrome-slipstream") {
        registryError(path, "replaySurface pool must be Slipstream");
      }
      if (entry.poolAddress === null) {
        registryError(path, "replaySurface pool must have poolAddress");
      }
      if (entry.stateSurface !== "cl-head-snapshot") {
        registryError(
          path,
          "replaySurface pool must keep CL head state surface",
        );
      }
    }
  } else {
    if (entry.quoteModel !== null) {
      registryError(path, "tracked-only pool cannot have quoteModel");
    }
    if (entry.stateSurface !== null) {
      registryError(path, "tracked-only pool cannot have stateSurface");
    }
    if (entry.replaySurface !== null) {
      registryError(path, "tracked-only pool cannot have replaySurface");
    }
    if (entry.unsupportedReason === null) {
      registryError(path, "tracked-only pool must have unsupportedReason");
    }
  }

  return entry;
}

function parseArray<T>(
  value: unknown,
  path: string,
  parser: (item: unknown, itemPath: string) => T,
): T[] {
  if (!Array.isArray(value)) {
    registryError(path, "expected an array");
  }
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

function assertUniquePools(pools: readonly FamePoolStateRegistryEntry[]): void {
  const ids = new Set<string>();
  const addresses = new Set<string>();

  for (const pool of pools) {
    if (ids.has(pool.id)) {
      registryError("pools", `duplicate pool id ${pool.id}`);
    }
    ids.add(pool.id);

    if (pool.poolAddress === null) continue;
    const addressKey = registryAddressKey(pool.chainId, pool.poolAddress);
    if (addresses.has(addressKey)) {
      registryError("pools", `duplicate pool address ${addressKey}`);
    }
    addresses.add(addressKey);
  }
}

function assertReplaySurfaceScope(
  pools: readonly FamePoolStateRegistryEntry[],
): void {
  const replayPools = pools.filter((pool) => pool.replaySurface !== null);
  if (
    replayPools.length !== 1 ||
    replayPools[0]?.id !== "slipstream-usdc-weth-100" ||
    replayPools[0].replaySurface !== "cl-replay-v1"
  ) {
    registryError(
      "pools",
      "expected exactly slipstream-usdc-weth-100 to have cl-replay-v1; only slipstream-usdc-weth-100 can have replaySurface",
    );
  }
}

export function parseFamePoolStateRegistry(
  value: unknown,
): FamePoolStateRegistryFile {
  const record = parseObject(value, "$");
  const schemaVersion = parseInteger(
    field(record, "schemaVersion", "$"),
    "$.schemaVersion",
  );
  if (schemaVersion !== FAME_POOL_STATE_REGISTRY_SCHEMA_VERSION) {
    registryError(
      "$.schemaVersion",
      `expected ${FAME_POOL_STATE_REGISTRY_SCHEMA_VERSION.toString()}`,
    );
  }

  const registry: FamePoolStateRegistryFile = {
    schemaVersion,
    status: parseEnum(field(record, "status", "$"), "$.status", [
      "generated-reviewed-route-candidates",
    ] as const),
    source: parseSource(field(record, "source", "$"), "$.source"),
    candidateDirections: parseArray(
      field(record, "candidateDirections", "$"),
      "$.candidateDirections",
      parseDirection,
    ),
    pools: parseArray(field(record, "pools", "$"), "$.pools", parseEntry),
  };
  assertUniquePools(registry.pools);
  assertReplaySurfaceScope(registry.pools);
  return registry;
}

function loadGeneratedRegistry(): unknown {
  const file = new URL("./base-v1-pools.json", import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function registryAddressKey(chainId: number, poolAddress: Address): string {
  return `${chainId.toString()}:${poolAddress.toLowerCase()}`;
}

export const famePoolStateRegistry = parseFamePoolStateRegistry(
  loadGeneratedRegistry(),
);

const registryEntriesById = new Map(
  famePoolStateRegistry.pools.map((pool) => [pool.id, pool]),
);

const registryEntriesByAddress = new Map(
  famePoolStateRegistry.pools
    .filter(
      (pool): pool is FamePoolStateRegistryEntry & { poolAddress: Address } =>
        pool.poolAddress !== null,
    )
    .map((pool) => [registryAddressKey(pool.chainId, pool.poolAddress), pool]),
);

export function getFamePoolStateRegistryEntry(
  input: { poolId: string } | { chainId: number; poolAddress: Address },
): FamePoolStateRegistryEntry | undefined {
  if ("poolId" in input) {
    return registryEntriesById.get(input.poolId);
  }
  return registryEntriesByAddress.get(
    registryAddressKey(input.chainId, input.poolAddress),
  );
}
