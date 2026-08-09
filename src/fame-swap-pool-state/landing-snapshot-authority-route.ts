import type { Address } from "viem";
import type { FamePoolStateRegistryEntry } from "./types.ts";

export interface FameLandingCapturedRouteTemplate {
  id: string;
  allocations: {
    poolId: string;
    allocationBps: number;
  }[];
}

export interface FameLandingRuntimeRouteTemplate {
  id: string;
  legs: string[];
}

export interface RuntimeRouteTemplateFailure {
  path: string;
  message: string;
}

export function directFamePool(
  pool: FamePoolStateRegistryEntry,
  fame: Address,
): boolean {
  const normalized = fame.toLowerCase();
  return (
    pool.token0.toLowerCase() === normalized ||
    pool.token1.toLowerCase() === normalized
  );
}

export function hasUniqueRouteTemplates<T extends { id: string }>(
  routeTemplates: T[],
): boolean {
  return (
    routeTemplates.length > 0 &&
    new Set(routeTemplates.map(({ id }) => id)).size === routeTemplates.length
  );
}

export function validateRuntimeRouteTemplate({
  id,
  legs,
  path,
  registryById,
  fameToken,
  assetAddress,
  mode,
}: {
  id: string;
  legs: string[];
  path: string;
  registryById: Map<string, FamePoolStateRegistryEntry>;
  fameToken: Address;
  assetAddress: Address;
  mode: "exactInput" | "exactTarget";
}): RuntimeRouteTemplateFailure | null {
  if (
    legs.length < 2 ||
    new Set(legs).size !== legs.length ||
    id !== `solver-single_path-${legs.join("--")}`
  ) {
    return {
      path,
      message:
        "runtime route must be a unique fixed single path with its canonical id",
    };
  }

  let currentToken = mode === "exactInput" ? fameToken : assetAddress;
  const expectedToken = mode === "exactInput" ? assetAddress : fameToken;
  let runtimePoolCount = 0;
  for (let index = 0; index < legs.length; index += 1) {
    const legPath = `${path}.legs[${index.toString()}]`;
    const pool = registryById.get(legs[index] ?? "");
    if (
      !pool?.poolAddress ||
      pool.fee.status !== "available" ||
      pool.stable !== false
    ) {
      return {
        path: legPath,
        message: "pool is not supported by the runtime evaluator",
      };
    }
    const current = currentToken.toLowerCase();
    if (pool.token0.toLowerCase() === current) {
      currentToken = pool.token1;
    } else if (pool.token1.toLowerCase() === current) {
      currentToken = pool.token0;
    } else {
      return {
        path: legPath,
        message: "pool does not continue the fixed route topology",
      };
    }

    const indexed =
      pool.capability === "quote-model" &&
      pool.stateSurface === "constant-product-reserves" &&
      pool.quoteModel === "constant-product-reserves";
    const runtime =
      pool.capability === "tracked-only" &&
      pool.stateSurface === null &&
      pool.quoteModel === null &&
      (pool.venue === "solidly" || pool.venue === "aerodrome-v2");
    if (!indexed && !runtime) {
      return {
        path: legPath,
        message: "pool has no approved local/runtime evaluator",
      };
    }
    if (runtime) runtimePoolCount += 1;
  }
  if (
    currentToken.toLowerCase() !== expectedToken.toLowerCase() ||
    runtimePoolCount !== 1
  ) {
    return {
      path,
      message:
        "runtime route must reach the quote asset through exactly one runtime pool",
    };
  }
  return null;
}
