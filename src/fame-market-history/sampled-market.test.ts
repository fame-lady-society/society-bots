import { scope, epoch } from "./worker-fixture.ts";
import { FAME_ADDRESS } from "./model.ts";
import { WETH } from "./valuation.ts";
import {
  sampledPolicy,
  sampledMarketBucket,
  fraction,
  multiply,
  invert,
  decimal,
  type SampledObservation,
  type PoolActivity,
} from "./sampled-market.ts";
import { sampledCalls } from "./sampled-rpc.ts";
const policy = sampledPolicy(scope);
const unit = 10n ** 18n;
const wethPool = scope.pools.find((p) => p.id === "scale-equalizer-weth-fame")!;
const sample = (): SampledObservation => ({
  version: "fame-market-observation-v1",
  policyRevision: policy.revision,
  timestamp: epoch,
  block: {
    number: 100,
    timestamp: epoch + 299,
    hash: `0x${"a".repeat(64)}`,
    parentHash: `0x${"b".repeat(64)}`,
  },
  after: {
    number: 101,
    timestamp: epoch + 300,
    hash: `0x${"c".repeat(64)}`,
    parentHash: `0x${"a".repeat(64)}`,
  },
  rates: Object.fromEntries(
    policy.sources.map((p) => [
      p.id,
      fraction(p.id === "uniswap-v3-usdc-weth-5bps" ? 2000n : 1n, 1n),
    ]),
  ),
  decimals: Object.fromEntries(
    policy.sources
      .flatMap((p) => [p.token0, p.token1])
      .map((t) => [
        t,
        t === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ? 6 : 18,
      ]),
  ),
  balances: Object.fromEntries(
    scope.pools.map((p) => [
      p.id,
      { balance0: String(unit), balance1: String(unit) },
    ]),
  ),
});
const quiet = (): PoolActivity[] =>
  scope.pools.map((p) => ({
    poolId: p.id,
    coverage: "complete",
    baseVolumeAtoms: "0",
    quoteVolumeAtoms: "0",
    tradeCount: 0,
    transactionHashes: [],
  }));
const bucket = (s: SampledObservation | null = sample(), a = quiet()) =>
  sampledMarketBucket(scope, "USDC", epoch, s, a);
test("shares connectors, stops USDC routes early, and never reads oracle or tick state", () => {
  expect(policy.sources).toHaveLength(10);
  expect(policy.routes["scale-equalizer-frxusd-fame"].USDC).toEqual([
    "scale-equalizer-usdc-frxusd",
  ]);
  expect(policy.routes["slipstream-basedflick-fame"].USDC).toHaveLength(3);
  const calls = sampledCalls(scope);
  expect(new Set(calls.map((c) => c.key)).size).toBe(calls.length);
  expect(calls.some((c) => /tick|RoundData/.test(c.functionName))).toBe(false);
});
test("keeps exact fractions through reversals and tiny multi-hop prices", () => {
  const a = fraction(1n, 10n ** 30n);
  expect(decimal(multiply(a, fraction(10n ** 30n, 3n)))).toBe(
    "0.333333333333333333",
  );
  expect(multiply(a, invert(a))).toEqual(fraction(1n, 1n));
});
test("quiet buckets have moving reference prices, zero verified volume, and no fabricated OHLC", () => {
  const s = sample();
  const before = bucket(s);
  s.rates["uniswap-v3-usdc-weth-5bps"] = fraction(2500n, 1n);
  const after = bucket(s);
  expect(before.series.find((r) => r.poolId === wethPool.id)?.price).toBe(
    "2000.000000000000000000",
  );
  expect(after.series.find((r) => r.poolId === wethPool.id)?.price).toBe(
    "2500.000000000000000000",
  );
  expect(after.totals.volume).toEqual({
    status: "complete",
    value: "0.000000000000000000",
  });
  expect(after.series[0]).not.toHaveProperty("high");
});
test("values actual quote volume at closing rate and counts a multi-pool transaction once", () => {
  const a = quiet(),
    tx = `0x${"d".repeat(64)}`;
  for (const row of a.slice(0, 2))
    Object.assign(row, {
      baseVolumeAtoms: String(unit),
      quoteVolumeAtoms: String(unit),
      tradeCount: 1,
      transactionHashes: [tx],
    });
  const r = bucket(sample(), a);
  expect(r.totals.tradeCount).toBe(2);
  expect(r.totals.distinctTransactionCount).toBe(1);
  expect(r.totals.baseVolumeAtoms).toBe(String(2n * unit));
  expect(r.conversionMethod).toBe("bucket-end-spot");
  const w = quiet();
  Object.assign(w.find((x) => x.poolId === wethPool.id)!, {
    baseVolumeAtoms: String(unit),
    quoteVolumeAtoms: String(2n * unit),
    tradeCount: 1,
    transactionHashes: [tx],
  });
  expect(
    bucket(sample(), w).series.find((r) => r.poolId === wethPool.id)?.volume,
  ).toBe("4000.000000000000000000");
});
test("price, event coverage, conversion and inventory fail independently", () => {
  const s = sample();
  s.balances[wethPool.id] = null;
  const r = bucket(s, []);
  expect(r.series.find((r) => r.poolId === wethPool.id)?.price).not.toBeNull();
  expect(r.totals.tradeCount).toBeNull();
  expect(r.totals.volume.status).toBe("unavailable");
  expect(r.totals.inventory.status).toBe("partial");
  s.rates["uniswap-v3-usdc-weth-5bps"] = null;
  const missing = bucket(s);
  expect(missing.totals.eventCoverage).toBe("complete");
  expect(missing.totals.volume.status).toBe("partial");
  expect(
    missing.series.find((r) => r.poolId === wethPool.id)?.price,
  ).toBeNull();
  expect(
    sampledMarketBucket(scope, "ETH", epoch, null, quiet()).series.find(
      (r) => r.poolId === wethPool.id,
    )?.volume,
  ).toBe("0.000000000000000000");
});
test.each(["boundary", "hash", "policy"])(
  "rejects mismatched %s evidence",
  (kind) => {
    const s = sample();
    if (kind === "boundary") s.block.timestamp = epoch + 300;
    if (kind === "hash") s.after.parentHash = `0x${"e".repeat(64)}`;
    if (kind === "policy") s.policyRevision = "wrong";
    expect(() => bucket(s)).toThrow();
  },
);
test("rejects duplicate activities and unreviewed routes", () => {
  expect(() => bucket(sample(), [quiet()[0], quiet()[0]])).toThrow();
  const changed = structuredClone(scope);
  changed.pools[0].token0 = "0x1111111111111111111111111111111111111111";
  expect(() => sampledPolicy(changed)).toThrow();
});

test("initial 24-hour five-series payload fits the existing API cap without transaction lists", () => {
  const r = bucket();
  expect(r.series[0]).not.toHaveProperty("transactionHashes");
  const bytes = Buffer.byteLength(
    JSON.stringify({
      buckets: Array.from({ length: 288 }, (_, i) => ({
        ...r,
        timestamp: epoch + i * 300,
      })),
    }),
  );
  expect(bytes).toBeLessThan(2 * 1024 * 1024);
  // Proposed one-hour pages leave ample room below DynamoDB's 400 KiB item cap.
  expect(Buffer.byteLength(JSON.stringify(Array(12).fill(r)))).toBeLessThan(
    300 * 1024,
  );
});
