import type { Candle } from "./analytics.ts";
import type { DecodedEvent, TokenMetadata } from "./decode.ts";
import { FAME_ADDRESS, type Scope } from "./model.ts";
import {
  valueBucket,
  decimal18,
  type ValuationSnapshot,
  type ConvertedCandle,
  type MarketLiquidity,
} from "./valuation.ts";

export const MARKET_VERSION = "fame-market-v1";
export interface QuoteCandle extends Omit<Candle, "poolId"> {
  quoteToken: string;
  quoteDecimals: number;
  poolIds: string[];
}
export interface MarketCandle {
  timestamp: number;
  coverage: Candle["coverage"];
  baseVolumeAtoms: string;
  tradeCount: number;
  rejectedEvents: number;
  expectedPoolIds: string[];
  pools: Candle[];
  quotes: QuoteCandle[];
  prices: ConvertedCandle[];
  liquidity: MarketLiquidity;
}
export const quoteToken = (pool: Scope["pools"][number]) =>
  pool.token0 === FAME_ADDRESS ? pool.token1 : pool.token0;
const sum = (values: string[]) =>
  values.reduce((n, value) => n + BigInt(value), 0n).toString();
const coverage = (rows: Candle[]): Candle["coverage"] =>
  rows.every((c) => c.coverage === "complete")
    ? "complete"
    : rows.every((c) => c.coverage === "missing")
      ? "missing"
      : "partial";
const price = (value: string) => decimal18(BigInt(value));

/** One pass over ordered executions. Pool OHLC cannot recover cross-pool order. */
export function marketCandles(
  scope: Scope,
  metadata: TokenMetadata,
  events: DecodedEvent[],
  candles: Candle[],
  snapshots: ValuationSnapshot[] = [],
): MarketCandle[] {
  const pools = new Map(scope.pools.map((p) => [p.id, p]));
  const quotes = [...new Set(scope.pools.map(quoteToken))].sort();
  const trades = new Map<
    string,
    { open: string; high: string; low: string; close: string }
  >();
  const bucketTrades = new Map<number, DecodedEvent[]>();
  for (const e of [...events].sort(
    (a, b) =>
      a.raw.blockNumber - b.raw.blockNumber ||
      a.raw.transactionIndex - b.raw.transactionIndex ||
      a.raw.logIndex - b.raw.logIndex,
  )) {
    if (e.classification !== "trade") continue;
    const time = Math.floor(e.raw.blockTimestamp / 300) * 300;
    const executions = bucketTrades.get(time) ?? [];
    executions.push(e);
    bucketTrades.set(time, executions);
    const token = quoteToken(pools.get(e.raw.poolId)!);
    const key = `${Math.floor(e.raw.blockTimestamp / 300) * 300}:${token}`;
    const p = e.priceX18!;
    const current = trades.get(key);
    if (!current) trades.set(key, { open: p, high: p, low: p, close: p });
    else {
      current.close = p;
      if (BigInt(p) > BigInt(current.high)) current.high = p;
      if (BigInt(p) < BigInt(current.low)) current.low = p;
    }
  }
  const buckets = new Map<number, Candle[]>();
  for (const candle of candles) {
    const rows = buckets.get(candle.timestamp) ?? [];
    rows.push(candle);
    buckets.set(candle.timestamp, rows);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, rows]) => {
      if (
        rows.length !== scope.pools.length ||
        new Set(rows.map((c) => c.poolId)).size !== rows.length ||
        rows.some((c) => !pools.has(c.poolId))
      )
        throw new Error("Incomplete market inputs");
      rows.sort((a, b) => a.poolId.localeCompare(b.poolId));
      const valued = valueBucket(
        scope,
        metadata,
        timestamp,
        bucketTrades.get(timestamp) ?? [],
        snapshots,
      );
      if (
        coverage(rows) !== "complete" ||
        rows.some((c) => c.rejectedEvents > 0)
      )
        for (const candle of valued.prices)
          if (candle.status === "complete") candle.status = "partial";
      return {
        timestamp,
        coverage: coverage(rows),
        baseVolumeAtoms: sum(rows.map((c) => c.baseVolumeAtoms)),
        tradeCount: rows.reduce((n, c) => n + c.tradeCount, 0),
        rejectedEvents: rows.reduce((n, c) => n + c.rejectedEvents, 0),
        expectedPoolIds: scope.pools.map((p) => p.id),
        pools: rows,
        quotes: quotes.map((token) => {
          const group = rows.filter(
            (c) => quoteToken(pools.get(c.poolId)!) === token,
          );
          const prices = trades.get(`${timestamp}:${token}`);
          return {
            timestamp,
            quoteToken: token,
            quoteDecimals: metadata.decimals[token],
            poolIds: group.map((c) => c.poolId),
            coverage: coverage(group),
            open: prices ? price(prices.open) : null,
            high: prices ? price(prices.high) : null,
            low: prices ? price(prices.low) : null,
            close: prices ? price(prices.close) : null,
            baseVolumeAtoms: sum(group.map((c) => c.baseVolumeAtoms)),
            quoteVolumeAtoms: sum(group.map((c) => c.quoteVolumeAtoms)),
            tradeCount: group.reduce((n, c) => n + c.tradeCount, 0),
            rejectedEvents: group.reduce((n, c) => n + c.rejectedEvents, 0),
          };
        }),
        ...valued,
      };
    });
}
