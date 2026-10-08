import type { NativeActivityEvent } from "./activity-events.ts";
import {
  parse,
  fraction,
  multiply,
  invert,
  decimal,
  add,
  type Fraction,
} from "./price-math.ts";
import { blendedMarket } from "./market-blend.ts";
import { extend, type SpotRange } from "./spot-candles.ts";
import type { Scope, Header } from "./model.ts";
import { FAME_ADDRESS, digest, integer, hash } from "./model.ts";
import { ROUTES, WETH } from "./valuation.ts";
import { USDC } from "./reference.ts";

export type Currency = "ETH" | "USDC";
export type Availability = "complete" | "partial" | "unavailable";
export {
  fraction,
  multiply,
  invert,
  decimal,
  type Fraction,
} from "./price-math.ts";
const one: Fraction = { numerator: "1", denominator: "1" };
const ethUsdcPool = "uniswap-v3-usdc-weth-5bps";
export function sampledPolicy(scope: Scope) {
  const routes: Record<string, Record<Currency, string[]>> = {};
  for (const direct of scope.pools) {
    const token =
      direct.token0 === FAME_ADDRESS ? direct.token1 : direct.token0;
    let eth: string[];
    if (token === USDC) eth = [ethUsdcPool];
    else {
      const known = ROUTES[token];
      if (!known) throw new Error(`Unreviewed quote token for ${direct.id}`);
      eth = [...known];
    }
    // USDC paths stop at USDC, avoiding USDC -> WETH -> USDC round trips.
    const usdc =
      token === USDC
        ? []
        : eth.at(-1) === ethUsdcPool
          ? eth.slice(0, -1)
          : [...eth, ethUsdcPool];
    routes[direct.id] = { ETH: eth, USDC: usdc };
    for (const [currency, path] of Object.entries(routes[direct.id])) {
      let current: string = token;
      const visited = new Set([current]);
      if (path.length > 3 || new Set(path).size !== path.length)
        throw new Error("Invalid sampled route length/cycle");
      for (const id of path) {
        const p = scope.registry.pools.find((p) => p.id === id);
        if (
          !p ||
          p.chainId !== 8453 ||
          [p.token0, p.token1].includes(FAME_ADDRESS) ||
          ![p.token0, p.token1].includes(current as typeof p.token0)
        )
          throw new Error("Disconnected or circular sampled route");
        current = p.token0 === current ? p.token1 : p.token0;
        if (visited.has(current)) throw new Error("Cyclic sampled route");
        visited.add(current);
      }
      if (current !== (currency === "ETH" ? WETH : USDC))
        throw new Error("Wrong sampled route destination");
    }
  }
  const sourceIds = [
    ...new Set([
      ...scope.pools.map((p) => p.id),
      ...Object.values(routes).flatMap((r) => [...r.ETH, ...r.USDC]),
    ]),
  ].sort();
  const sources = sourceIds.map((id) => {
    const pool = scope.registry.pools.find((p) => p.id === id);
    if (!pool) throw new Error("Missing sampled source");
    return pool;
  });
  const revision = digest(
    JSON.stringify({ method: "bucket-end-spot-v1", sources, routes }),
  );
  return { revision, routes, sources };
}
export interface SampledObservation {
  version: "fame-market-observation-v1";
  policyRevision: string;
  timestamp: number;
  block: Header;
  after: Header;
  /** Whole token1 units per whole token0 unit, independently of balances. */
  rates: Record<string, Fraction | null>;
  balances: Record<string, { balance0: string; balance1: string } | null>;
  decimals: Record<string, number>;
}
export function conversionFor(
  policy: ReturnType<typeof sampledPolicy>,
  pool: Scope["pools"][number],
  currency: Currency,
  observation: SampledObservation | null,
): Fraction | null {
  const quote = pool.token0 === FAME_ADDRESS ? pool.token1 : pool.token0;
  let current: string = quote;
  let conversion: Fraction | null = one;
  for (const id of policy.routes[pool.id][currency]) {
    const p = policy.sources.find((p) => p.id === id)!;
    const r = observation?.rates[id];
    if (!r) {
      conversion = null;
      break;
    }
    conversion = multiply(conversion, p.token0 === current ? r : invert(r));
    current = p.token0 === current ? p.token1 : p.token0;
  }
  return conversion;
}
export interface PoolActivity {
  poolId: string;
  coverage: "complete" | "partial" | "missing";
  baseVolumeAtoms: string;
  quoteVolumeAtoms: string;
  tradeCount: number;
  transactionHashes: string[];
  spot?: SpotRange;
  spotInvalid?: boolean;
  activityEvents?: NativeActivityEvent[];
  spotEvents?: { blockNumber: number; logIndex: number; price: Fraction }[];
}
function atoms(value: string, decimals: number) {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Invalid atom quantity");
  integer(decimals, "token decimals");
  if (decimals > 36) throw new Error("Unsupported token decimals");
  return fraction(BigInt(value), 10n ** BigInt(decimals));
}
export function sampledMarketBucket(
  scope: Scope,
  currency: Currency,
  timestamp: number,
  observation: SampledObservation | null,
  activities: PoolActivity[],
  previous: SampledObservation | null = null,
) {
  if (currency !== "ETH" && currency !== "USDC")
    throw new Error("Invalid currency");
  integer(timestamp, "bucket timestamp");
  if (timestamp % 300) throw new Error("Unaligned sampled bucket");
  const policy = sampledPolicy(scope);
  if (observation) {
    const o = observation;
    for (const h of [o.block, o.after]) {
      integer(h.number, "block number");
      integer(h.timestamp, "block timestamp");
      hash(h.hash);
      hash(h.parentHash);
    }
    if (
      o.version !== "fame-market-observation-v1" ||
      o.policyRevision !== policy.revision ||
      o.timestamp !== timestamp ||
      o.block.timestamp >= timestamp + 300 ||
      o.after.timestamp < timestamp + 300 ||
      o.after.number !== o.block.number + 1 ||
      o.after.parentHash !== o.block.hash
    )
      throw new Error("Invalid sampled boundary or policy");
    for (const r of Object.values(o.rates))
      if (r && parse(r)[0] === 0n) throw new Error("Nonpositive sampled price");
  }
  if (
    previous &&
    (previous.policyRevision !== policy.revision ||
      previous.timestamp !== timestamp - 300 ||
      previous.block.timestamp >= timestamp ||
      previous.after.timestamp < timestamp ||
      (observation && previous.block.number > observation.block.number))
  )
    throw new Error("Invalid candle opening observation");
  if (
    new Set(activities.map((a) => a.poolId)).size !== activities.length ||
    activities.some((a) => !scope.pools.some((p) => p.id === a.poolId))
  )
    throw new Error("Duplicate or unknown activity pool");
  const metric = (values: (Fraction | null)[], complete: boolean) => ({
    status: (complete && values.every((v) => v !== null)
      ? "complete"
      : values.some((v) => v !== null)
        ? "partial"
        : "unavailable") as Availability,
    value: values.some((v) => v !== null)
      ? decimal(
          values.reduce<Fraction>(
            (sum, v) => (v ? add(sum, v) : sum),
            fraction(0n, 1n),
          ),
        )
      : null,
  });
  const rows = scope.pools.map((pool) => {
    const a = activities.find((a) => a.poolId === pool.id);
    if (a) {
      if (!["complete", "partial", "missing"].includes(a.coverage))
        throw new Error("Invalid coverage");
      atoms(a.baseVolumeAtoms, 0);
      atoms(a.quoteVolumeAtoms, 0);
      integer(a.tradeCount, "trade count");
      a.transactionHashes.forEach(hash);
      if (
        new Set(a.transactionHashes).size !== a.transactionHashes.length ||
        a.transactionHashes.length > a.tradeCount ||
        (a.tradeCount > 0 && !a.transactionHashes.length)
      )
        throw new Error("Invalid transaction counts");
      if (
        a.coverage === "missing" &&
        (a.tradeCount ||
          a.baseVolumeAtoms !== "0" ||
          a.quoteVolumeAtoms !== "0")
      )
        throw new Error("Missing coverage cannot contain activity");
    }
    const quote = pool.token0 === FAME_ADDRESS ? pool.token1 : pool.token0;
    const conversion = conversionFor(policy, pool, currency, observation);
    const r = observation?.rates[pool.id];
    const mark = r ? (pool.token0 === FAME_ADDRESS ? r : invert(r)) : null;
    const price = mark && conversion ? multiply(mark, conversion) : null;
    const amount = a && a.coverage !== "missing" ? a : null;
    const qd = observation?.decimals[quote];
    // Identity routes still need reviewed quote decimals; ETH and USDC are fixed.
    const quoteDecimals =
      qd ?? (quote === WETH ? 18 : quote === USDC ? 6 : undefined);
    const volume =
      amount && conversion && quoteDecimals !== undefined
        ? multiply(atoms(amount.quoteVolumeAtoms, quoteDecimals), conversion)
        : null;
    let candle: {
      open: string;
      high: string;
      low: string;
      close: string;
      coverage: "complete" | "partial" | "reference-only";
    } | null = null;
    if (a?.coverage === "complete" && !a.spotInvalid && mark && conversion) {
      if (!a.spot && a.tradeCount === 0) {
        const value = decimal(multiply(mark, conversion));
        candle = {
          open: value,
          high: value,
          low: value,
          close: value,
          coverage: "reference-only",
        };
      } else if (a.spot && a.spot.count >= a.tradeCount) {
        const before = previous?.rates[pool.id];
        const opening = before
          ? pool.token0 === FAME_ADDRESS
            ? before
            : invert(before)
          : null;
        let range = a.spot;
        if (opening) {
          range = extend(
            extend(extend(extend(undefined, opening), a.spot.high), a.spot.low),
            a.spot.close,
          );
          range.open = opening;
        }
        range = extend(range, mark);
        candle = {
          open: decimal(multiply(range.open, conversion)),
          high: decimal(multiply(range.high, conversion)),
          low: decimal(multiply(range.low, conversion)),
          close: decimal(multiply(range.close, conversion)),
          coverage: opening ? "complete" : "partial",
        };
      }
    }
    const b = observation?.balances[pool.id];
    const fd = observation?.decimals[FAME_ADDRESS];
    const inventory =
      b &&
      price &&
      conversion &&
      fd !== undefined &&
      quoteDecimals !== undefined
        ? add(
            multiply(
              atoms(pool.token0 === FAME_ADDRESS ? b.balance0 : b.balance1, fd),
              price,
            ),
            multiply(
              atoms(
                pool.token0 === FAME_ADDRESS ? b.balance1 : b.balance0,
                quoteDecimals,
              ),
              conversion,
            ),
          )
        : null;
    return {
      poolId: pool.id,
      route: policy.routes[pool.id][currency],
      eventCoverage: a?.coverage ?? "missing",
      candle,
      price,
      volume,
      inventory,
      baseVolumeAtoms: amount?.baseVolumeAtoms ?? null,
      quoteVolumeAtoms: amount?.quoteVolumeAtoms ?? null,
      tradeCount: amount?.tradeCount ?? null,
      transactionHashes: amount?.transactionHashes ?? [],
      blendInput: {
        poolId: pool.id,
        weight: previous?.balances[pool.id]
          ? BigInt(
              pool.token0 === FAME_ADDRESS
                ? previous.balances[pool.id]!.balance0
                : previous.balances[pool.id]!.balance1,
            )
          : null,
        opening: previous?.rates[pool.id]
          ? pool.token0 === FAME_ADDRESS
            ? previous.rates[pool.id]!
            : invert(previous.rates[pool.id]!)
          : null,
        closing: mark,
        conversion,
        activity: a,
      },
    };
  });
  const complete = rows.every((r) => r.eventCoverage === "complete");
  return {
    version: "fame-market-api-v2" as const,
    currency,
    timestamp,
    resolution: 300,
    policyRevision: policy.revision,
    priceMethod: "bucket-end-spot" as const,
    candleMethod: "pool-spot-events-at-bucket-end-rate" as const,
    conversionMethod: "bucket-end-spot" as const,
    samplingIntervalSeconds: 300,
    observation: observation
      ? { block: observation.block, after: observation.after }
      : null,
    market: blendedMarket(
      rows.map((r) => r.blendInput),
      timestamp,
    ),
    series: rows.map(
      ({ transactionHashes: _transactions, blendInput: _blend, ...r }) => ({
        ...r,
        price: r.price ? decimal(r.price) : null,
        volume: r.volume ? decimal(r.volume) : null,
        inventory: r.inventory ? decimal(r.inventory) : null,
      }),
    ),
    totals: {
      eventCoverage: complete
        ? "complete"
        : rows.some((r) => r.eventCoverage !== "missing")
          ? "partial"
          : "missing",
      baseVolumeAtoms: rows.some((r) => r.baseVolumeAtoms !== null)
        ? String(
            rows.reduce((n, r) => n + BigInt(r.baseVolumeAtoms ?? "0"), 0n),
          )
        : null,
      volume: metric(
        rows.map((r) => r.volume),
        complete,
      ),
      inventory: {
        ...metric(
          rows.map((r) => r.inventory),
          true,
        ),
        method: "pool-held-inventory-at-spot",
      },
      tradeCount: rows.some((r) => r.tradeCount !== null)
        ? rows.reduce((n, r) => n + (r.tradeCount ?? 0), 0)
        : null,
      distinctTransactionCount: rows.some((r) => r.tradeCount !== null)
        ? new Set(rows.flatMap((r) => r.transactionHashes)).size
        : null,
      unpricedPoolIds: rows
        .filter((r) => r.volume === null)
        .map((r) => r.poolId),
      excludedInventoryPoolIds: rows
        .filter((r) => r.inventory === null)
        .map((r) => r.poolId),
    },
  };
}
