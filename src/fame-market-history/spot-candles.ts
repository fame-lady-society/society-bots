import type { DecodedEvent, TokenMetadata } from "./decode.ts";
import { FAME_ADDRESS, type Pool, type Scope } from "./model.ts";
import { fraction, invert, type Fraction } from "./sampled-market.ts";
export interface SpotRange {
  open: Fraction;
  high: Fraction;
  low: Fraction;
  close: Fraction;
  count: number;
}
export function compare(a: Fraction, b: Fraction) {
  const d =
    BigInt(a.numerator) * BigInt(b.denominator) -
    BigInt(b.numerator) * BigInt(a.denominator);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}
export function extend(
  range: SpotRange | undefined,
  value: Fraction,
): SpotRange {
  if (!range)
    return { open: value, high: value, low: value, close: value, count: 1 };
  return {
    ...range,
    high: compare(value, range.high) > 0 ? value : range.high,
    low: compare(value, range.low) < 0 ? value : range.low,
    close: value,
    count: range.count + 1,
  };
}
/** undefined = not a spot observation; null = observed unusable pool state. */
export function eventSpot(
  scope: Scope,
  pool: Pool,
  event: DecodedEvent,
  metadata: TokenMetadata,
): Fraction | null | undefined {
  const a = event.args,
    d0 = metadata.decimals[pool.token0],
    d1 = metadata.decimals[pool.token1];
  let rate: Fraction;
  if (
    ["UniswapV2", "Solidly"].includes(pool.venueFamily) &&
    event.eventName === "Sync"
  ) {
    const x = BigInt(a.reserve0) * 10n ** BigInt(d1),
      y = BigInt(a.reserve1) * 10n ** BigInt(d0);
    if (x <= 0n || y <= 0n) return null;
    rate = scope.registry.pools.find((p) => p.id === pool.id)!.stable
      ? fraction(y * (3n * x * x + y * y), x * (x * x + 3n * y * y))
      : fraction(y, x);
  } else if (
    pool.venueFamily === "Slipstream" &&
    ["Swap", "Initialize"].includes(event.eventName ?? "")
  ) {
    const sqrt = BigInt(a.sqrtPriceX96);
    if (sqrt <= 0n || (event.eventName === "Swap" && BigInt(a.liquidity) <= 0n))
      return null;
    rate = fraction(
      sqrt * sqrt * 10n ** BigInt(d0),
      2n ** 192n * 10n ** BigInt(d1),
    );
  } else return undefined;
  return pool.token0 === FAME_ADDRESS ? rate : invert(rate);
}
