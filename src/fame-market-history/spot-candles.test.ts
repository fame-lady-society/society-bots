import { scope, metadata, epoch } from "./worker-fixture.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";
import {
  sampledMarketBucket,
  fraction,
  invert,
  decimal,
  type PoolActivity,
} from "./sampled-market.ts";
import { eventSpot, extend } from "./spot-candles.ts";
import { FAME_ADDRESS } from "./model.ts";
import type { DecodedEvent } from "./decode.ts";
const event = (eventName: string, args: Record<string, string>) =>
  ({ eventName, args }) as DecodedEvent;
test("reserve and square-root state prices respect orientation and decimals, not execution amounts", () => {
  for (const pool of scope.pools) {
    const e =
      pool.venueFamily === "Slipstream"
        ? event("Swap", {
            sqrtPriceX96: String(2n ** 96n),
            liquidity: "10",
            amount0: "999",
            amount1: "1",
          })
        : event("Sync", { reserve0: "100", reserve1: "400" });
    const actual = eventSpot(scope, pool, e, metadata)!;
    const rate =
      pool.venueFamily === "Slipstream" ? fraction(1n, 1n) : fraction(4n, 1n);
    expect(actual).toEqual(pool.token0 === FAME_ADDRESS ? rate : invert(rate));
  }
  const p = scope.pools.find((p) => p.venueFamily === "UniswapV2")!;
  const m = {
    ...metadata,
    decimals: { ...metadata.decimals, [p.token0]: 6, [p.token1]: 18 },
  };
  const r = eventSpot(
    scope,
    p,
    event("Sync", { reserve0: "1000000", reserve1: "2000000000000000000" }),
    m,
  )!;
  expect(decimal(r)).toBe(
    decimal(p.token0 === FAME_ADDRESS ? fraction(2n, 1n) : fraction(1n, 2n)),
  );
  expect(
    eventSpot(
      scope,
      p,
      event("Sync", { reserve0: "0", reserve1: "10" }),
      metadata,
    ),
  ).toBeNull();
  expect(eventSpot(scope, p, event("Transfer", {}), metadata)).toBeUndefined();
});
test("spot candles retain event extrema and apply one bucket-end conversion rate", () => {
  const o = deriveSampledObservation(scope, sampledFixture()),
    prev = deriveSampledObservation(scope, sampledFixture(epoch - 300));
  const p = scope.pools.find((p) => p.id === "scale-equalizer-weth-fame")!;
  const oriented = (n: bigint) =>
    p.token0 === FAME_ADDRESS ? fraction(n, 1n) : fraction(1n, n);
  o.rates[p.id] = oriented(3n);
  prev.rates[p.id] = oriented(2n);
  let spot = extend(undefined, fraction(5n, 1n));
  spot = extend(spot, fraction(1n, 1n));
  spot = extend(spot, fraction(3n, 1n));
  const activity: PoolActivity = {
    poolId: p.id,
    coverage: "complete",
    baseVolumeAtoms: "5",
    quoteVolumeAtoms: "7",
    tradeCount: 1,
    transactionHashes: [`0x${"1".repeat(64)}`],
    spot,
  };
  const get = (currency: "ETH" | "USDC", a = activity, opening = prev) =>
    sampledMarketBucket(scope, currency, epoch, o, [a], opening).series.find(
      (s) => s.poolId === p.id,
    )!;
  expect(get("ETH").candle).toEqual({
    open: "2.000000000000000000",
    high: "5.000000000000000000",
    low: "1.000000000000000000",
    close: "3.000000000000000000",
    coverage: "complete",
  });
  const c = get("USDC");
  expect(c.candle?.close).toBe(c.price);
  expect(Number(c.candle!.high) / Number(c.candle!.low)).toBeCloseTo(5);
  expect(get("ETH", { ...activity, spotInvalid: true }).candle).toBeNull();
  expect(get("ETH", { ...activity, coverage: "partial" }).candle).toBeNull();
  expect(get("ETH", { ...activity, spot: undefined }).candle).toBeNull();
  const quiet = get("ETH", {
    ...activity,
    spot: undefined,
    tradeCount: 0,
    transactionHashes: [],
    baseVolumeAtoms: "0",
    quoteVolumeAtoms: "0",
  });
  expect(quiet.candle?.coverage).toBe("reference-only");
  expect(quiet.candle?.open).toBe(quiet.price);
  expect(
    sampledMarketBucket(scope, "ETH", epoch, o, [activity]).series.find(
      (s) => s.poolId === p.id,
    )!.candle?.coverage,
  ).toBe("partial");
});

test("stable reserves use the invariant's marginal price", () => {
  const pool = scope.pools.find((p) => p.venueFamily === "Solidly")!;
  const stableScope = {
    ...scope,
    registry: {
      ...scope.registry,
      pools: scope.registry.pools.map((p) =>
        p.id === pool.id ? { ...p, stable: true } : p,
      ),
    },
  };
  const r = eventSpot(
    stableScope,
    pool,
    event("Sync", { reserve0: "100", reserve1: "400" }),
    metadata,
  )!;
  const rate = fraction(4n * (3n + 16n), 1n + 48n);
  expect(r).toEqual(pool.token0 === FAME_ADDRESS ? rate : invert(rate));
});
