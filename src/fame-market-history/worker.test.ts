import {
  aggregateNext,
  LEASE_MS,
  type AggregationStore,
  type Publication,
} from "./worker.ts";
import { digest } from "./model.ts";
import { type Candle } from "./analytics.ts";
import { buildHistory } from "./analytics.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  scope,
  metadata,
  pool,
  epoch,
  fixtureRange,
} from "./worker-fixture.ts";

class Store implements AggregationStore {
  nextBlock = 100;
  leaseUntil = 0;
  owner = "";
  revision = "";
  clock = 1000;
  fail = "";
  completed = new Set<number>();
  objects = new Map<string, Uint8Array>();
  candles = new Map<string, Candle>();
  partitions = new Map<number, Publication>();
  constructor(public ranges: Awaited<ReturnType<typeof fixtureRange>>[]) {}
  async acquire(
    _scope: string,
    _start: number,
    revision: string,
    owner: string,
    now: number,
  ) {
    if (this.revision && revision !== this.revision)
      throw Error("metadata revision");
    if (this.leaseUntil > now) return null;
    this.owner = owner;
    this.revision = revision;
    this.leaseUntil = now + LEASE_MS;
    return {
      nextBlock: this.nextBlock,
      collectedThrough: this.ranges.at(-1)!.manifest.toBlock,
    };
  }
  async pending(_scope: string, next: number) {
    return (
      this.ranges.find((r) => r.manifest.fromBlock === next)?.manifest ?? null
    );
  }
  async previous(_scope: string, before: number) {
    return (
      this.ranges.filter((r) => r.manifest.fromBlock < before).at(-1)
        ?.manifest ?? null
    );
  }
  async read(manifest: { fromBlock: number }) {
    return this.ranges.find((r) => r.manifest.fromBlock === manifest.fromBlock)!
      .bytes;
  }
  async upload(key: string, bytes: Uint8Array) {
    this.objects.set(key, bytes);
    if (this.fail === "upload") throw Error("crash after upload");
  }
  async publish(p: Publication) {
    if (this.fail === "before") throw Error("crash before commit");
    if (this.fail === "expire") this.clock += LEASE_MS;
    if (
      p.owner !== this.owner ||
      this.leaseUntil <= this.clock ||
      p.target.fromBlock !== this.nextBlock
    )
      throw Error("fenced");
    for (const c of p.candles)
      this.candles.set(`${c.poolId}:${c.timestamp}`, c);
    this.partitions.set(p.target.fromBlock, p);
    this.completed.add(p.target.fromBlock);
    this.nextBlock = p.target.toBlock + 1;
    this.leaseUntil = 0;
    this.owner = "";
    if (this.fail === "after") throw Error("lost commit response");
  }
  async release(_scope: string, owner: string) {
    if (owner !== this.owner) throw Error("fenced");
    this.leaseUntil = 0;
    this.owner = "";
  }
  run() {
    return aggregateNext({
      scope,
      startBlock: 100,
      metadata,
      store: this,
      now: () => this.clock,
    });
  }
}

test.each([0, 600])(
  "aligned boundary and timestamp jump (%s seconds) match a full rebuild",
  async (timeShift) => {
    const ranges = [
      await fixtureRange(100, 109, 106),
      await fixtureRange(110, 114, 111, 3n, timeShift),
    ];
    const store = new Store(ranges);
    await store.run();
    await store.run();
    const directory = await mkdtemp(
      path.join(tmpdir(), "history-boundary-review-"),
    );
    try {
      const full = await buildHistory(
        ranges,
        metadata,
        path.join(directory, "full"),
      );
      for (const candle of full.dataset.candles[300])
        expect(
          store.candles.get(`${candle.poolId}:${candle.timestamp}`),
        ).toEqual(candle);
      expect(store.candles.get(`${pool.id}:${epoch + 300}`)?.coverage).toBe(
        "complete",
      );
      if (timeShift)
        for (const offset of [600, 900])
          expect(
            store.candles.get(`${pool.id}:${epoch + offset}`),
          ).toMatchObject({ coverage: "complete", tradeCount: 0 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("adjacent archives replace a boundary candle; canonical partitions do not overlap", async () => {
  const store = new Store([
    await fixtureRange(100, 107, 106),
    await fixtureRange(108, 114, 109, 3n),
  ]);
  await store.run();
  expect(store.candles.get(`${pool.id}:${epoch + 300}`)).toMatchObject({
    tradeCount: 1,
    coverage: "partial",
  });
  expect(await store.run()).toMatchObject({
    status: "published",
    inputRanges: 2,
  });
  expect(store.candles.get(`${pool.id}:${epoch + 300}`)).toMatchObject({
    tradeCount: 2,
    open: "2.000000000000000000",
    close: "3.000000000000000000",
    baseVolumeAtoms: "2000000000000000000",
    coverage: "complete",
  });
  const evidenceKey = store.partitions
    .get(108)!
    .artifacts.find((a) => a.key.endsWith("evidence.json"))!.key;
  const evidence = JSON.parse(
    Buffer.from(store.objects.get(evidenceKey)!).toString(),
  );
  expect(evidence.eventCount).toBe(1);
  expect(
    evidence.ranges.map((r: { fromBlock: number }) => r.fromBlock),
  ).toEqual([108]);
  expect(await store.run()).toEqual({
    status: "caught-up",
    aggregationLagBlocks: 0,
  });
});

test.each(["upload", "before"])(
  "%s failure leaves no published progress and retry is exact",
  async (failure) => {
    const store = new Store([await fixtureRange(100, 110, 106)]);
    store.fail = failure;
    await expect(store.run()).rejects.toThrow("crash");
    expect(store.objects.size).toBeGreaterThan(0);
    expect(store.candles.size).toBe(0);
    expect(store.nextBlock).toBe(100);
    expect(store.completed.size).toBe(0);
    expect(await store.run()).toEqual({ status: "busy" });
    store.fail = "";
    store.clock += LEASE_MS + 1;
    await store.run();
    expect(store.candles.get(`${pool.id}:${epoch + 300}`)?.tradeCount).toBe(1);
    expect(store.nextBlock).toBe(111);
    for (const p of store.partitions.values())
      for (const a of p.artifacts)
        expect(digest(store.objects.get(a.key)!)).toBe(a.sha256);
  },
);

test("lost transaction response cannot duplicate volume on retry", async () => {
  const store = new Store([await fixtureRange(100, 110, 106)]);
  store.fail = "after";
  await expect(store.run()).rejects.toThrow("lost");
  store.fail = "";
  expect(await store.run()).toEqual({
    status: "caught-up",
    aggregationLagBlocks: 0,
  });
  expect(store.candles.get(`${pool.id}:${epoch + 300}`)?.tradeCount).toBe(1);
});

test("an expired worker cannot publish or mark pending work done", async () => {
  const store = new Store([await fixtureRange(100, 110, 106)]);
  store.fail = "expire";
  await expect(store.run()).rejects.toThrow("fenced");
  expect(store.candles.size).toBe(0);
  expect(store.nextBlock).toBe(100);
});

test("missing candle context and changed metadata fail rather than degrading results", async () => {
  const store = new Store([
    await fixtureRange(100, 107, 106),
    await fixtureRange(108, 114, 109),
  ]);
  await store.run();
  store.ranges.shift();
  await expect(store.run()).rejects.toThrow("Missing adjacent");
  expect(store.nextBlock).toBe(108);
  store.clock += LEASE_MS + 1;
  await expect(
    aggregateNext({
      scope,
      startBlock: 100,
      metadata: { ...metadata, blockNumber: 101 },
      store,
      now: () => store.clock,
    }),
  ).rejects.toThrow("metadata");
});

test("a timestamp gap exceeding atomic capacity remains visible without advancing progress", async () => {
  const store = new Store([
    await fixtureRange(100, 109, 106),
    await fixtureRange(110, 114, 112, 3n, 300 * 91),
  ]);
  await store.run();
  const candles = [...store.candles.entries()];
  await expect(store.run()).rejects.toThrow("operator reconciliation required");
  expect(store.nextBlock).toBe(110);
  expect([...store.candles.entries()]).toEqual(candles);
});
