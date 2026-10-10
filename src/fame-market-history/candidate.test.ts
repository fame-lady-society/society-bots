import {
  advanceCandidate,
  candidateSpec,
  prepareCandidate,
} from "./candidate.ts";
import { launchScope } from "./local-backfill.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import {
  nextSampledPublication,
  type SampledCursor,
  type SampledPublication,
  type SampledStore,
} from "./sampled-live.ts";
import type { ChainReader, ArchiveStore } from "./collector.ts";
import type { Cursor, Header } from "./model.ts";
const spec = candidateSpec(),
  scope = launchScope();
const h = (number: number): Header => ({
  number,
  timestamp: spec.from + 29 + (number - spec.startBlock) * 2,
  hash: `0x${number.toString(16).padStart(64, "0")}`,
  parentHash: `0x${(number - 1).toString(16).padStart(64, "0")}`,
});
const end = spec.startBlock + 30 * 43200 - 14;
const bounds = {
  launch: h(spec.startBlock),
  before: h(spec.startBlock - 1),
  end: h(end),
  endBefore: h(end - 1),
};
function fixture() {
  let raw: Cursor = {
      startBlock: spec.startBlock,
      nextBlock: spec.startBlock,
      previousHash: null,
    },
    parquet = spec.startBlock,
    c: SampledCursor | null = null,
    p: SampledPublication | null = null,
    samples = 0;
  const evidence = new Map<number, ReturnType<typeof sampledFixture>>();
  const operations: string[] = [];
  const chain: ChainReader = {
    header: async (n) => h(n),
    finalized: async () => h(end + 10),
    logs: async (_, to) => ({ logs: [], throughBlock: to }),
  };
  const archive: ArchiveStore = {
    cursor: async () => raw,
    upload: async () => {
      operations.push("raw-upload");
    },
    commit: async (m) => {
      raw = { ...raw, nextBlock: m.toBlock + 1, previousHash: m.lastHash };
      operations.push("raw-commit");
    },
    reduceRange: async () => {},
  };
  const sampled: SampledStore = {
    cursor: async (initial) => c ?? (c = initial),
    collected: async () => c,
    publication: async () => p,
    read: async (t) => evidence.get(t)!,
    previous: async (t) => evidence.get(t - 300) ?? null,
    commit: async (cur, e) => {
      evidence.set(e.timestamp, e);
      c = { ...cur, nextTimestamp: e.timestamp + 300, anchor: e.block };
      operations.push("sample");
    },
    activity: async () => [],
    publish: async (prior, e, buckets) => {
      p = nextSampledPublication(prior, e, buckets);
      operations.push("publish");
    },
  };
  const args = {
    bounds,
    chain,
    archive,
    sampled,
    sample: async (t: number, b: Header, a: Header) => {
      samples++;
      return { ...sampledFixture(t, scope), block: b, after: a };
    },
    aggregationNext: async () => parquet,
    aggregate: async () => {
      parquet = raw.nextBlock;
      operations.push("parquet");
      return { status: "published" };
    },
    canContinue: async () => true,
  };
  return {
    args,
    operations,
    get samples() {
      return samples;
    },
    get cursor() {
      return c;
    },
    get publication() {
      return p;
    },
    complete: () => {
      raw = { ...raw, nextBlock: end + 1, previousHash: h(end).hash };
      parquet = end + 1;
      c = {
        startTimestamp: spec.from,
        nextTimestamp: spec.to,
        policyRevision: spec.policyRevision,
        anchor: h(end - 1),
      };
      p = { nextTimestamp: spec.to } as SampledPublication;
    },
  };
}
test("fixed 30-day chunk has only the original two pools", () => {
  expect(spec.to - spec.from).toBe(30 * 86400);
  expect(scope.pools.map((p) => p.id).sort()).toEqual([
    "uniswap-v2-fame-direct",
    "uniswap-v3-weth-fame-30bps",
  ]);
});
test("preparation resolves the exclusive boundary from bracketed header timestamps", async () => {
  const f = fixture();
  expect((await prepareCandidate(f.args.chain)).end).toEqual(bounds.end);
});
test("bounded pipeline checkpoints raw then parquet then sample; retry publishes without sampling twice", async () => {
  const f = fixture();
  await advanceCandidate({ ...f.args, maxSteps: 3 });
  expect(f.operations).toEqual([
    "raw-upload",
    "raw-commit",
    "parquet",
    "sample",
  ]);
  expect(f.samples).toBe(1);
  await advanceCandidate({ ...f.args, maxSteps: 1 });
  expect(f.samples).toBe(1);
  expect(f.publication?.nextTimestamp).toBe(spec.from + 300);
});
test("pause before work and resume preserves independent progress", async () => {
  const f = fixture();
  await advanceCandidate({ ...f.args, canContinue: async () => false });
  expect(f.operations).toEqual([]);
  await advanceCandidate({ ...f.args, maxSteps: 4 });
  expect(f.operations.at(-1)).toBe("publish");
});
test("completion requires raw, parquet and publication to reach the target", async () => {
  const f = fixture();
  f.complete();
  expect((await advanceCandidate(f.args)).phase).toBe("complete");
  expect(f.operations).toEqual([]);
});
test("changed saved sample anchor fails closed", async () => {
  const f = fixture();
  await advanceCandidate({ ...f.args, maxSteps: 3 });
  f.args.chain.header = async (n) => ({
    ...h(n),
    hash: n === f.cursor!.anchor.number ? `0x${"ff".repeat(32)}` : h(n).hash,
  });
  await expect(advanceCandidate(f.args)).rejects.toThrow("anchor changed");
});

test("lost sample commit response resumes publication without another RPC sample", async () => {
  const f = fixture(),
    commit = f.args.sampled.commit;
  f.args.sampled.commit = async (c, e) => {
    await commit(c, e);
    throw new Error("lost response");
  };
  await expect(advanceCandidate({ ...f.args, maxSteps: 3 })).rejects.toThrow(
    "lost response",
  );
  f.args.sampled.commit = commit;
  await advanceCandidate({ ...f.args, maxSteps: 1 });
  expect(f.samples).toBe(1);
  expect(f.publication?.nextTimestamp).toBe(spec.from + 300);
});

test("invalid end boundary cannot expand the approved time interval", async () => {
  const f = fixture();
  await expect(
    advanceCandidate({
      ...f.args,
      bounds: { ...bounds, endBefore: bounds.end },
    }),
  ).rejects.toThrow("Invalid candidate boundaries");
});
