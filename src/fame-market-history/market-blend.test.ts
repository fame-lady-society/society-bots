import { blendedMarket, type BlendInput } from "./market-blend.ts";
import { fraction } from "./price-math.ts";
const f = (n: number) => fraction(BigInt(n), 1n);
const pool = (
  poolId: string,
  weight: bigint,
  opening: number,
  closing: number,
  events: [number, number][],
): BlendInput => ({
  poolId,
  weight,
  opening: f(opening),
  closing: f(closing),
  conversion: f(1),
  activity: {
    poolId,
    coverage: "complete",
    tradeCount: 0,
    baseVolumeAtoms: "0",
    quoteVolumeAtoms: "0",
    transactionHashes: [],
    spotEvents: events.map(([logIndex, price]) => ({
      blockNumber: 1,
      logIndex,
      price: f(price),
    })),
  },
});
test("fixed FAME weights produce one price and extrema of the synchronized path", () => {
  const a = pool("a", 3n, 10, 10, [
      [1, 20],
      [2, 10],
    ]),
    b = pool("b", 1n, 10, 10, [
      [3, 40],
      [4, 10],
    ]);
  // Per-pool high blend is 25, but maxima never coincide. Actual composite high is 17.5.
  const result = blendedMarket([b, a], 300);
  expect(result.price).toBe("10.000000000000000000");
  expect(result.candle).toEqual({
    open: "10.000000000000000000",
    high: "17.500000000000000000",
    low: "10.000000000000000000",
    close: "10.000000000000000000",
    coverage: "complete",
  });
  expect(result.weights.find((p) => p.poolId === "a")!.fameBalanceAtoms).toBe(
    "3",
  );
});
test("quiet index moves with the closing conversion rate and does not require trades", () => {
  const a = pool("a", 3n, 10, 10, []),
    b = pool("b", 1n, 20, 20, []);
  a.conversion = f(2);
  const r = blendedMarket([a, b], 300);
  expect(r.price).toBe("20.000000000000000000");
  expect(r.candle?.coverage).toBe("reference-only");
  expect(r.candle?.low).toBe(r.price);
});
test("missing weight or positive-weight pricing never silently reweights the index", () => {
  const a = pool("a", 1n, 10, 10, []),
    b = pool("b", 1n, 20, 20, []);
  expect(blendedMarket([a, { ...b, weight: null }], 300).price).toBeNull();
  expect(blendedMarket([a, { ...b, conversion: null }], 300).price).toBeNull();
  expect(
    blendedMarket([a, { ...b, weight: 0n, conversion: null }], 300).price,
  ).toBe("10.000000000000000000");
  expect(blendedMarket([{ ...a, weight: 0n }], 300).price).toBeNull();
  const partial = {
    ...a,
    activity: { ...a.activity!, coverage: "partial" as const },
  };
  expect(blendedMarket([partial], 300).coverage).toBe("price-only");
  expect(blendedMarket([partial], 300).candle).toBeNull();
  expect(blendedMarket([{ ...a, opening: null }], 300).candle).toBeNull();
});
test("duplicate event positions fail instead of creating an arbitrary composite ordering", () => {
  expect(() =>
    blendedMarket(
      [pool("a", 1n, 1, 2, [[1, 2]]), pool("b", 1n, 1, 2, [[1, 2]])],
      300,
    ),
  ).toThrow("Duplicate");
});
