import { isAddress, isHex, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { sourceRegistryIdFor } from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
} from "./types.ts";

const rawAuthority: unknown = JSON.parse(
  readFileSync(
    new URL("./fixtures/fame-landing-defi-authority-v1.json", import.meta.url),
    "utf8",
  ),
);

export const FAME_LANDING_AUTHORITY_SCHEMA_VERSION =
  "fame-landing-defi-authority-v1" as const;
export const FAME_LANDING_SNAPSHOT_SCHEMA_VERSION =
  "fame-landing-defi-snapshot-v1" as const;

export const FAME_LANDING_SNAPSHOT_CONTENT_TTL_SECONDS = 24 * 60 * 60;
export const FAME_LANDING_SNAPSHOT_MAX_AGE_SECONDS = 5 * 60;
export const FAME_LANDING_SNAPSHOT_CACHE_SECONDS = 60;
export const FAME_LANDING_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS = 2 * 60;
export const FAME_LANDING_SNAPSHOT_FUTURE_TOLERANCE_SECONDS = 30;
export const FAME_LANDING_SNAPSHOT_RUN_TIMEOUT_MS = 10_000;
export const FAME_LANDING_SNAPSHOT_LEAF_TIMEOUT_MS = 1_500;
export const FAME_LANDING_SNAPSHOT_MAX_SOLVER_EVALUATIONS = 48;

export const FAME_LANDING_QUOTE_DEFINITION_IDS = [
  "defi-buy-usdc-v1",
  "defi-buy-eth-v1",
  "defi-sell-usdc-v1",
  "defi-sell-eth-v1",
  "nft-buy-usdc-v1",
  "nft-buy-eth-v1",
] as const;

export const FAME_LANDING_QUOTE_FIELDS = [
  "defiBuyUsdc",
  "defiBuyEth",
  "defiSellUsdc",
  "defiSellEth",
  "nftBuyUsdc",
  "nftBuyEth",
] as const;

export type FameLandingQuoteDefinitionId =
  (typeof FAME_LANDING_QUOTE_DEFINITION_IDS)[number];
export type FameLandingQuoteField = (typeof FAME_LANDING_QUOTE_FIELDS)[number];
export type FameLandingQuoteCurrency = "USDC" | "ETH";
export type FameLandingQuoteKind = "defiBuy" | "defiSell" | "nftBuy";

const DEFINITION_ID_BY_FIELD = Object.fromEntries(
  FAME_LANDING_QUOTE_FIELDS.map((field, index) => [
    field,
    FAME_LANDING_QUOTE_DEFINITION_IDS[index],
  ]),
) as Record<FameLandingQuoteField, FameLandingQuoteDefinitionId>;

export type FameLandingUnavailableReason =
  | "captured-state-missing"
  | "deadline-exceeded"
  | "dependency-unavailable"
  | "invalid-marketplace-state"
  | "invalid-pool-state"
  | "no-safe-route"
  | "solver-limit-reached";

const UNAVAILABLE_REASONS = new Set<FameLandingUnavailableReason>([
  "captured-state-missing",
  "deadline-exceeded",
  "dependency-unavailable",
  "invalid-marketplace-state",
  "invalid-pool-state",
  "no-safe-route",
  "solver-limit-reached",
]);

export type FameLandingFieldState<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; reason: FameLandingUnavailableReason };

export interface FameLandingQuoteDefinition {
  id: FameLandingQuoteDefinitionId;
  kind: FameLandingQuoteKind;
  currency: FameLandingQuoteCurrency;
  mode: "exactInput" | "exactTarget";
  fameAmountSource: "fixed-defi-amount" | "marketplace-unit-plus-premium";
}

export interface FameLandingRouteTemplate {
  id: string;
  allocations: {
    poolId: string;
    allocationBps: number;
  }[];
}

export type FameLandingQuoteCapability =
  | {
      quoteDefinitionId: FameLandingQuoteDefinitionId;
      status: "enabled";
      evaluator: "constant-product-captured-reserves-v1";
      routeTemplates: FameLandingRouteTemplate[];
    }
  | {
      quoteDefinitionId: FameLandingQuoteDefinitionId;
      status: "unavailable";
      reason: "captured-state-missing";
    };

export interface FameLandingAuthority {
  schemaVersion: typeof FAME_LANDING_AUTHORITY_SCHEMA_VERSION;
  sourceRegistryId: string;
  routeAuthorityRevision: string;
  fameToken: Address;
  defiFameAmount: string;
  quoteDefinitions: FameLandingQuoteDefinition[];
  assets: {
    currency: FameLandingQuoteCurrency;
    address: Address;
    wrappedAddress: Address | null;
    symbol: string;
    decimals: number;
    native: boolean;
  }[];
  counterAssets: {
    address: Address;
    symbol: string;
    decimals: number;
  }[];
  directLiquidityPoolIds: string[];
  capabilities: FameLandingQuoteCapability[];
}

export interface FameLandingMarketplaceValue {
  unit: string;
  premium: string;
  totalSupply: string;
  decimals: number;
}

export interface FameLandingQuoteValue {
  amount: string;
  quoteDefinitionId: FameLandingQuoteDefinitionId;
  routeId: string;
}

export interface FameLandingLiquidityValue {
  fameAmount: string;
  counterAssets: {
    address: Address;
    amount: string;
    decimals: number;
    symbol: string;
  }[];
}

export interface FameLandingSnapshot {
  schemaVersion: typeof FAME_LANDING_SNAPSHOT_SCHEMA_VERSION;
  provenance: {
    chainId: 8453;
    safeBlockNumber: number;
    safeBlockHash: Hex;
    capturedAt: string;
    sourceRegistryId: string;
    routeAuthorityRevision: string;
    snapshotId: string;
  };
  fields: {
    marketplace: FameLandingFieldState<FameLandingMarketplaceValue>;
    quotes: Record<
      FameLandingQuoteField,
      FameLandingFieldState<FameLandingQuoteValue>
    >;
    liquidity: FameLandingFieldState<FameLandingLiquidityValue>;
  };
}

export class FameLandingSnapshotValidationError extends Error {
  constructor(path: string, message: string) {
    super(`FAME landing snapshot invalid at ${path}: ${message}.`);
    this.name = "FameLandingSnapshotValidationError";
  }
}

function invalid(path: string, message: string): never {
  throw new FameLandingSnapshotValidationError(path, message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, i) => key !== wanted[i])
  ) {
    invalid(path, `expected only ${wanted.join(", ")}`);
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(path, "expected a non-empty string");
  }
  return value;
}

function integer(value: unknown, path: string, maximum?: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    invalid(path, "expected a non-negative safe integer");
  }
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "expected a boolean");
  return value;
}

function literal<const T extends string>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) invalid(path, `expected ${expected}`);
  return expected;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    invalid(path, `expected one of ${values.join(", ")}`);
  }
  return value as T[number];
}

function address(value: unknown, path: string): Address {
  const parsed = string(value, path);
  if (!isAddress(parsed, { strict: false }))
    invalid(path, "expected an address");
  return parsed as Address;
}

function nullableAddress(value: unknown, path: string): Address | null {
  return value === null ? null : address(value, path);
}

function bytes32(value: unknown, path: string): Hex {
  const parsed = string(value, path);
  if (!isHex(parsed) || parsed.length !== 66) invalid(path, "expected bytes32");
  return parsed as Hex;
}

function decimal(value: unknown, path: string): string {
  const parsed = string(value, path);
  if (!/^(0|[1-9][0-9]*)$/u.test(parsed)) {
    invalid(path, "expected a canonical decimal string");
  }
  return parsed;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, "expected an array");
  return value;
}

function definitionShape(id: FameLandingQuoteDefinitionId) {
  const [family, action, currency] = id.split("-");
  return {
    kind:
      family === "nft"
        ? ("nftBuy" as const)
        : action === "buy"
          ? ("defiBuy" as const)
          : ("defiSell" as const),
    currency: currency?.toUpperCase() as FameLandingQuoteCurrency,
    mode:
      action === "sell" ? ("exactInput" as const) : ("exactTarget" as const),
    fameAmountSource:
      family === "nft"
        ? ("marketplace-unit-plus-premium" as const)
        : ("fixed-defi-amount" as const),
  };
}

function directFamePool(
  pool: FamePoolStateRegistryEntry,
  fame: Address,
): boolean {
  const normalized = fame.toLowerCase();
  return (
    pool.token0.toLowerCase() === normalized ||
    pool.token1.toLowerCase() === normalized
  );
}

function parseAuthorityDefinition(
  value: unknown,
  index: number,
): FameLandingQuoteDefinition {
  const path = `$.quoteDefinitions[${index.toString()}]`;
  const record = object(value, path);
  exactKeys(
    record,
    ["id", "kind", "currency", "mode", "fameAmountSource"],
    path,
  );
  const expectedId = FAME_LANDING_QUOTE_DEFINITION_IDS[index];
  if (!expectedId) invalid(path, "unexpected quote definition");
  const id = literal(record.id, expectedId, `${path}.id`);
  const expected = definitionShape(id);
  return {
    id,
    kind: literal(record.kind, expected.kind, `${path}.kind`),
    currency: literal(record.currency, expected.currency, `${path}.currency`),
    mode: literal(record.mode, expected.mode, `${path}.mode`),
    fameAmountSource: literal(
      record.fameAmountSource,
      expected.fameAmountSource,
      `${path}.fameAmountSource`,
    ),
  };
}

function parseRouteTemplate(
  value: unknown,
  path: string,
  registryById: Map<string, FamePoolStateRegistryEntry>,
  fameToken: Address,
  assetAddress: Address,
): FameLandingRouteTemplate {
  const record = object(value, path);
  exactKeys(record, ["id", "allocations"], path);
  const allocations = array(record.allocations, `${path}.allocations`).map(
    (allocation, index) => {
      const allocationPath = `${path}.allocations[${index.toString()}]`;
      const parsed = object(allocation, allocationPath);
      exactKeys(parsed, ["poolId", "allocationBps"], allocationPath);
      const poolId = string(parsed.poolId, `${allocationPath}.poolId`);
      const pool = registryById.get(poolId);
      if (
        !pool ||
        pool.capability !== "quote-model" ||
        pool.stateSurface !== "constant-product-reserves" ||
        pool.quoteModel !== "constant-product-reserves" ||
        !directFamePool(pool, fameToken) ||
        ![pool.token0.toLowerCase(), pool.token1.toLowerCase()].includes(
          assetAddress.toLowerCase(),
        )
      ) {
        invalid(
          allocationPath,
          "pool is not supported by the captured-state evaluator",
        );
      }
      return {
        poolId,
        allocationBps: integer(
          parsed.allocationBps,
          `${allocationPath}.allocationBps`,
          10_000,
        ),
      };
    },
  );
  if (
    allocations.length === 0 ||
    allocations.reduce(
      (sum, allocation) => sum + allocation.allocationBps,
      0,
    ) !== 10_000
  ) {
    invalid(`${path}.allocations`, "allocation basis points must total 10000");
  }
  if (
    new Set(allocations.map(({ poolId }) => poolId)).size !== allocations.length
  ) {
    invalid(`${path}.allocations`, "duplicate pool allocation");
  }
  return { id: string(record.id, `${path}.id`), allocations };
}

export function parseFameLandingAuthority(
  value: unknown,
  registry: FamePoolStateRegistryFile = famePoolStateRegistry,
): FameLandingAuthority {
  const record = object(value, "$.");
  exactKeys(
    record,
    [
      "schemaVersion",
      "sourceRegistryId",
      "routeAuthorityRevision",
      "fameToken",
      "defiFameAmount",
      "quoteDefinitions",
      "assets",
      "counterAssets",
      "directLiquidityPoolIds",
      "capabilities",
    ],
    "$",
  );
  const schemaVersion = literal(
    record.schemaVersion,
    FAME_LANDING_AUTHORITY_SCHEMA_VERSION,
    "$.schemaVersion",
  );
  const expectedSourceRegistryId = sourceRegistryIdFor(registry.source);
  const sourceRegistryId = string(
    record.sourceRegistryId,
    "$.sourceRegistryId",
  );
  if (sourceRegistryId !== expectedSourceRegistryId) {
    invalid(
      "$.sourceRegistryId",
      "source registry does not match the reviewed pool registry",
    );
  }
  const routeAuthorityRevision = string(
    record.routeAuthorityRevision,
    "$.routeAuthorityRevision",
  );
  if (!routeAuthorityRevision.startsWith("fame-landing-route-authority-v1:")) {
    invalid("$.routeAuthorityRevision", "unexpected route authority revision");
  }
  const fameToken = address(record.fameToken, "$.fameToken");
  const defiFameAmount = decimal(record.defiFameAmount, "$.defiFameAmount");

  const quoteDefinitionValues = array(
    record.quoteDefinitions,
    "$.quoteDefinitions",
  );
  if (
    quoteDefinitionValues.length !== FAME_LANDING_QUOTE_DEFINITION_IDS.length
  ) {
    invalid(
      "$.quoteDefinitions",
      "expected every landing quote definition exactly once",
    );
  }
  const quoteDefinitions = quoteDefinitionValues.map(parseAuthorityDefinition);

  const assets = array(record.assets, "$.assets").map((value, index) => {
    const path = `$.assets[${index.toString()}]`;
    const asset = object(value, path);
    exactKeys(
      asset,
      ["currency", "address", "wrappedAddress", "symbol", "decimals", "native"],
      path,
    );
    return {
      currency: oneOf(
        asset.currency,
        ["USDC", "ETH"] as const,
        `${path}.currency`,
      ),
      address: address(asset.address, `${path}.address`),
      wrappedAddress: nullableAddress(
        asset.wrappedAddress,
        `${path}.wrappedAddress`,
      ),
      symbol: string(asset.symbol, `${path}.symbol`),
      decimals: integer(asset.decimals, `${path}.decimals`, 255),
      native: bool(asset.native, `${path}.native`),
    };
  });
  if (
    assets.length !== 2 ||
    new Set(assets.map(({ currency }) => currency)).size !== 2
  ) {
    invalid("$.assets", "expected one USDC and one ETH asset");
  }

  const counterAssets = array(record.counterAssets, "$.counterAssets").map(
    (value, index) => {
      const path = `$.counterAssets[${index.toString()}]`;
      const asset = object(value, path);
      exactKeys(asset, ["address", "symbol", "decimals"], path);
      return {
        address: address(asset.address, `${path}.address`),
        symbol: string(asset.symbol, `${path}.symbol`),
        decimals: integer(asset.decimals, `${path}.decimals`, 255),
      };
    },
  );
  if (
    new Set(counterAssets.map(({ address: token }) => token.toLowerCase()))
      .size !== counterAssets.length
  ) {
    invalid("$.counterAssets", "duplicate counter asset");
  }

  const registryById = new Map(registry.pools.map((pool) => [pool.id, pool]));
  const directLiquidityPoolIds = array(
    record.directLiquidityPoolIds,
    "$.directLiquidityPoolIds",
  ).map((poolId, index) => {
    const parsed = string(
      poolId,
      `$.directLiquidityPoolIds[${index.toString()}]`,
    );
    const pool = registryById.get(parsed);
    if (!pool || !directFamePool(pool, fameToken)) {
      invalid(
        `$.directLiquidityPoolIds[${index.toString()}]`,
        "expected a reviewed direct FAME pool",
      );
    }
    return parsed;
  });
  const expectedDirectPoolIds = registry.pools
    .filter((pool) => directFamePool(pool, fameToken))
    .map(({ id }) => id)
    .sort();
  if (
    JSON.stringify([...directLiquidityPoolIds].sort()) !==
    JSON.stringify(expectedDirectPoolIds)
  ) {
    invalid(
      "$.directLiquidityPoolIds",
      "expected every reviewed direct FAME pool exactly once",
    );
  }

  const expectedCounterTokens = new Set(
    expectedDirectPoolIds.map((poolId) => {
      const pool = registryById.get(poolId);
      if (!pool) invalid("$.directLiquidityPoolIds", "missing registry pool");
      return pool.token0.toLowerCase() === fameToken.toLowerCase()
        ? pool.token1.toLowerCase()
        : pool.token0.toLowerCase();
    }),
  );
  if (
    counterAssets.length !== expectedCounterTokens.size ||
    counterAssets.some(
      ({ address: token }) => !expectedCounterTokens.has(token.toLowerCase()),
    )
  ) {
    invalid(
      "$.counterAssets",
      "metadata must cover every direct-pool counter asset",
    );
  }

  const definitionsById = new Map(
    quoteDefinitions.map((definition) => [definition.id, definition]),
  );
  const assetsByCurrency = new Map(
    assets.map((asset) => [asset.currency, asset]),
  );
  const capabilities = array(record.capabilities, "$.capabilities").map(
    (value, index): FameLandingQuoteCapability => {
      const path = `$.capabilities[${index.toString()}]`;
      const capability = object(value, path);
      const definitionId = oneOf(
        capability.quoteDefinitionId,
        FAME_LANDING_QUOTE_DEFINITION_IDS,
        `${path}.quoteDefinitionId`,
      );
      const status = oneOf(
        capability.status,
        ["enabled", "unavailable"] as const,
        `${path}.status`,
      );
      if (status === "unavailable") {
        exactKeys(capability, ["quoteDefinitionId", "status", "reason"], path);
        return {
          quoteDefinitionId: definitionId,
          status,
          reason: literal(
            capability.reason,
            "captured-state-missing",
            `${path}.reason`,
          ),
        };
      }
      exactKeys(
        capability,
        ["quoteDefinitionId", "status", "evaluator", "routeTemplates"],
        path,
      );
      const definition = definitionsById.get(definitionId);
      const asset = definition
        ? assetsByCurrency.get(definition.currency)
        : undefined;
      if (!definition || !asset)
        invalid(path, "missing quote definition asset");
      const assetAddress = asset.wrappedAddress ?? asset.address;
      const routeTemplates = array(
        capability.routeTemplates,
        `${path}.routeTemplates`,
      ).map((template, templateIndex) =>
        parseRouteTemplate(
          template,
          `${path}.routeTemplates[${templateIndex.toString()}]`,
          registryById,
          fameToken,
          assetAddress,
        ),
      );
      if (
        routeTemplates.length === 0 ||
        new Set(routeTemplates.map(({ id }) => id)).size !==
          routeTemplates.length
      ) {
        invalid(`${path}.routeTemplates`, "expected unique route templates");
      }
      return {
        quoteDefinitionId: definitionId,
        status,
        evaluator: literal(
          capability.evaluator,
          "constant-product-captured-reserves-v1",
          `${path}.evaluator`,
        ),
        routeTemplates,
      };
    },
  );
  if (
    capabilities.length !== FAME_LANDING_QUOTE_DEFINITION_IDS.length ||
    new Set(capabilities.map(({ quoteDefinitionId }) => quoteDefinitionId))
      .size !== capabilities.length
  ) {
    invalid(
      "$.capabilities",
      "expected one capability row per quote definition",
    );
  }

  return {
    schemaVersion,
    sourceRegistryId,
    routeAuthorityRevision,
    fameToken,
    defiFameAmount,
    quoteDefinitions,
    assets,
    counterAssets,
    directLiquidityPoolIds,
    capabilities,
  };
}

function parseUnavailableReason(
  value: unknown,
  path: string,
): FameLandingUnavailableReason {
  const parsed = string(value, path) as FameLandingUnavailableReason;
  if (!UNAVAILABLE_REASONS.has(parsed))
    invalid(path, "reason is not allowlisted");
  return parsed;
}

function parseFieldState<T>(
  value: unknown,
  path: string,
  parseValue: (value: unknown, path: string) => T,
): FameLandingFieldState<T> {
  const record = object(value, path);
  const status = oneOf(
    record.status,
    ["available", "unavailable"] as const,
    `${path}.status`,
  );
  if (status === "unavailable") {
    exactKeys(record, ["status", "reason"], path);
    return {
      status,
      reason: parseUnavailableReason(record.reason, `${path}.reason`),
    };
  }
  exactKeys(record, ["status", "value"], path);
  return { status, value: parseValue(record.value, `${path}.value`) };
}

function parseMarketplace(
  value: unknown,
  path: string,
): FameLandingMarketplaceValue {
  const record = object(value, path);
  exactKeys(record, ["unit", "premium", "totalSupply", "decimals"], path);
  return {
    unit: decimal(record.unit, `${path}.unit`),
    premium: decimal(record.premium, `${path}.premium`),
    totalSupply: decimal(record.totalSupply, `${path}.totalSupply`),
    decimals: integer(record.decimals, `${path}.decimals`, 255),
  };
}

function parseQuoteValue(
  value: unknown,
  path: string,
  expectedDefinitionId: FameLandingQuoteDefinitionId,
): FameLandingQuoteValue {
  const record = object(value, path);
  exactKeys(record, ["amount", "quoteDefinitionId", "routeId"], path);
  return {
    amount: decimal(record.amount, `${path}.amount`),
    quoteDefinitionId: literal(
      record.quoteDefinitionId,
      expectedDefinitionId,
      `${path}.quoteDefinitionId`,
    ),
    routeId: string(record.routeId, `${path}.routeId`),
  };
}

function parseQuoteFieldState(
  value: unknown,
  field: FameLandingQuoteField,
  authority: FameLandingAuthority,
): FameLandingFieldState<FameLandingQuoteValue> {
  const path = `$.fields.quotes.${field}`;
  const definitionId = DEFINITION_ID_BY_FIELD[field];
  const capability = authority.capabilities.find(
    ({ quoteDefinitionId }) => quoteDefinitionId === definitionId,
  );
  if (!capability) invalid(path, "quote capability is missing");
  const parsed = parseFieldState(value, path, (quote, valuePath) =>
    parseQuoteValue(quote, valuePath, definitionId),
  );
  if (capability.status === "unavailable") {
    if (
      parsed.status !== "unavailable" ||
      parsed.reason !== capability.reason
    ) {
      invalid(path, `capability requires ${capability.reason}`);
    }
    return parsed;
  }
  if (parsed.status === "unavailable") {
    if (parsed.reason === "captured-state-missing") {
      invalid(path, "enabled capability cannot be captured-state-missing");
    }
    return parsed;
  }
  if (
    !capability.routeTemplates.some(({ id }) => id === parsed.value.routeId)
  ) {
    invalid(path, "route id is not in the enabled capability matrix");
  }
  return parsed;
}

function parseLiquidity(
  value: unknown,
  path: string,
  authority: FameLandingAuthority,
): FameLandingLiquidityValue {
  const record = object(value, path);
  exactKeys(record, ["fameAmount", "counterAssets"], path);
  const metadataByAddress = new Map(
    authority.counterAssets.map((asset) => [
      asset.address.toLowerCase(),
      asset,
    ]),
  );
  const counterAssets = array(
    record.counterAssets,
    `${path}.counterAssets`,
  ).map((entry, index) => {
    const entryPath = `${path}.counterAssets[${index.toString()}]`;
    const asset = object(entry, entryPath);
    exactKeys(asset, ["address", "amount", "decimals", "symbol"], entryPath);
    const token = address(asset.address, `${entryPath}.address`);
    const metadata = metadataByAddress.get(token.toLowerCase());
    const decimals = integer(asset.decimals, `${entryPath}.decimals`, 255);
    const symbol = string(asset.symbol, `${entryPath}.symbol`);
    if (
      !metadata ||
      metadata.decimals !== decimals ||
      metadata.symbol !== symbol
    ) {
      invalid(entryPath, "counter asset metadata does not match authority");
    }
    return {
      address: token,
      amount: decimal(asset.amount, `${entryPath}.amount`),
      decimals,
      symbol,
    };
  });
  const addresses = counterAssets.map(({ address: token }) =>
    token.toLowerCase(),
  );
  if (new Set(addresses).size !== addresses.length) {
    invalid(`${path}.counterAssets`, "duplicate counter asset");
  }
  if (
    counterAssets.length !== authority.counterAssets.length ||
    counterAssets.some(
      ({ address: token }) => !metadataByAddress.has(token.toLowerCase()),
    )
  ) {
    invalid(`${path}.counterAssets`, "expected every authority counter asset");
  }
  return {
    fameAmount: decimal(record.fameAmount, `${path}.fameAmount`),
    counterAssets,
  };
}

export function fameLandingSnapshotId(
  safeBlockNumber: number,
  safeBlockHash: Hex,
  capturedAt: string,
): string {
  return `${FAME_LANDING_SNAPSHOT_SCHEMA_VERSION}:${safeBlockNumber.toString()}:${safeBlockHash}:${capturedAt}`;
}

export function parseFameLandingSnapshot(
  value: unknown,
  authority: FameLandingAuthority = fameLandingAuthority,
): FameLandingSnapshot {
  const record = object(value, "$.");
  exactKeys(record, ["schemaVersion", "provenance", "fields"], "$.");
  const schemaVersion = literal(
    record.schemaVersion,
    FAME_LANDING_SNAPSHOT_SCHEMA_VERSION,
    "$.schemaVersion",
  );
  const provenanceRecord = object(record.provenance, "$.provenance");
  exactKeys(
    provenanceRecord,
    [
      "chainId",
      "safeBlockNumber",
      "safeBlockHash",
      "capturedAt",
      "sourceRegistryId",
      "routeAuthorityRevision",
      "snapshotId",
    ],
    "$.provenance",
  );
  const chainId = integer(provenanceRecord.chainId, "$.provenance.chainId");
  if (chainId !== 8453)
    invalid("$.provenance.chainId", "expected Base chain id 8453");
  const safeBlockNumber = integer(
    provenanceRecord.safeBlockNumber,
    "$.provenance.safeBlockNumber",
  );
  const safeBlockHash = bytes32(
    provenanceRecord.safeBlockHash,
    "$.provenance.safeBlockHash",
  );
  const capturedAt = string(
    provenanceRecord.capturedAt,
    "$.provenance.capturedAt",
  );
  const capturedDate = new Date(capturedAt);
  if (
    !Number.isFinite(capturedDate.getTime()) ||
    capturedDate.toISOString() !== capturedAt
  ) {
    invalid("$.provenance.capturedAt", "expected a canonical ISO timestamp");
  }
  const sourceRegistryId = literal(
    provenanceRecord.sourceRegistryId,
    authority.sourceRegistryId,
    "$.provenance.sourceRegistryId",
  );
  const routeAuthorityRevision = literal(
    provenanceRecord.routeAuthorityRevision,
    authority.routeAuthorityRevision,
    "$.provenance.routeAuthorityRevision",
  );
  const snapshotId = literal(
    provenanceRecord.snapshotId,
    fameLandingSnapshotId(safeBlockNumber, safeBlockHash, capturedAt),
    "$.provenance.snapshotId",
  );

  const fieldsRecord = object(record.fields, "$.fields");
  exactKeys(fieldsRecord, ["marketplace", "quotes", "liquidity"], "$.fields");
  const quoteRecord = object(fieldsRecord.quotes, "$.fields.quotes");
  exactKeys(quoteRecord, FAME_LANDING_QUOTE_FIELDS, "$.fields.quotes");
  const quotes = Object.fromEntries(
    FAME_LANDING_QUOTE_FIELDS.map((field) => [
      field,
      parseQuoteFieldState(quoteRecord[field], field, authority),
    ]),
  ) as FameLandingSnapshot["fields"]["quotes"];

  return {
    schemaVersion,
    provenance: {
      chainId: 8453,
      safeBlockNumber,
      safeBlockHash,
      capturedAt,
      sourceRegistryId,
      routeAuthorityRevision,
      snapshotId,
    },
    fields: {
      marketplace: parseFieldState(
        fieldsRecord.marketplace,
        "$.fields.marketplace",
        parseMarketplace,
      ),
      quotes,
      liquidity: parseFieldState(
        fieldsRecord.liquidity,
        "$.fields.liquidity",
        (liquidity, path) => parseLiquidity(liquidity, path, authority),
      ),
    },
  };
}

export const fameLandingAuthority = parseFameLandingAuthority(
  rawAuthority,
  famePoolStateRegistry,
);
