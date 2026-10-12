import { readFileSync } from "node:fs";
import { octoberScope } from "./october-scope.ts";
import { launchScope } from "./local-backfill.ts";
import { candidateSpec, candidateHash } from "./candidate.ts";
import { admissionOrigins } from "./pool-lifecycle.ts";
import {
  sampledCalls,
  sampledCallsAtBlock,
  deriveSampledObservation,
} from "./sampled-rpc.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { sampledMarketBucket, type PoolActivity } from "./sampled-market.ts";
import { reusePreAdmissionSample } from "./admission-opening.ts";
import { projectChartBucket } from "./chart-api.ts";
import type { Header } from "./model.ts";
const source = launchScope(),
  target = octoberScope();
const header = (number: number, timestamp: number): Header => ({
  number,
  timestamp,
  hash: `0x${number.toString(16).padStart(64, "0")}`,
  parentHash: `0x${(number - 1).toString(16).padStart(64, "0")}`,
});
const quiet = (poolId: string): PoolActivity => ({
  poolId,
  coverage: "complete",
  tradeCount: 0,
  transactionHashes: [],
  baseVolumeAtoms: "0",
  quoteVolumeAtoms: "0",
  spotEvents: [],
});
function evidence(timestamp: number, number: number, scope = target) {
  return {
    ...sampledFixture(timestamp, scope),
    block: header(number, timestamp + 299),
    after: header(number + 1, timestamp + 300),
  };
}
test("October admission is a new four-pool generation and leaves deployed job identities untouched", () => {
  expect(candidateHash()).toBe(
    "42692d8932e5245782cda6fe0c0401cbd37cd815b58cc7c70552681d63511ded",
  );
  const october = candidateSpec("october-30d-v1");
  expect(october.from).toBe(candidateSpec("september-30d-v1").to);
  expect(new Date(october.to * 1000).toISOString()).toBe(
    "2024-11-10T00:00:00.000Z",
  );
  expect(october.scopeId).not.toBe(candidateSpec().scopeId);
  expect(october.policyRevision).not.toBe(candidateSpec().policyRevision);
  expect(target.pools.map((p) => p.id).sort()).toEqual(
    [
      ...source.pools.map((p) => p.id),
      "aerodrome-cbbtc-fame",
      "aerodrome-spx-fame",
    ].sort(),
  );
});
test("lifecycle boundaries match retained reviewed creation evidence", () => {
  const origins = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/research/2026-10-10-pool-admission-origins.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const origin of origins)
    expect(admissionOrigins[origin.id]).toEqual({
      block: origin.creationBlock,
      timestamp: Date.parse(origin.creationTimestamp) / 1000,
    });
});
test.each(["aerodrome-spx-fame", "aerodrome-cbbtc-fame"])(
  "%s includes exact creation block and reads routes only after admission",
  (id) => {
    const origin = admissionOrigins[id];
    const before = sampledCallsAtBlock(target, origin.block - 1).map(
      (c) => c.key,
    );
    const at = sampledCallsAtBlock(target, origin.block).map((c) => c.key);
    expect(before.some((k) => k.startsWith(`${id}:`))).toBe(false);
    expect(at).toContain(`${id}:state`);
    const route = id.includes("spx")
      ? "slipstream-spx-weth"
      : "uniswap-v3-usdc-cbbtc-5bps";
    expect(before.some((k) => k.startsWith(`${route}:`))).toBe(false);
    expect(at).toContain(`${route}:state`);
  },
);
test.each(["ETH", "USDC"] as const)(
  "%s pre-admission history is unchanged and unborn pool is explicit",
  (currency) => {
    const t = candidateSpec().from + 300;
    const e = evidence(t, 17020100, source),
      prior = evidence(t - 300, 17019950, source);
    // Preserve a real failed call instead of filling it from a different block.
    e.results[0] = { success: false, returnData: "0x" };
    const mapped = reusePreAdmissionSample(source, target, e);
    const a = source.pools.map((p) => quiet(p.id));
    const old = sampledMarketBucket(
      source,
      currency,
      t,
      deriveSampledObservation(source, e),
      a,
      deriveSampledObservation(source, prior),
    );
    const next = sampledMarketBucket(
      target,
      currency,
      t,
      deriveSampledObservation(target, mapped),
      a,
      deriveSampledObservation(
        target,
        reusePreAdmissionSample(source, target, prior),
      ),
    );
    expect(next.market).toEqual(old.market);
    expect(next.series).toEqual(old.series);
    expect(next.totals).toEqual(old.totals);
    expect(mapped.sourceEvidence?.policyRevision).toBe(e.policyRevision);
    const pool = projectChartBucket(next, "aerodrome-spx-fame");
    expect(pool).toMatchObject({
      publicationStatus: "published",
      reason: "not-yet-created",
      price: null,
      volume: "0",
      tradeCount: 0,
    });
    const key = sampledCalls(source)[0].key;
    expect(
      mapped.results[sampledCalls(target).findIndex((c) => c.key === key)],
    ).toEqual(e.results[0]);
  },
);
test.each(["aerodrome-spx-fame", "aerodrome-cbbtc-fame"])(
  "%s joins at zero opening weight and does not poison the market",
  (id) => {
    const origin = admissionOrigins[id],
      t = Math.floor(origin.timestamp / 300) * 300;
    const before = evidence(t - 300, origin.block - 1),
      at = evidence(t, origin.block + 100);
    const b = deriveSampledObservation(target, before);
    // Unborn pools have no previous state. In particular no future balance may be used.
    for (const p of target.pools)
      if (admissionOrigins[p.id]?.block >= origin.block) {
        b.balances[p.id] = null;
        b.rates[p.id] = null;
      }
    const next = sampledMarketBucket(
      target,
      "USDC",
      t,
      deriveSampledObservation(target, at),
      target.pools.map((p) => quiet(p.id)),
      b,
    );
    expect(next.market.price).not.toBeNull();
    expect(next.market.missingPoolIds).not.toContain(id);
    expect(next.series.find((p) => p.poolId === id)?.price).not.toBeNull();
  },
);
test("retained samples cannot be reused across the earliest added pool launch", () => {
  const o = admissionOrigins["aerodrome-spx-fame"];
  expect(() =>
    reusePreAdmissionSample(
      source,
      target,
      evidence(Math.floor(o.timestamp / 300) * 300, o.block, source),
    ),
  ).toThrow("crosses pool admission");
});
