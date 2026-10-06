import { marketCandles } from "./market.ts";
import { scope, metadata, epoch } from "./worker-fixture.ts";
import type { Candle } from "./analytics.ts";
import type { DecodedEvent } from "./decode.ts";
import {
  ETH_USD_FEED,
  VALUATION_VERSION,
  WETH,
  valueBucket,
  validateSnapshots,
  type ValuationSnapshot,
} from "./valuation.ts";
import { reservePrice } from "./valuation-rpc.ts";
const unit = 10n ** 18n;
const wethPools = scope.pools.filter((p) =>
  [p.token0, p.token1].includes(WETH),
);
const trade = (poolId: string, block: number, price: bigint): DecodedEvent =>
  ({
    classification: "trade",
    baseAtoms: unit.toString(),
    quoteAtoms: (price * unit).toString(),
    priceX18: (price * unit).toString(),
    raw: {
      poolId,
      blockNumber: block,
      blockTimestamp: epoch + 10,
      transactionIndex: 0,
      logIndex: 0,
    },
  }) as DecodedEvent;
const rows = scope.pools.map(
  (p) =>
    ({
      poolId: p.id,
      timestamp: epoch,
      coverage: "complete",
      open: null,
      high: null,
      low: null,
      close: null,
      baseVolumeAtoms: "0",
      quoteVolumeAtoms: "0",
      tradeCount: 0,
      rejectedEvents: 0,
    }) as Candle,
);
const sample = (block = 99): ValuationSnapshot => ({
  version: VALUATION_VERSION,
  block: {
    number: block,
    timestamp: epoch - 1,
    hash: `0x${"a".repeat(64)}`,
    parentHash: `0x${"b".repeat(64)}`,
  },
  ethUsd: {
    feed: ETH_USD_FEED,
    roundId: "1",
    updatedAt: epoch - 10,
    priceX18: (2000n * unit).toString(),
  },
  quotes: { [WETH]: { ethX18: unit.toString(), route: [] } },
  pools: {},
});
test("archive valuation quantities must remain exact strings", () => {
  const malformed = sample();
  (malformed.ethUsd as unknown as { priceX18: number }).priceX18 = 2000;
  expect(() => validateSnapshots([malformed], scope)).toThrow(
    "Invalid oracle observation",
  );
});

test("cross-pool OHLC follows chain ordering and never combines different quote currencies", () => {
  const events = [
    trade(wethPools[0].id, 103, 3n),
    trade(wethPools[1].id, 101, 2n),
    trade(wethPools[0].id, 102, 4n),
  ];
  const result = marketCandles(scope, metadata, events, rows, [sample()])[0];
  expect(result.quotes.find((q) => q.quoteToken === WETH)).toMatchObject({
    open: "2.000000000000000000",
    close: "3.000000000000000000",
    high: "4.000000000000000000",
  });
  expect(result.prices[0]).toMatchObject({
    open: "2.000000000000000000",
    volume: "9.000000000000000000",
  });
  expect(result.prices[1]).toMatchObject({
    open: "4000.000000000000000000",
    volume: "18000.000000000000000000",
  });
  expect(
    result.quotes
      .filter((q) => q.quoteToken !== WETH)
      .every((q) => q.open === null),
  ).toBe(true);
});
test("future or stale FX cannot price an earlier execution; native ETH remains exact", () => {
  const trades = [trade(wethPools[0].id, 100, 2n)];
  const future = valueBucket(scope, metadata, epoch, trades, [sample(100)]);
  expect(future.prices[0].pricedTradeCount).toBe(1);
  expect(future.prices[1]).toMatchObject({
    status: "unavailable",
    volume: null,
    pricedBaseVolumeAtoms: "0",
    unpricedBaseVolumeAtoms: unit.toString(),
  });
  const stale = sample();
  stale.ethUsd!.updatedAt = epoch - 1801;
  expect(
    valueBucket(scope, metadata, epoch, trades, [stale]).prices[1].status,
  ).toBe("unavailable");
});
test("missing connector quotes preserve the unpriced denominator", () => {
  const other = scope.pools.find((p) => ![p.token0, p.token1].includes(WETH))!;
  const result = valueBucket(
    scope,
    metadata,
    epoch,
    [trade(wethPools[0].id, 100, 2n), trade(other.id, 101, 3n)],
    [sample()],
  );
  expect(result.prices[0]).toMatchObject({
    status: "partial",
    pricedBaseVolumeAtoms: unit.toString(),
    unpricedBaseVolumeAtoms: unit.toString(),
  });
});
test("custody balances, not active CL liquidity, determine valued liquidity", () => {
  const snapshot = sample();
  snapshot.pools[wethPools[0].id] = {
    balance0: (3n * unit).toString(),
    balance1: (4n * unit).toString(),
    quotePerFameX18: (2n * unit).toString(),
  };
  const result = valueBucket(scope, metadata, epoch, [], [snapshot]);
  const p = wethPools[0];
  const expected = p.token0 === WETH ? 11 : 10;
  expect(result.liquidity).toMatchObject({
    status: "partial",
    eth: `${expected}.000000000000000000`,
    usd: `${expected * 2000}.000000000000000000`,
  });
});
test("stable-pool marginal price differs from reserve ratio when unbalanced", () => {
  expect(reservePrice(2n * unit, unit, 18, 18, false)).toBe(unit / 2n);
  expect(reservePrice(2n * unit, unit, 18, 18, true)).toBe((13n * unit) / 14n);
  expect(reservePrice(1000000n, unit, 6, 18, true)).toBe(unit);
});
test("partial pool coverage and missing expected inputs remain visible", () => {
  expect(
    marketCandles(
      scope,
      metadata,
      [],
      rows.map((c, i) => ({
        ...c,
        coverage: i === 0 ? "partial" : c.coverage,
      })),
    )[0].coverage,
  ).toBe("partial");
  expect(() => marketCandles(scope, metadata, [], rows.slice(1))).toThrow(
    "Incomplete market inputs",
  );
});
