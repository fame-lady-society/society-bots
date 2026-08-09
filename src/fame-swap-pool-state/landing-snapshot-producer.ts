import type { Address, Hex } from "viem";
import type { FamePoolLatestState } from "./dynamodb/pool-state.ts";
import {
  FAME_LANDING_QUOTE_FIELDS,
  FAME_LANDING_SNAPSHOT_LEAF_TIMEOUT_MS,
  FAME_LANDING_SNAPSHOT_MAX_SOLVER_EVALUATIONS,
  fameLandingAuthority,
  fameLandingSnapshotId,
  parseFameLandingSnapshot,
  type FameLandingAuthority,
  type FameLandingFieldState,
  type FameLandingMarketplaceValue,
  type FameLandingQuoteCapability,
  type FameLandingQuoteDefinition,
  type FameLandingQuoteField,
  type FameLandingQuoteValue,
  type FameLandingSnapshot,
  type FameLandingUnavailableReason,
} from "./landing-snapshot.ts";
import {
  famePoolStateRegistry,
  getFamePoolStateRegistryEntry,
} from "./registry/index.ts";
import {
  bestRouteQuote,
  bestRuntimeRouteQuote,
  quoteRuntimeTemplate,
  quoteTemplate,
  type CapturedQuoteCapability,
  type FameLandingRuntimeQuoteRequest,
  type RouteQuote,
  type RuntimeQuoteCapability,
  type RuntimeQuoteValidation,
} from "./landing-snapshot-quote.ts";
import type { FamePoolStateRegistryEntry } from "./types.ts";

export type { FameLandingRuntimeQuoteRequest } from "./landing-snapshot-quote.ts";

export interface FameLandingMarketplaceRead {
  unit: bigint;
  premium: bigint;
  totalSupply: bigint;
  decimals: number;
}

export interface FameLandingConcentratedPoolBalances {
  poolId: string;
  balances: Record<string, bigint>;
}

export interface FameLandingRuntimePoolReserves {
  poolId: string;
  blockNumber: bigint;
  reserve0: bigint;
  reserve1: bigint;
}

export type FameLandingRuntimeQuoteResult =
  | {
      quoteDefinitionId: FameLandingQuoteDefinition["id"];
      status: "available";
      blockNumber: bigint;
      amountOut: bigint;
    }
  | {
      quoteDefinitionId: FameLandingQuoteDefinition["id"];
      status: "unavailable";
    };

export interface FameLandingSnapshotProducerDependencies {
  readMarketplace(options: {
    blockNumber: bigint;
  }): Promise<FameLandingMarketplaceRead>;
  readReserveStates(options: {
    poolIds: readonly string[];
  }): Promise<readonly FamePoolLatestState[]>;
  readConcentratedPoolBalances(options: {
    blockNumber: bigint;
    poolId: string;
    poolAddress: Address;
    tokenAddresses: readonly Address[];
  }): Promise<FameLandingConcentratedPoolBalances>;
  readRuntimePoolReserves(options: {
    blockNumber: bigint;
    pools: readonly {
      poolId: string;
      poolAddress: Address;
    }[];
  }): Promise<readonly FameLandingRuntimePoolReserves[]>;
  readRuntimePoolQuotes(options: {
    blockNumber: bigint;
    requests: readonly FameLandingRuntimeQuoteRequest[];
  }): Promise<readonly FameLandingRuntimeQuoteResult[]>;
}

interface SettledLeaf<T> {
  status: "available";
  value: T;
}

interface FailedLeaf {
  status: "unavailable";
  reason: Extract<
    FameLandingUnavailableReason,
    "deadline-exceeded" | "dependency-unavailable"
  >;
}

type LeafResult<T> = SettledLeaf<T> | FailedLeaf;

class LeafDeadlineError extends Error {
  constructor() {
    super("landing snapshot leaf deadline exceeded");
    this.name = "LeafDeadlineError";
  }
}

function settleLeaf<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<LeafResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LeafDeadlineError()), timeoutMs);
  });
  return Promise.race([operation(), deadline])
    .then((value) => ({ status: "available", value }) as const)
    .catch((error: unknown) => ({
      status: "unavailable" as const,
      reason:
        error instanceof LeafDeadlineError
          ? ("deadline-exceeded" as const)
          : ("dependency-unavailable" as const),
    }))
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

function unavailable<T>(
  reason: FameLandingUnavailableReason,
): FameLandingFieldState<T> {
  return { status: "unavailable", reason };
}

function marketplaceField(
  result: LeafResult<FameLandingMarketplaceRead>,
): FameLandingFieldState<FameLandingMarketplaceValue> {
  if (result.status === "unavailable") return result;
  const { unit, premium, totalSupply, decimals } = result.value;
  if (
    unit < 0n ||
    premium < 0n ||
    totalSupply < 0n ||
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    return unavailable("invalid-marketplace-state");
  }
  return {
    status: "available",
    value: {
      unit: unit.toString(),
      premium: premium.toString(),
      totalSupply: totalSupply.toString(),
      decimals,
    },
  };
}

function poolById(poolId: string): FamePoolStateRegistryEntry | undefined {
  return getFamePoolStateRegistryEntry({ poolId });
}

function canonicalDecimal(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/u.test(value);
}

function capturedReserveState(
  poolId: string,
  statesByPoolId: Map<string, FamePoolLatestState>,
  safeBlockNumber: number,
  authority: FameLandingAuthority,
): {
  pool: FamePoolStateRegistryEntry;
  reserve0: bigint;
  reserve1: bigint;
} | null {
  const pool = poolById(poolId);
  const state = statesByPoolId.get(poolId);
  if (
    !pool ||
    !pool.poolAddress ||
    pool.capability !== "quote-model" ||
    pool.stateSurface !== "constant-product-reserves" ||
    pool.quoteModel !== "constant-product-reserves" ||
    !state ||
    state.observedThroughBlock !== safeBlockNumber ||
    state.sourceRegistryId !== authority.sourceRegistryId ||
    state.poolAddress.toLowerCase() !== pool.poolAddress.toLowerCase() ||
    state.token0.toLowerCase() !== pool.token0.toLowerCase() ||
    state.token1.toLowerCase() !== pool.token1.toLowerCase() ||
    !canonicalDecimal(state.reserve0) ||
    !canonicalDecimal(state.reserve1)
  ) {
    return null;
  }
  const reserve0 = BigInt(state.reserve0);
  const reserve1 = BigInt(state.reserve1);
  if (
    reserve0 <= 0n ||
    reserve1 <= 0n ||
    reserve0 * reserve1 !== BigInt(state.k)
  ) {
    return null;
  }
  return { pool, reserve0, reserve1 };
}

function assetForDefinition(
  definition: FameLandingQuoteDefinition,
  authority: FameLandingAuthority,
): Address | null {
  const asset = authority.assets.find(
    ({ currency }) => currency === definition.currency,
  );
  return asset ? (asset.wrappedAddress ?? asset.address) : null;
}

function routeReserves({
  capability,
  states,
  safeBlockNumber,
  authority,
}: {
  capability: CapturedQuoteCapability;
  states: readonly FamePoolLatestState[];
  safeBlockNumber: number;
  authority: FameLandingAuthority;
}): Map<
  string,
  { pool: FamePoolStateRegistryEntry; reserve0: bigint; reserve1: bigint }
> | null {
  const statesByPoolId = new Map(states.map((state) => [state.poolId, state]));
  const poolIds = new Set(
    capability.routeTemplates.flatMap(({ allocations }) =>
      allocations.map(({ poolId }) => poolId),
    ),
  );
  const result = new Map<
    string,
    { pool: FamePoolStateRegistryEntry; reserve0: bigint; reserve1: bigint }
  >();
  for (const poolId of poolIds) {
    const captured = capturedReserveState(
      poolId,
      statesByPoolId,
      safeBlockNumber,
      authority,
    );
    if (!captured) return null;
    result.set(poolId, captured);
  }
  return result;
}

function runtimeRouteReserves({
  capability,
  states,
  runtimeStates,
  safeBlockNumber,
  authority,
}: {
  capability: RuntimeQuoteCapability;
  states: readonly FamePoolLatestState[];
  runtimeStates: readonly FameLandingRuntimePoolReserves[];
  safeBlockNumber: number;
  authority: FameLandingAuthority;
}): Map<
  string,
  { pool: FamePoolStateRegistryEntry; reserve0: bigint; reserve1: bigint }
> | null {
  const statesByPoolId = new Map(states.map((state) => [state.poolId, state]));
  const runtimeByPoolId = new Map(
    runtimeStates.map((state) => [state.poolId, state]),
  );
  const poolIds = new Set(
    capability.routeTemplates.flatMap(({ legs }) => legs),
  );
  const result = new Map<
    string,
    { pool: FamePoolStateRegistryEntry; reserve0: bigint; reserve1: bigint }
  >();
  for (const poolId of poolIds) {
    const pool = poolById(poolId);
    if (!pool?.poolAddress) return null;
    if (pool.capability === "quote-model") {
      const captured = capturedReserveState(
        poolId,
        statesByPoolId,
        safeBlockNumber,
        authority,
      );
      if (!captured) return null;
      result.set(poolId, captured);
      continue;
    }
    const runtime = runtimeByPoolId.get(poolId);
    if (
      pool.capability !== "tracked-only" ||
      runtime?.blockNumber !== BigInt(safeBlockNumber) ||
      runtime.reserve0 <= 0n ||
      runtime.reserve1 <= 0n
    ) {
      return null;
    }
    result.set(poolId, {
      pool,
      reserve0: runtime.reserve0,
      reserve1: runtime.reserve1,
    });
  }
  return result;
}

function previousQuote(
  previousSnapshot: FameLandingSnapshot | null,
  field: FameLandingQuoteField,
  authority: FameLandingAuthority,
): FameLandingQuoteValue | null {
  if (
    !previousSnapshot ||
    previousSnapshot.provenance.sourceRegistryId !==
      authority.sourceRegistryId ||
    previousSnapshot.provenance.routeAuthorityRevision !==
      authority.routeAuthorityRevision
  ) {
    return null;
  }
  const previous = previousSnapshot.fields.quotes[field];
  return previous.status === "available" ? previous.value : null;
}

function exactTargetQuote({
  targetOutput,
  prior,
  maximumInput,
  precision,
  evaluateBest,
  evaluateRoute,
}: {
  targetOutput: bigint;
  prior: FameLandingQuoteValue | null;
  maximumInput: bigint;
  precision: bigint;
  evaluateBest(amountIn: bigint): RouteQuote | null;
  evaluateRoute(routeId: string, amountIn: bigint): RouteQuote | null;
}):
  | {
      status: "available";
      amountIn: bigint;
      quote: RouteQuote;
    }
  | {
      status: "unavailable";
      reason: "no-safe-route" | "solver-limit-reached";
    } {
  let evaluations = 0;
  const evaluate = (amountIn: bigint) => {
    if (evaluations >= FAME_LANDING_SNAPSHOT_MAX_SOLVER_EVALUATIONS)
      return null;
    evaluations += 1;
    return evaluateBest(amountIn);
  };
  let low = 0n;
  let high = maximumInput;
  let highQuote: RouteQuote | null = null;
  let warmStartUsed = false;

  if (prior && BigInt(prior.amount) > 0n) {
    const priorInput = BigInt(prior.amount);
    const validation = evaluateRoute(prior.routeId, priorInput);
    evaluations += 1;
    if (validation && validation.amountOut >= targetOutput) {
      const candidateLow = (priorInput * 95n) / 100n;
      const candidateHigh = (priorInput * 105n + 99n) / 100n;
      const lowQuote = evaluate(candidateLow);
      const upperQuote = evaluate(candidateHigh);
      if (
        lowQuote &&
        upperQuote &&
        lowQuote.amountOut < targetOutput &&
        upperQuote.amountOut >= targetOutput
      ) {
        low = candidateLow;
        high = candidateHigh;
        highQuote = upperQuote;
        warmStartUsed = true;
      }
    }
  }

  if (!warmStartUsed) {
    low = 0n;
    high = maximumInput;
    highQuote = evaluate(high);
    if (!highQuote || highQuote.amountOut < targetOutput) {
      return { status: "unavailable", reason: "no-safe-route" };
    }
  }

  while (high - low > precision) {
    if (evaluations >= FAME_LANDING_SNAPSHOT_MAX_SOLVER_EVALUATIONS) {
      return { status: "unavailable", reason: "solver-limit-reached" };
    }
    const midpoint = (low + high) / 2n;
    const quote = evaluate(midpoint);
    if (quote && quote.amountOut >= targetOutput) {
      high = midpoint;
      highQuote = quote;
    } else {
      low = midpoint + 1n;
    }
  }
  if (!highQuote || highQuote.amountOut < targetOutput) {
    return { status: "unavailable", reason: "no-safe-route" };
  }
  return {
    status: "available",
    amountIn: high,
    quote: highQuote,
  };
}

interface FameLandingQuoteDraft {
  field: FameLandingFieldState<FameLandingQuoteValue>;
  runtimeValidation: RuntimeQuoteValidation | null;
}

function unavailableQuoteDraft(
  reason: FameLandingUnavailableReason,
): FameLandingQuoteDraft {
  return { field: unavailable(reason), runtimeValidation: null };
}

function quoteFieldDraft({
  field,
  definition,
  capability,
  reserveResult,
  runtimeReserveResult,
  marketplace,
  safeBlockNumber,
  authority,
  previousSnapshot,
}: {
  field: FameLandingQuoteField;
  definition: FameLandingQuoteDefinition;
  capability: FameLandingQuoteCapability;
  reserveResult: LeafResult<readonly FamePoolLatestState[]>;
  runtimeReserveResult: LeafResult<readonly FameLandingRuntimePoolReserves[]>;
  marketplace: FameLandingFieldState<FameLandingMarketplaceValue>;
  safeBlockNumber: number;
  authority: FameLandingAuthority;
  previousSnapshot: FameLandingSnapshot | null;
}): FameLandingQuoteDraft {
  if (capability.status === "unavailable")
    return unavailableQuoteDraft(capability.reason);
  if (reserveResult.status === "unavailable")
    return unavailableQuoteDraft(reserveResult.reason);
  const asset = assetForDefinition(definition, authority);
  if (!asset) return unavailableQuoteDraft("invalid-pool-state");
  const fameAmount =
    definition.fameAmountSource === "marketplace-unit-plus-premium"
      ? marketplace.status === "available"
        ? BigInt(marketplace.value.unit) + BigInt(marketplace.value.premium)
        : null
      : BigInt(authority.defiFameAmount);
  if (fameAmount === null)
    return unavailableQuoteDraft("invalid-marketplace-state");

  const capturedReserves =
    capability.evaluator === "constant-product-captured-reserves-v1"
      ? routeReserves({
          capability,
          states: reserveResult.value,
          safeBlockNumber,
          authority,
        })
      : null;
  if (
    capability.evaluator === "constant-product-runtime-validated-v1" &&
    runtimeReserveResult.status === "unavailable"
  ) {
    return unavailableQuoteDraft(runtimeReserveResult.reason);
  }
  const runtimeReserves =
    capability.evaluator === "constant-product-runtime-validated-v1" &&
    runtimeReserveResult.status === "available"
      ? runtimeRouteReserves({
          capability,
          states: reserveResult.value,
          runtimeStates: runtimeReserveResult.value,
          safeBlockNumber,
          authority,
        })
      : null;
  const reserves = capturedReserves ?? runtimeReserves;
  if (!reserves) return unavailableQuoteDraft("invalid-pool-state");

  const evaluateBest = (amountIn: bigint): RouteQuote | null =>
    capability.evaluator === "constant-product-captured-reserves-v1"
      ? bestRouteQuote({
          capability,
          amountIn,
          tokenIn:
            definition.mode === "exactInput" ? authority.fameToken : asset,
          tokenOut:
            definition.mode === "exactInput" ? asset : authority.fameToken,
          reserves,
        })
      : bestRuntimeRouteQuote({
          capability,
          definition,
          amountIn,
          tokenIn:
            definition.mode === "exactInput" ? authority.fameToken : asset,
          tokenOut:
            definition.mode === "exactInput" ? asset : authority.fameToken,
          reserves,
        });
  const evaluateRoute = (
    routeId: string,
    amountIn: bigint,
  ): RouteQuote | null => {
    if (capability.evaluator === "constant-product-captured-reserves-v1") {
      const template = capability.routeTemplates.find(
        ({ id }) => id === routeId,
      );
      return template
        ? quoteTemplate({
            template,
            amountIn,
            tokenIn:
              definition.mode === "exactInput" ? authority.fameToken : asset,
            tokenOut:
              definition.mode === "exactInput" ? asset : authority.fameToken,
            reserves,
          })
        : null;
    }
    const template = capability.routeTemplates.find(({ id }) => id === routeId);
    return template
      ? quoteRuntimeTemplate({
          template,
          definition,
          amountIn,
          tokenIn:
            definition.mode === "exactInput" ? authority.fameToken : asset,
          tokenOut:
            definition.mode === "exactInput" ? asset : authority.fameToken,
          reserves,
        })
      : null;
  };

  if (definition.mode === "exactInput") {
    const quote = evaluateBest(fameAmount);
    return quote
      ? {
          field: {
            status: "available",
            value: {
              amount: quote.amountOut.toString(),
              quoteDefinitionId: definition.id,
              routeId: quote.routeId,
            },
          },
          runtimeValidation: quote.runtimeValidation,
        }
      : unavailableQuoteDraft("no-safe-route");
  }
  const solved = exactTargetQuote({
    targetOutput: fameAmount,
    prior: previousQuote(previousSnapshot, field, authority),
    maximumInput:
      definition.currency === "USDC" ? 100_000n * 10n ** 6n : 100n * 10n ** 18n,
    precision: definition.currency === "USDC" ? 100n : 10n ** 10n,
    evaluateBest,
    evaluateRoute,
  });
  return solved.status === "available"
    ? {
        field: {
          status: "available",
          value: {
            amount: solved.amountIn.toString(),
            quoteDefinitionId: definition.id,
            routeId: solved.quote.routeId,
          },
        },
        runtimeValidation: solved.quote.runtimeValidation,
      }
    : unavailableQuoteDraft(solved.reason);
}

function finalizeQuoteDraft(
  draft: FameLandingQuoteDraft,
  runtimeQuoteResult: LeafResult<readonly FameLandingRuntimeQuoteResult[]>,
  safeBlockNumber: number,
): FameLandingFieldState<FameLandingQuoteValue> {
  if (draft.field.status === "unavailable" || !draft.runtimeValidation) {
    return draft.field;
  }
  if (runtimeQuoteResult.status === "unavailable") {
    return unavailable(runtimeQuoteResult.reason);
  }
  const expected = draft.runtimeValidation;
  const matches = runtimeQuoteResult.value.filter(
    ({ quoteDefinitionId }) =>
      quoteDefinitionId === expected.request.quoteDefinitionId,
  );
  const actual = matches[0];
  if (matches.length !== 1 || !actual || actual.status === "unavailable") {
    return unavailable("dependency-unavailable");
  }
  if (
    actual.blockNumber !== BigInt(safeBlockNumber) ||
    actual.amountOut !== expected.expectedAmountOut
  ) {
    return unavailable("runtime-quote-mismatch");
  }
  return draft.field;
}

function liquidityField({
  reserveResult,
  concentratedResult,
  safeBlockNumber,
  authority,
}: {
  reserveResult: LeafResult<readonly FamePoolLatestState[]>;
  concentratedResult: LeafResult<FameLandingConcentratedPoolBalances>;
  safeBlockNumber: number;
  authority: FameLandingAuthority;
}): FameLandingSnapshot["fields"]["liquidity"] {
  if (reserveResult.status === "unavailable")
    return unavailable(reserveResult.reason);
  if (concentratedResult.status === "unavailable") {
    return unavailable(concentratedResult.reason);
  }
  const statesByPoolId = new Map(
    reserveResult.value.map((state) => [state.poolId, state]),
  );
  let fameAmount = 0n;
  const counters = new Map(
    authority.counterAssets.map(({ address }) => [address.toLowerCase(), 0n]),
  );
  for (const poolId of authority.directLiquidityPoolIds) {
    const pool = poolById(poolId);
    if (!pool) return unavailable("invalid-pool-state");
    const fameIsToken0 =
      pool.token0.toLowerCase() === authority.fameToken.toLowerCase();
    const counter = fameIsToken0 ? pool.token1 : pool.token0;
    if (pool.stateSurface === "constant-product-reserves") {
      const captured = capturedReserveState(
        poolId,
        statesByPoolId,
        safeBlockNumber,
        authority,
      );
      if (!captured) return unavailable("invalid-pool-state");
      fameAmount += fameIsToken0 ? captured.reserve0 : captured.reserve1;
      counters.set(
        counter.toLowerCase(),
        (counters.get(counter.toLowerCase()) ?? 0n) +
          (fameIsToken0 ? captured.reserve1 : captured.reserve0),
      );
      continue;
    }
    if (
      pool.id !== concentratedResult.value.poolId ||
      !pool.poolAddress ||
      pool.venue !== "aerodrome-slipstream"
    ) {
      return unavailable("invalid-pool-state");
    }
    const fameBalance =
      concentratedResult.value.balances[authority.fameToken.toLowerCase()];
    const counterBalance =
      concentratedResult.value.balances[counter.toLowerCase()];
    if (fameBalance === undefined || counterBalance === undefined) {
      return unavailable("invalid-pool-state");
    }
    fameAmount += fameBalance;
    counters.set(
      counter.toLowerCase(),
      (counters.get(counter.toLowerCase()) ?? 0n) + counterBalance,
    );
  }
  return {
    status: "available",
    value: {
      fameAmount: fameAmount.toString(),
      counterAssets: authority.counterAssets.map((asset) => ({
        ...asset,
        amount: (counters.get(asset.address.toLowerCase()) ?? 0n).toString(),
      })),
    },
  };
}

function definitionByField(
  field: FameLandingQuoteField,
  authority: FameLandingAuthority,
): FameLandingQuoteDefinition {
  const index = FAME_LANDING_QUOTE_FIELDS.indexOf(field);
  const result = authority.quoteDefinitions[index];
  if (!result)
    throw new Error(`Missing landing quote definition for ${field}.`);
  return result;
}

export async function produceFameLandingSnapshot({
  chainId,
  safeBlockNumber,
  safeBlockHash,
  capturedAt,
  deps,
  previousSnapshot = null,
  authority = fameLandingAuthority,
  leafTimeoutMs = FAME_LANDING_SNAPSHOT_LEAF_TIMEOUT_MS,
}: {
  chainId: number;
  safeBlockNumber: number;
  safeBlockHash: Hex;
  capturedAt: Date;
  deps: FameLandingSnapshotProducerDependencies;
  previousSnapshot?: FameLandingSnapshot | null;
  authority?: FameLandingAuthority;
  leafTimeoutMs?: number;
}): Promise<FameLandingSnapshot> {
  if (chainId !== 8453) throw new Error("FAME landing snapshots require Base.");
  if (!Number.isSafeInteger(safeBlockNumber) || safeBlockNumber < 0) {
    throw new Error("safeBlockNumber must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(leafTimeoutMs) || leafTimeoutMs <= 0) {
    throw new Error("leafTimeoutMs must be a positive safe integer.");
  }
  const capturedAtIso = capturedAt.toISOString();
  const reservePoolIds = [
    ...new Set([
      ...authority.directLiquidityPoolIds,
      ...authority.capabilities.flatMap((capability) =>
        capability.status === "enabled" &&
        capability.evaluator === "constant-product-captured-reserves-v1"
          ? capability.routeTemplates.flatMap(({ allocations }) =>
              allocations.map(({ poolId }) => poolId),
            )
          : [],
      ),
    ]),
  ].filter(
    (poolId) => poolById(poolId)?.stateSurface === "constant-product-reserves",
  );
  const concentratedPool = authority.directLiquidityPoolIds
    .map(poolById)
    .find((pool) => pool?.venue === "aerodrome-slipstream");
  if (!concentratedPool?.poolAddress) {
    throw new Error("Landing authority requires one concentrated direct pool.");
  }
  const runtimePools = [
    ...new Set(
      authority.capabilities.flatMap((capability) =>
        capability.status === "enabled" &&
        capability.evaluator === "constant-product-runtime-validated-v1"
          ? capability.routeTemplates.flatMap(({ legs }) => legs)
          : [],
      ),
    ),
  ]
    .map((poolId) => poolById(poolId))
    .filter(
      (pool): pool is FamePoolStateRegistryEntry & { poolAddress: Address } =>
        pool?.capability === "tracked-only" && pool.poolAddress !== null,
    )
    .map(({ id: poolId, poolAddress }) => ({ poolId, poolAddress }));
  const marketplaceResultPromise = settleLeaf(
    () => deps.readMarketplace({ blockNumber: BigInt(safeBlockNumber) }),
    leafTimeoutMs,
  );
  const reserveResultPromise = settleLeaf(
    () => deps.readReserveStates({ poolIds: reservePoolIds }),
    leafTimeoutMs,
  );
  const concentratedResultPromise = settleLeaf(
    () =>
      deps.readConcentratedPoolBalances({
        blockNumber: BigInt(safeBlockNumber),
        poolId: concentratedPool.id,
        poolAddress: concentratedPool.poolAddress as Address,
        tokenAddresses: [concentratedPool.token0, concentratedPool.token1],
      }),
    leafTimeoutMs,
  );
  const runtimeReserveResultPromise = settleLeaf(
    () =>
      deps.readRuntimePoolReserves({
        blockNumber: BigInt(safeBlockNumber),
        pools: runtimePools,
      }),
    leafTimeoutMs,
  );
  const [
    marketplaceResult,
    reserveResult,
    concentratedResult,
    runtimeReserveResult,
  ] = await Promise.all([
    marketplaceResultPromise,
    reserveResultPromise,
    concentratedResultPromise,
    runtimeReserveResultPromise,
  ]);
  const marketplace = marketplaceField(marketplaceResult);
  const quoteDrafts = Object.fromEntries(
    FAME_LANDING_QUOTE_FIELDS.map((field) => {
      const definition = definitionByField(field, authority);
      const capability = authority.capabilities.find(
        ({ quoteDefinitionId }) => quoteDefinitionId === definition.id,
      );
      if (!capability)
        throw new Error(`Missing capability for ${definition.id}.`);
      return [
        field,
        quoteFieldDraft({
          field,
          definition,
          capability,
          reserveResult,
          runtimeReserveResult,
          marketplace,
          safeBlockNumber,
          authority,
          previousSnapshot,
        }),
      ];
    }),
  ) as Record<FameLandingQuoteField, FameLandingQuoteDraft>;
  const runtimeQuoteRequests = Object.values(quoteDrafts).flatMap(
    ({ runtimeValidation }) =>
      runtimeValidation ? [runtimeValidation.request] : [],
  );
  const runtimeQuoteResult = await settleLeaf(
    () =>
      runtimeQuoteRequests.length === 0
        ? Promise.resolve([])
        : deps.readRuntimePoolQuotes({
            blockNumber: BigInt(safeBlockNumber),
            requests: runtimeQuoteRequests,
          }),
    leafTimeoutMs,
  );
  const quotes = Object.fromEntries(
    FAME_LANDING_QUOTE_FIELDS.map((field) => [
      field,
      finalizeQuoteDraft(
        quoteDrafts[field],
        runtimeQuoteResult,
        safeBlockNumber,
      ),
    ]),
  ) as FameLandingSnapshot["fields"]["quotes"];
  const snapshot: FameLandingSnapshot = {
    schemaVersion: "fame-landing-defi-snapshot-v1",
    provenance: {
      chainId: 8453,
      safeBlockNumber,
      safeBlockHash,
      capturedAt: capturedAtIso,
      sourceRegistryId: authority.sourceRegistryId,
      routeAuthorityRevision: authority.routeAuthorityRevision,
      snapshotId: fameLandingSnapshotId(
        safeBlockNumber,
        safeBlockHash,
        capturedAtIso,
      ),
    },
    fields: {
      marketplace,
      quotes,
      liquidity: liquidityField({
        reserveResult,
        concentratedResult,
        safeBlockNumber,
        authority,
      }),
    },
  };
  return parseFameLandingSnapshot(snapshot, authority);
}
