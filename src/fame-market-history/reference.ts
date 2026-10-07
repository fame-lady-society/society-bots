import {
  digest,
  hash,
  integer,
  record,
  type Header,
  type Scope,
} from "./model.ts";
import {
  decimal18,
  ETH_USD_FEED,
  MAX_OBSERVATION_AGE,
  WETH,
} from "./valuation.ts";

export const REFERENCE_VERSION = "fame-reference-v1";
export const FAME_REFERENCE_POOL = "scale-equalizer-weth-fame";
export const ETH_REFERENCE_POOL = "uniswap-v3-usdc-weth-5bps";
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const REFERENCE_FIELDS = [
  "fameEth",
  "ethUsd",
  "ethUsdc",
  "fameUsd",
  "fameUsdc",
] as const;
export type ReferenceReason =
  | "before-reference-start"
  | "not-yet-published"
  | "stale-source"
  | "source-unavailable";
export interface ReferenceValue {
  value: string | null;
  status: "available" | "unavailable";
  reason: ReferenceReason | null;
}
export interface ReferencePoint {
  method: "designated-pool-spot-with-asof-fx";
  policyRevision: string | null;
  sampledBlock: number | null;
  sampledBlockHash: string | null;
  sampledAt: number | null;
  oracle: { roundId: string; updatedAt: number } | null;
  values: Record<(typeof REFERENCE_FIELDS)[number], ReferenceValue>;
}
export interface ReferencePolicy {
  version: typeof REFERENCE_VERSION;
  revision: string;
  famePoolId: string;
  ethPoolId: string;
  famePoolAddress: string;
  ethPoolAddress: string;
  ethUsdFeed: string;
  maxAgeSeconds: number;
}
export function referencePolicy(scope: Scope): ReferencePolicy {
  const pools = [FAME_REFERENCE_POOL, ETH_REFERENCE_POOL].map((id) => {
    const pool = scope.registry.pools.find((p) => p.id === id);
    if (!pool?.poolAddress) throw new Error("Missing reference pool");
    return pool;
  });
  return {
    version: REFERENCE_VERSION,
    revision: digest(
      JSON.stringify({
        version: REFERENCE_VERSION,
        pools,
        ethUsdFeed: ETH_USD_FEED,
        maxAge: MAX_OBSERVATION_AGE,
      }),
    ),
    famePoolId: FAME_REFERENCE_POOL,
    ethPoolId: ETH_REFERENCE_POOL,
    famePoolAddress: pools[0].poolAddress!,
    ethPoolAddress: pools[1].poolAddress!,
    ethUsdFeed: ETH_USD_FEED,
    maxAgeSeconds: MAX_OBSERVATION_AGE,
  };
}
export interface ReferenceEvidence {
  version: typeof REFERENCE_VERSION;
  scopeId: string;
  policy: ReferencePolicy;
  policyRevision: string;
  timestamp: number;
  block: Header;
  after: Header;
  // Exact ABI bytes retain all source fields for independent recomputation.
  results: { success: boolean; returnData: `0x${string}` }[];
}
export interface ReferenceProgress {
  startTimestamp: number;
  nextTimestamp: number;
  policyRevision: string;
}
export const referenceProgressKey = (
  scopeId: string,
  stage: "collected" | "published",
) => ({ pk: `reference:${scopeId}`, sk: stage });
export const referenceKey = (scopeId: string, timestamp: number) => ({
  pk: `reference-prices:${scopeId}`,
  sk: String(timestamp).padStart(16, "0"),
});
export const referenceManifestKey = (scopeId: string, timestamp: number) => ({
  pk: `reference-raw:${scopeId}`,
  sk: String(timestamp).padStart(16, "0"),
});
export function referenceProgress(
  value: unknown,
  revision: string,
): ReferenceProgress | undefined {
  if (value === undefined) return undefined;
  const r = record(value);
  const startTimestamp = integer(r.startTimestamp, "reference start", 1);
  const nextTimestamp = integer(
    r.nextTimestamp,
    "reference next",
    startTimestamp,
  );
  if (
    startTimestamp % 300 ||
    nextTimestamp % 300 ||
    r.policyRevision !== revision
  )
    throw new Error("Reference progress mismatch");
  return { startTimestamp, nextTimestamp, policyRevision: revision };
}
export function unavailableReference(reason: ReferenceReason): ReferencePoint {
  return {
    method: "designated-pool-spot-with-asof-fx",
    policyRevision: null,
    sampledBlock: null,
    sampledBlockHash: null,
    sampledAt: null,
    oracle: null,
    values: Object.fromEntries(
      REFERENCE_FIELDS.map((k) => [
        k,
        { value: null, status: "unavailable", reason },
      ]),
    ) as ReferencePoint["values"],
  };
}
export function validateEvidence(e: ReferenceEvidence, scope: Scope) {
  if (
    e.version !== REFERENCE_VERSION ||
    e.scopeId !== scope.id ||
    JSON.stringify(e.policy) !== JSON.stringify(referencePolicy(scope)) ||
    e.policyRevision !== referencePolicy(scope).revision ||
    !Number.isSafeInteger(e.timestamp) ||
    e.timestamp <= 0 ||
    e.timestamp % 300
  )
    throw new Error("Reference evidence policy mismatch");
  for (const h of [e.block, e.after]) {
    integer(h.number, "reference block", 1);
    integer(h.timestamp, "reference time", 1);
    hash(h.hash);
    hash(h.parentHash);
  }
  if (
    e.after.number !== e.block.number + 1 ||
    e.after.parentHash !== e.block.hash ||
    e.block.timestamp >= e.timestamp + 300 ||
    e.after.timestamp < e.timestamp + 300 ||
    e.after.timestamp <= e.block.timestamp
  )
    throw new Error("Reference boundary mismatch");
  if (
    !Array.isArray(e.results) ||
    e.results.some(
      (r) =>
        typeof r.success !== "boolean" ||
        !/^0x(?:[a-fA-F0-9]{2})*$/.test(r.returnData),
    )
  )
    throw new Error("Invalid reference source results");
}
export function valueFromRate(
  rate: bigint | null,
  reason: ReferenceReason = "source-unavailable",
): ReferenceValue {
  return rate !== null && rate > 0n
    ? { value: decimal18(rate), status: "available", reason: null }
    : { value: null, status: "unavailable", reason };
}
/** Strict response allowlist: no archive keys or source ABI bytes escape. */
export function publicReference(
  value: unknown,
  revision: string,
): ReferencePoint {
  const r = record(value);
  if (
    r.method !== "designated-pool-spot-with-asof-fx" ||
    r.policyRevision !== revision
  )
    throw new Error("Reference row policy mismatch");
  const values = record(r.values);
  const clean = Object.fromEntries(
    REFERENCE_FIELDS.map((key) => {
      const v = record(values[key]);
      if (v.status === "available") {
        if (
          typeof v.value !== "string" ||
          !/^(0|[1-9]\d{0,59})\.\d{18}$/.test(v.value) ||
          BigInt(v.value.replace(".", "")) <= 0n ||
          v.reason !== null
        )
          throw new Error("Invalid reference price");
      } else if (
        v.status !== "unavailable" ||
        v.value !== null ||
        !["stale-source", "source-unavailable"].includes(String(v.reason))
      )
        throw new Error("Invalid unavailable reference");
      return [key, { value: v.value, status: v.status, reason: v.reason }];
    }),
  ) as ReferencePoint["values"];
  let oracle: ReferencePoint["oracle"] = null;
  if (r.oracle !== null) {
    const o = record(r.oracle);
    if (typeof o.roundId !== "string" || !/^\d{1,30}$/.test(o.roundId))
      throw new Error("Invalid oracle round");
    oracle = {
      roundId: o.roundId,
      updatedAt: integer(o.updatedAt, "oracle timestamp", 1),
    };
  }
  return {
    method: "designated-pool-spot-with-asof-fx",
    policyRevision: revision,
    sampledBlock: integer(r.sampledBlock, "reference block", 1),
    sampledBlockHash: hash(r.sampledBlockHash),
    sampledAt: integer(r.sampledAt, "reference timestamp", 1),
    oracle,
    values: clean,
  };
}
export { WETH };
