import {
  fraction,
  add,
  multiply,
  decimal,
  type Fraction,
} from "./price-math.ts";
import { extend, type SpotRange } from "./spot-candles.ts";
import type { PoolActivity } from "./sampled-market.ts";
export interface BlendInput {
  poolId: string;
  /** FAME atoms; identical token decimals across every pool. */
  weight: bigint | null;
  opening: Fraction | null;
  closing: Fraction | null;
  conversion: Fraction | null;
  activity: PoolActivity | undefined;
}
/** Fixed opening inventory weights and closing FX. Never average independent extrema. */
export function blendedMarket(inputs: BlendInput[], timestamp: number) {
  const missingPoolIds = inputs
    .filter(
      (p) =>
        p.weight === null ||
        p.weight! < 0n ||
        (p.weight! > 0n && (!p.closing || !p.conversion)),
    )
    .map((p) => p.poolId);
  const total = inputs.reduce((n, p) => n + (p.weight ?? 0n), 0n);
  const eligible = inputs.filter((p) => p.weight !== null && p.weight > 0n);
  const metadata = {
    method: "fame-balance-weighted-spot-v1" as const,
    weightTimestamp: timestamp - 300,
    weights: inputs.map((p) => ({
      poolId: p.poolId,
      fameBalanceAtoms: p.weight?.toString() ?? null,
    })),
    missingPoolIds,
  };
  if (missingPoolIds.length || total <= 0n)
    return {
      ...metadata,
      price: null,
      candle: null,
      coverage: "unavailable" as const,
    };
  const average = (prices: Map<string, Fraction>) => {
    let sum = fraction(0n, 1n);
    for (const p of eligible)
      sum = add(
        sum,
        multiply(
          multiply(prices.get(p.poolId)!, p.conversion!),
          fraction(p.weight!, total),
        ),
      );
    return sum;
  };
  const closing = new Map(eligible.map((p) => [p.poolId, p.closing!]));
  const close = average(closing),
    price = decimal(close);
  const usable = eligible.every(
    (p) =>
      p.opening &&
      p.activity?.coverage === "complete" &&
      !p.activity.spotInvalid &&
      (p.activity.spotEvents?.length ?? 0) >= (p.activity.spot?.count ?? 0) &&
      (p.activity.spotEvents?.length ?? 0) >= p.activity.tradeCount,
  );
  if (!usable)
    return {
      ...metadata,
      price,
      candle: null,
      coverage: "price-only" as const,
    };
  const state = new Map(eligible.map((p) => [p.poolId, p.opening!]));
  const events = eligible
    .flatMap((p) =>
      (p.activity!.spotEvents ?? []).map((e) => ({ ...e, poolId: p.poolId })),
    )
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  let range: SpotRange = extend(undefined, average(state));
  let lastPosition = "";
  for (const e of events) {
    const position = `${e.blockNumber}:${e.logIndex}`;
    if (position === lastPosition)
      throw new Error("Duplicate blended price event position");
    lastPosition = position;
    state.set(e.poolId, e.price);
    range = extend(range, average(state));
  }
  // All boundary snapshots describe one block. Apply their closing marks together.
  range = events.length ? extend(range, close) : extend(undefined, close);
  return {
    ...metadata,
    price,
    coverage: "complete" as const,
    candle: {
      open: decimal(range.open),
      high: decimal(range.high),
      low: decimal(range.low),
      close: price,
      coverage: events.length
        ? ("complete" as const)
        : ("reference-only" as const),
    },
  };
}
