import type { Address } from "viem";
import type {
  FameLandingQuoteCapability,
  FameLandingQuoteDefinition,
} from "./landing-snapshot.ts";
import type { FamePoolStateRegistryEntry } from "./types.ts";

export type CapturedQuoteCapability = Extract<
  FameLandingQuoteCapability,
  { evaluator: "constant-product-captured-reserves-v1" }
>;
export type RuntimeQuoteCapability = Extract<
  FameLandingQuoteCapability,
  { evaluator: "constant-product-runtime-validated-v1" }
>;

export interface FameLandingRuntimeQuoteRequest {
  quoteDefinitionId: FameLandingQuoteDefinition["id"];
  poolId: string;
  poolAddress: Address;
  tokenIn: Address;
  amountIn: bigint;
}

export interface RuntimeQuoteValidation {
  request: FameLandingRuntimeQuoteRequest;
  expectedAmountOut: bigint;
}

export interface RouteQuote {
  amountOut: bigint;
  routeId: string;
  runtimeValidation: RuntimeQuoteValidation | null;
}

type RouteReserves = Map<
  string,
  { pool: FamePoolStateRegistryEntry; reserve0: bigint; reserve1: bigint }
>;

function constantProductAmountOut({
  amountIn,
  reserveIn,
  reserveOut,
  feeBps,
}: {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: number;
}): bigint | null {
  if (
    amountIn <= 0n ||
    reserveIn <= 0n ||
    reserveOut <= 0n ||
    !Number.isSafeInteger(feeBps) ||
    feeBps < 0 ||
    feeBps >= 10_000
  ) {
    return null;
  }
  const amountInWithFee = amountIn * BigInt(10_000 - feeBps);
  const denominator = reserveIn * 10_000n + amountInWithFee;
  if (denominator <= 0n) return null;
  const output = (amountInWithFee * reserveOut) / denominator;
  return output > 0n && output < reserveOut ? output : null;
}

function runtimeVolatileAmountOut({
  amountIn,
  reserveIn,
  reserveOut,
  feeBps,
}: {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: number;
}): bigint | null {
  if (
    amountIn <= 0n ||
    reserveIn <= 0n ||
    reserveOut <= 0n ||
    !Number.isSafeInteger(feeBps) ||
    feeBps < 0 ||
    feeBps >= 10_000
  ) {
    return null;
  }
  const fee = (amountIn * BigInt(feeBps)) / 10_000n;
  const netAmountIn = amountIn - fee;
  const output = (netAmountIn * reserveOut) / (reserveIn + netAmountIn);
  return output > 0n && output < reserveOut ? output : null;
}

export function quoteTemplate({
  template,
  amountIn,
  tokenIn,
  tokenOut,
  reserves,
}: {
  template: CapturedQuoteCapability["routeTemplates"][number];
  amountIn: bigint;
  tokenIn: Address;
  tokenOut: Address;
  reserves: RouteReserves;
}): RouteQuote | null {
  let allocated = 0n;
  let totalOutput = 0n;
  for (let index = 0; index < template.allocations.length; index += 1) {
    const allocation = template.allocations[index];
    if (!allocation) return null;
    const captured = reserves.get(allocation.poolId);
    if (!captured || captured.pool.fee.status !== "available") return null;
    const input =
      index === template.allocations.length - 1
        ? amountIn - allocated
        : (amountIn * BigInt(allocation.allocationBps)) / 10_000n;
    allocated += input;
    if (input === 0n) continue;
    const zeroForOne =
      captured.pool.token0.toLowerCase() === tokenIn.toLowerCase() &&
      captured.pool.token1.toLowerCase() === tokenOut.toLowerCase();
    const oneForZero =
      captured.pool.token1.toLowerCase() === tokenIn.toLowerCase() &&
      captured.pool.token0.toLowerCase() === tokenOut.toLowerCase();
    if (!zeroForOne && !oneForZero) return null;
    const output = constantProductAmountOut({
      amountIn: input,
      reserveIn: zeroForOne ? captured.reserve0 : captured.reserve1,
      reserveOut: zeroForOne ? captured.reserve1 : captured.reserve0,
      feeBps: captured.pool.fee.feeBps,
    });
    if (output === null) return null;
    totalOutput += output;
  }
  return totalOutput > 0n
    ? {
        amountOut: totalOutput,
        routeId: template.id,
        runtimeValidation: null,
      }
    : null;
}

function bestTemplateQuote<T>(
  templates: readonly T[],
  evaluate: (template: T) => RouteQuote | null,
): RouteQuote | null {
  let best: RouteQuote | null = null;
  for (const template of templates) {
    const candidate = evaluate(template);
    if (
      candidate &&
      (!best ||
        candidate.amountOut > best.amountOut ||
        (candidate.amountOut === best.amountOut &&
          candidate.routeId.localeCompare(best.routeId) < 0))
    ) {
      best = candidate;
    }
  }
  return best;
}

export function bestRouteQuote(options: {
  capability: CapturedQuoteCapability;
  amountIn: bigint;
  tokenIn: Address;
  tokenOut: Address;
  reserves: RouteReserves;
}): RouteQuote | null {
  return bestTemplateQuote(options.capability.routeTemplates, (template) =>
    quoteTemplate({ ...options, template }),
  );
}

export function quoteRuntimeTemplate({
  template,
  definition,
  amountIn,
  tokenIn,
  tokenOut,
  reserves,
}: {
  template: RuntimeQuoteCapability["routeTemplates"][number];
  definition: FameLandingQuoteDefinition;
  amountIn: bigint;
  tokenIn: Address;
  tokenOut: Address;
  reserves: RouteReserves;
}): RouteQuote | null {
  let currentToken = tokenIn;
  let currentAmount = amountIn;
  let runtimeValidation: RuntimeQuoteValidation | null = null;
  for (const poolId of template.legs) {
    const captured = reserves.get(poolId);
    if (
      !captured?.pool.poolAddress ||
      captured.pool.fee.status !== "available"
    ) {
      return null;
    }
    const zeroForOne =
      captured.pool.token0.toLowerCase() === currentToken.toLowerCase();
    const oneForZero =
      captured.pool.token1.toLowerCase() === currentToken.toLowerCase();
    if (!zeroForOne && !oneForZero) return null;
    const amountOut =
      captured.pool.capability === "tracked-only"
        ? runtimeVolatileAmountOut
        : constantProductAmountOut;
    const output = amountOut({
      amountIn: currentAmount,
      reserveIn: zeroForOne ? captured.reserve0 : captured.reserve1,
      reserveOut: zeroForOne ? captured.reserve1 : captured.reserve0,
      feeBps: captured.pool.fee.feeBps,
    });
    if (output === null) return null;
    if (captured.pool.capability === "tracked-only") {
      if (runtimeValidation) return null;
      runtimeValidation = {
        request: {
          quoteDefinitionId: definition.id,
          poolId,
          poolAddress: captured.pool.poolAddress,
          tokenIn: currentToken,
          amountIn: currentAmount,
        },
        expectedAmountOut: output,
      };
    }
    currentToken = zeroForOne ? captured.pool.token1 : captured.pool.token0;
    currentAmount = output;
  }
  return currentToken.toLowerCase() === tokenOut.toLowerCase() &&
    currentAmount > 0n &&
    runtimeValidation
    ? {
        amountOut: currentAmount,
        routeId: template.id,
        runtimeValidation,
      }
    : null;
}

export function bestRuntimeRouteQuote(options: {
  capability: RuntimeQuoteCapability;
  definition: FameLandingQuoteDefinition;
  amountIn: bigint;
  tokenIn: Address;
  tokenOut: Address;
  reserves: RouteReserves;
}): RouteQuote | null {
  return bestTemplateQuote(options.capability.routeTemplates, (template) =>
    quoteRuntimeTemplate({ ...options, template }),
  );
}
