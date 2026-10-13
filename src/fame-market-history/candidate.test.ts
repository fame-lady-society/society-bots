import {
  advanceCandidate,
  candidateSpec,
  candidateHash,
  candidateChunks,
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
  const previousReads: number[] = [];
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
    previous: async (t) => {
      previousReads.push(t);
      return evidence.get(t - 300) ?? null;
    },
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
    previousReads,
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
      const e = {
        ...sampledFixture(spec.to - 300, scope),
        block: h(end - 1),
        after: h(end),
      };
      evidence.set(e.timestamp, e);
      p = {
        nextTimestamp: spec.to,
        policyRevision: spec.policyRevision,
        pages: [],
      } as unknown as SampledPublication;
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

test("reviewed chunks are contiguous, keep the deployed first hash, and isolate October admission", () => {
  expect(candidateHash()).toBe(
    "42692d8932e5245782cda6fe0c0401cbd37cd815b58cc7c70552681d63511ded",
  );
  const specs = candidateChunks.map(candidateSpec);
  expect(specs.map((s) => s.to - s.from)).toEqual([
    2592000, 2592000, 2592000, 2592000,
  ]);
  expect(specs[1].from).toBe(specs[0].to);
  expect(specs[2].from).toBe(specs[1].to);
  expect(new Date(specs[2].to * 1000).toISOString()).toBe(
    "2024-10-11T00:00:00.000Z",
  );
  expect(() => candidateSpec("october" as any)).toThrow(
    "Unknown candidate chunk",
  );
});

test("continuation preserves the opening sample and begins raw capture after the retained edge block", async () => {
  const f = fixture();
  f.complete();
  const ranges: number[] = [],
    seen: number[] = [];
  f.args.chain.finalized = async () => h(end + 30 * 43200 + 10);
  f.args.chain.logs = async (from, to) => {
    ranges.push(from);
    return { logs: [], throughBlock: to };
  };
  const sample = f.args.sample;
  f.args.sample = async (t, b, a) => {
    seen.push(t);
    return sample(t, b, a);
  };
  const nextBounds = await prepareCandidate(f.args.chain, "august-30d-v1");
  const args = {
    ...f.args,
    bounds: nextBounds,
    chunk: "august-30d-v1" as const,
    maxSteps: 4,
  };
  await advanceCandidate(args);
  expect(ranges).toEqual([end + 1]);
  expect(seen).toEqual([spec.to]);
  expect(f.cursor?.startTimestamp).toBe(spec.from);
  expect(f.publication?.nextTimestamp).toBe(spec.to + 300);
  expect(f.previousReads).toEqual([spec.to]);
  await advanceCandidate({ ...args, maxSteps: 2 });
  expect(seen).toEqual([spec.to, spec.to + 300]);
});

test("continuation refuses missing predecessor samples without initializing a replacement cursor", async () => {
  const f = fixture();
  f.args.chain.finalized = async () => h(end + 30 * 43200 + 10);
  const nextBounds = await prepareCandidate(f.args.chain, "august-30d-v1");
  await expect(
    advanceCandidate({ ...f.args, bounds: nextBounds, chunk: "august-30d-v1" }),
  ).rejects.toThrow("Missing predecessor samples");
  expect(f.cursor).toBeNull();
});

test("continuation refuses a missing predecessor publication before collecting more blocks", async () => {
  const f = fixture();
  f.complete();
  f.args.chain.finalized = async () => h(end + 30 * 43200 + 10);
  f.args.sampled.publication = async () => null;
  await expect(
    advanceCandidate({
      ...f.args,
      bounds: await prepareCandidate(f.args.chain, "august-30d-v1"),
      chunk: "august-30d-v1",
    }),
  ).rejects.toThrow("Missing predecessor publication");
  expect(f.operations).toEqual([]);
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

test("November continues the four-pool dataset without changing deployed job identities", () => {
  expect(candidateChunks.slice(0, 4).map(candidateHash)).toEqual([
    "42692d8932e5245782cda6fe0c0401cbd37cd815b58cc7c70552681d63511ded",
    "ae1305f3410c1131761e17b5282ff5e7ae7e5dc8271285fff8bd6baa12671b8f",
    "f4870c9e20374307373939011f9a55042273d36bc681283cf2d0d1f6957d8ff3",
    "db998fa0bfb2ee1db2ac05e78d638c82a27615572bfdbb5119834952f4fd9a5e",
  ]);
  const october = candidateSpec("october-30d-v1"),
    november = candidateSpec("catchup-4-1733788800");
  expect(november.scopeId).not.toBe(october.scopeId);
  expect(november.policyRevision).not.toBe(october.policyRevision);
  expect(november.from).toBe(october.to);
  expect(new Date(november.to * 1000).toISOString()).toBe(
    "2024-12-10T00:00:00.000Z",
  );
});
