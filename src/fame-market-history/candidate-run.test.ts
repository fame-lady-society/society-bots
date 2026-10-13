import {
  candidatePlan,
  candidateSpec,
  candidatePrevious,
  candidateSampleStart,
  candidateScope,
} from "./candidate.ts";
import { latestCompletedDay } from "./candidate-run.ts";
import { fullScope } from "./full-scope.ts";
import { octoberScope } from "./october-scope.ts";
import { originsFor } from "./pool-lifecycle.ts";
import {
  sampledCallsAtBlock,
  deriveSampledObservation,
} from "./sampled-rpc.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { reusePreAdmissionSample } from "./admission-opening.ts";
import { sampledMarketBucket } from "./sampled-market.ts";
const scope = fullScope();
test("frozen UTC cutoff includes all completed days and a shorter final chunk", () => {
  const to = latestCompletedDay(Date.parse("2026-10-13T02:00:00Z"));
  const chunks = candidatePlan(to);
  expect(candidateSpec(chunks.at(-1)!).to).toBe(to);
  for (let i = 1; i < chunks.length; i++) {
    expect(candidateSpec(chunks[i]).from).toBe(candidateSpec(chunks[i - 1]).to);
    expect(candidatePrevious(chunks[i])).toBe(chunks[i - 1]);
    expect(
      candidateSpec(chunks[i]).to - candidateSpec(chunks[i]).from,
    ).toBeLessThanOrEqual(30 * 86400);
  }
  expect(candidateSampleStart(chunks.at(-1)!)).toBe(1731196800);
  expect(candidateScope(chunks.at(-1)!).id).toBe(scope.id);
  expect(() => candidatePlan(to + 1)).toThrow();
  expect(() => candidateSpec("catchup-5-9999999999")).toThrow();
});
test("full admission preserves the four-pool opening and exposes unborn pools", () => {
  const t = 1731196500,
    source = octoberScope(),
    e = sampledFixture(t, source);
  e.block = {
    number: 22203726,
    hash: `0x${"a".repeat(64)}`,
    parentHash: `0x${"b".repeat(64)}`,
    timestamp: t + 299,
  };
  e.after = {
    ...e.block,
    number: e.block.number + 1,
    timestamp: t + 300,
    parentHash: e.block.hash,
  };
  const mapped = reusePreAdmissionSample(source, scope, e);
  for (const c of ["ETH", "USDC"] as const) {
    const prior = sampledMarketBucket(
      source,
      c,
      t,
      deriveSampledObservation(source, e),
      [],
    );
    const next = sampledMarketBucket(
      scope,
      c,
      t,
      deriveSampledObservation(scope, mapped),
      [],
    );
    expect(next.series).toEqual(prior.series);
    expect(next.notYetCreatedPoolIds).toHaveLength(4);
  }
});
test.each([
  "scale-equalizer-weth-fame",
  "scale-equalizer-scale-fame",
  "scale-equalizer-frxusd-fame",
  "slipstream-basedflick-fame",
])("%s begins exact creation block", (id) => {
  const o = originsFor(scope)[id];
  expect(
    sampledCallsAtBlock(scope, o.block - 1).some(
      (c) => c.key === `${id}:state`,
    ),
  ).toBe(false);
  expect(
    sampledCallsAtBlock(scope, o.block).some((c) => c.key === `${id}:state`),
  ).toBe(true);
});
