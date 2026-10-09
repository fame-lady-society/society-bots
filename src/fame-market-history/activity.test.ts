import { scope, metadata, epoch, fixtureRange } from "./worker-fixture.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";
import {
  activityEvent,
  valuedActivity,
  type ActivityRow,
} from "./activity-events.ts";
import {
  buildActivityIndex,
  activityKey,
  activityChunkKey,
  validateActivityIndex,
} from "./activity-storage.ts";
import { parseActivityRequest, readActivity } from "./activity-api.ts";
import {
  nextSampledPublication,
  type SampledPublication,
} from "./sampled-live.ts";
import { sampledMarketBucket, type PoolActivity } from "./sampled-market.ts";
import { sampledKey } from "./keys.ts";
import { FAME_ADDRESS, type Pool } from "./model.ts";
import { decode, EVENT_ABIS } from "./decode.ts";
import { encodeAbiParameters, encodeEventTopics, type AbiEvent } from "viem";
import { fraction, decimal } from "./price-math.ts";
import { rebuildActivity } from "./sampled-rebuild.ts";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
const h = `0x${"1".repeat(64)}` as const,
  a = `0x${"1".repeat(40)}` as const;
function action(
  pool: Pool,
  name: string,
  args: Record<string, unknown>,
  logIndex = 0,
) {
  const event = (
    EVENT_ABIS[
      pool.venueFamily as keyof typeof EVENT_ABIS
    ] as readonly AbiEvent[]
  ).find((e) => e.name === name)!;
  const raw = {
    address: pool.address,
    poolId: pool.id,
    blockNumber: 102,
    blockHash: h,
    transactionHash: h,
    transactionIndex: 0,
    logIndex,
    blockTimestamp: epoch + 120,
    removed: false,
    topics: encodeEventTopics({
      abi: [event],
      eventName: name,
      args,
    }) as `0x${string}`[],
    data: encodeAbiParameters(
      event.inputs.filter((x) => !x.indexed),
      event.inputs.filter((x) => !x.indexed).map((x) => args[x.name!]),
    ),
  };
  const m = {
    ...metadata,
    poolTokens: {
      ...metadata.poolTokens,
      [pool.id]: { token0: pool.token0, token1: pool.token1 },
    },
  };
  return activityEvent(decode(raw, pool, m), pool);
}
const p = scope.pools.find((p) => p.id === "scale-equalizer-weth-fame")!;
function rows(count = 3, t = epoch): ActivityRow[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `8453:${h}:${i}`,
        poolId: p.id,
        type: i % 2 ? "sell" : "buy",
        eventName: "Swap",
        timestamp: t + 120,
        blockNumber: 102 + (t - epoch) / 60,
        blockHash: h,
        transactionHash: h,
        transactionIndex: 0,
        logIndex: i,
        fameAtoms: "1000000000000000000",
        quoteAtoms: "2000000000000000000",
        quoteToken: p.token0 === FAME_ADDRESS ? p.token1 : p.token0,
        fameDecimals: 18,
        quoteDecimals: 18,
        values: {
          ETH: decimal(fraction(BigInt(i + 1), 1n)),
          USDC: decimal(fraction(BigInt(i + 1) * 2000n, 1n)),
        },
        sender: a,
        recipient: a,
        owner: null,
        valuationTimestamp: t + 300,
        valuationMethod: "bucket-end-spot",
      }) as ActivityRow,
  ).reverse();
}
const activity = (events: ActivityRow[]): PoolActivity[] => [
  {
    poolId: p.id,
    coverage: "complete",
    baseVolumeAtoms: "0",
    quoteVolumeAtoms: "0",
    tradeCount: 0,
    transactionHashes: [],
    activityEvents: events,
  },
];
test("actual ABI decoding distinguishes buy/sell in every family and either token orientation", () => {
  for (const source of scope.pools)
    for (const reverse of [false, true]) {
      const pool = reverse
        ? { ...source, token0: source.token1, token1: source.token0 }
        : source;
      const fame0 = pool.token0 === FAME_ADDRESS;
      for (const buy of [true, false]) {
        const fameDelta = buy ? -10n : 10n,
          quoteDelta = buy ? 20n : -20n;
        const [n0, n1] = fame0
          ? [fameDelta, quoteDelta]
          : [quoteDelta, fameDelta];
        const args =
          pool.venueFamily === "Slipstream"
            ? {
                sender: a,
                recipient: a,
                amount0: n0,
                amount1: n1,
                sqrtPriceX96: 2n ** 96n,
                liquidity: 10n,
                tick: 0,
              }
            : {
                sender: a,
                to: a,
                amount0In: n0 > 0n ? n0 : 0n,
                amount1In: n1 > 0n ? n1 : 0n,
                amount0Out: n0 < 0n ? -n0 : 0n,
                amount1Out: n1 < 0n ? -n1 : 0n,
              };
        expect(action(pool, "Swap", args)).toMatchObject({
          type: buy ? "buy" : "sell",
          fameAtoms: "10",
          quoteAtoms: "20",
        });
      }
    }
});
test("Mint/Burn are principal changes; Collect, Sync and zero liquidity pokes are not", () => {
  for (const pool of scope.pools) {
    const common = {
      sender: a,
      to: a,
      owner: a,
      tickLower: -10,
      tickUpper: 10,
      amount: 1n,
      amount0: 5n,
      amount1: 0n,
    };
    expect(action(pool, "Mint", common)?.type).toBe("add");
    expect(action(pool, "Burn", common)?.type).toBe("remove");
    if (pool.venueFamily === "Slipstream") {
      expect(action(pool, "Burn", { ...common, amount: 0n })).toBeNull();
      expect(action(pool, "Collect", { ...common, recipient: a })).toBeNull();
    } else
      expect(action(pool, "Sync", { reserve0: 1n, reserve1: 2n })).toBeNull();
  }
});
test("swap size counts one quote leg; liquidity sizes value both legs, missing routes stay null", () => {
  const o = deriveSampledObservation(scope, sampledFixture());
  o.rates[p.id] =
    p.token0 === FAME_ADDRESS ? fraction(3n, 1n) : fraction(1n, 3n);
  const events = rows(1);
  events[0].type = "buy";
  expect(valuedActivity(scope, o, activity(events))[0].values.ETH).toBe(
    "2.000000000000000000",
  );
  events[0].type = "add";
  expect(valuedActivity(scope, o, activity(events))[0].values.ETH).toBe(
    "5.000000000000000000",
  );
  for (const k of Object.keys(o.rates)) o.rates[k] = null;
  const v = valuedActivity(scope, o, activity(events))[0];
  expect(v.values).toEqual({ ETH: null, USDC: null });
  events[0].type = "buy";
  expect(valuedActivity(scope, o, activity(events))[0].values.ETH).toBe(
    "2.000000000000000000",
  );
});
test("archive replay deduplicates evidence while retaining distinct same-tx log identities", async () => {
  const f = await fixtureRange(99, 105, 102);
  const r = rebuildActivity(scope, metadata, [f, f], epoch, epoch + 300);
  expect(
    r.buckets.get(epoch)!.flatMap((p) => p.activityEvents ?? []),
  ).toHaveLength(1);
  const events = rows(2),
    o = deriveSampledObservation(scope, sampledFixture());
  expect(valuedActivity(scope, o, activity(events)).map((e) => e.id)).toEqual(
    events.map((e) => e.id),
  );
  expect(new Set(events.map((e) => e.transactionHash)).size).toBe(1);
  const clean = sampledMarketBucket(scope, "ETH", epoch, o, activity([]));
  expect(sampledMarketBucket(scope, "ETH", epoch, o, activity(events))).toEqual(
    clean,
  );
});
const key = (k: any) => `${k.pk}|${k.sk}`;
function fixture() {
  const data = new Map<string, any>(),
    reads: any[] = [];
  let current: SampledPublication | null = null;
  const append = (t: number, events = rows(3, t)) => {
    const e = sampledFixture(t),
      o = deriveSampledObservation(scope, e);
    current = nextSampledPublication(
      current,
      e,
      (["ETH", "USDC"] as const).map((c) =>
        sampledMarketBucket(scope, c, t, o, []),
      ),
    );
    const built = buildActivityIndex(t, events, "complete"),
      ref = current.pages.at(-1)!;
    const k = activityKey(current.policyRevision, ref);
    data.set(key(k), { ...k, body: JSON.stringify(built.index) });
    for (const page of built.pages)
      data.set(key(activityChunkKey(current.policyRevision, page.ref.sha256)), {
        body: page.body,
      });
    data.set(key(sampledKey(current.policyRevision, "published")), current);
    data.set(
      key(sampledKey(current.policyRevision, `manifest:${current.generation}`)),
      {
        body: JSON.stringify(current),
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      },
    );
  };
  const db = {
    send: async (command: any) => {
      reads.push(command.input);
      if (command.input.Key) return { Item: data.get(key(command.input.Key)) };
      return {
        Responses: {
          table: command.input.RequestItems.table.Keys.map((k: any) =>
            data.get(key(k)),
          )
            .filter(Boolean)
            .reverse(),
        },
      };
    },
  } as unknown as DynamoDBDocumentClient;
  append(epoch);
  return {
    db,
    data,
    reads,
    append,
    get current() {
      return current!;
    },
  };
}
const req = {
  currency: "ETH" as const,
  from: epoch,
  to: epoch + 86400,
  type: "all" as const,
  limit: 2,
};
test("snapshot pagination retains every same-tx event across a live append", async () => {
  const f = fixture();
  const first = await readActivity(f.db, "table", scope, req);
  expect(first.rows.map((e) => e.logIndex)).toEqual([2, 1]);
  expect(first.nextCursor).not.toBeNull();
  f.append(epoch + 300);
  const second = await readActivity(f.db, "table", scope, {
    ...req,
    cursor: first.nextCursor!,
  });
  expect(second.rows.map((e) => e.logIndex)).toEqual([0]);
  expect(second.nextCursor).toBeNull();
  expect(second.publicationId).toBe(first.publicationId);
  expect(second.rows[0]).not.toHaveProperty("values");
  await expect(
    readActivity(f.db, "table", scope, {
      ...req,
      currency: "USDC",
      cursor: first.nextCursor!,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const k = sampledKey(
    f.current.policyRevision,
    `manifest:${first.publicationId}`,
  );
  f.data.delete(key(k));
  await expect(
    readActivity(f.db, "table", scope, { ...req, cursor: first.nextCursor! }),
  ).rejects.toMatchObject({ status: 409 });
});
test("inclusive exact size, pool and type filters apply without treating missing prices as zero", async () => {
  const f = fixture();
  const result = await readActivity(f.db, "table", scope, {
    ...req,
    type: "sell",
    min: "2",
    max: "2.000000000000000000",
    pool: p.id,
  });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].size).toBe("2.000000000000000000");
  const r = rows(1, epoch + 300);
  r[0].values.ETH = null;
  f.append(epoch + 300, r);
  expect(
    (await readActivity(f.db, "table", scope, { ...req, min: "0", limit: 100 }))
      .rows,
  ).toHaveLength(3);
  expect(
    (await readActivity(f.db, "table", scope, { ...req, limit: 100 })).rows,
  ).toHaveLength(4);
});
test("sparse scans are bounded and return an advancing cursor even when empty", async () => {
  const f = fixture();
  for (let i = 1; i < 18; i++) f.append(epoch + i * 300, []);
  const page = await readActivity(f.db, "table", scope, req);
  expect(page.rows).toHaveLength(0);
  expect(page.nextCursor).not.toBeNull();
  expect(page.scanned.indexesRead).toBe(16);
  const next = await readActivity(f.db, "table", scope, {
    ...req,
    cursor: page.nextCursor!,
  });
  expect(next.rows).toHaveLength(2);
  expect(
    f.reads
      .filter((r) => r.RequestItems)
      .every((r) => r.RequestItems.table.Keys.length <= 16),
  ).toBe(true);
});
test("chunk scan limits are resumable and corrupted chunks fail closed", async () => {
  const f = fixture();
  f.append(epoch + 300, rows(901, epoch + 300));
  const page = await readActivity(f.db, "table", scope, {
    ...req,
    type: "add",
  });
  expect(page.rows).toHaveLength(0);
  expect(page.scanned.chunks).toBe(0);
  const scan = await readActivity(f.db, "table", scope, {
    ...req,
    pool: scope.pools.find((x) => x.id !== p.id)!.id,
  });
  expect(scan.scanned.chunks).toBe(8);
  expect(scan.nextCursor).not.toBeNull();
  const chunk = [...f.data.keys()].find((k) => k.startsWith("activity-chunk"))!;
  f.data.set(chunk, { body: "[]" });
  await expect(
    readActivity(f.db, "table", scope, { ...req, to: epoch + 300 }),
  ).rejects.toThrow("checksum");
});
test("missing indexes are explicit gaps; index validation rejects invalid counts and maxima", async () => {
  const f = fixture();
  f.data.delete(key(activityKey(f.current.policyRevision, f.current.pages[0])));
  expect(
    (await readActivity(f.db, "table", scope, req)).coverage.unavailableBuckets,
  ).toEqual(
    expect.arrayContaining([
      { timestamp: epoch, reason: "activity-not-indexed" },
      { timestamp: epoch + 300, reason: "not-published" },
    ]),
  );
  const { index } = buildActivityIndex(epoch, rows(), "complete");
  expect(validateActivityIndex(index)).toEqual(index);
  expect(() => validateActivityIndex({ ...index, count: 42 })).toThrow();
  expect(() =>
    validateActivityIndex({
      ...index,
      chunks: [{ ...index.chunks[0], max: { ETH: "oops", USDC: null } }],
    }),
  ).toThrow();
});
test("queries reject unknown/duplicate parameters, oversized windows and inconsistent bounds", () => {
  const q = `view=activity&currency=ETH&from=${epoch}&to=${epoch + 300}&resolution=300`;
  expect(parseActivityRequest(q, scope)).toMatchObject({
    type: "all",
    limit: 50,
  });
  for (const suffix of [
    "&type=oops",
    "&pool=",
    "&min=-1",
    "&min=1e3",
    "&min=2&max=1",
    "&limit=101",
    "&currency=USDC",
    "&cursor=%%%",
    "&surprise=1",
  ])
    expect(() => parseActivityRequest(q + suffix, scope)).toThrow();
});

test("unprocessed metadata retries only missing keys and stops after three attempts", async () => {
  const f = fixture();
  let attempts = 0;
  const db = {
    send: async (command: any) => {
      if (command.input.Key) return f.db.send(command);
      attempts++;
      return { UnprocessedKeys: command.input.RequestItems };
    },
  } as unknown as DynamoDBDocumentClient;
  await expect(readActivity(db, "table", scope, req)).rejects.toMatchObject({
    status: 503,
    code: "history-read-budget-exceeded",
  });
  expect(attempts).toBe(3);
  const evil = {
    send: async (command: any) =>
      command.input.Key
        ? f.db.send(command)
        : {
            UnprocessedKeys: {
              table: { Keys: [{ pk: "unrelated", sk: "key" }] },
            },
          },
  } as unknown as DynamoDBDocumentClient;
  await expect(readActivity(evil, "table", scope, req)).rejects.toThrow(
    "Invalid unprocessed",
  );
});
test("an index cannot become visible before all immutable chunks are saved", async () => {
  const { writeActivity } = await import("./activity-storage.ts");
  const f = fixture(),
    writes: any[] = [];
  const db = {
    send: async (command: any) => {
      writes.push(command.input);
      if (command.input.Item.pk.startsWith("activity-chunk"))
        throw new Error("injected write failure");
    },
  } as unknown as DynamoDBDocumentClient;
  await expect(
    writeActivity(
      db,
      "table",
      f.current.policyRevision,
      f.current.pages[0],
      rows(201),
      "complete",
    ),
  ).rejects.toThrow("injected");
  expect(writes.every((w) => w.Item.pk.startsWith("activity-chunk"))).toBe(
    true,
  );
  const successful = {
    send: async (command: any) => {
      writes.push(command.input);
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  writes.length = 0;
  await writeActivity(
    successful,
    "table",
    f.current.policyRevision,
    f.current.pages[0],
    rows(201),
    "complete",
  );
  expect(writes).toHaveLength(4);
  expect(writes.at(-1).Item.pk.startsWith("activity:fame-activity-v1")).toBe(
    true,
  );
  expect(
    writes.every(
      (w) =>
        w.ConditionExpression === "attribute_not_exists(pk) OR body = :body",
    ),
  ).toBe(true);
});
test("partial quiet bucket coverage is not skipped when normalizing a full page cursor", async () => {
  const f = fixture();
  const old = activityKey(f.current.policyRevision, f.current.pages[0]);
  const index = buildActivityIndex(epoch, [], "partial").index;
  f.data.set(key(old), { ...old, body: JSON.stringify(index) });
  f.append(epoch + 300, rows(2, epoch + 300));
  const first = await readActivity(f.db, "table", scope, req);
  expect(first.nextCursor).not.toBeNull();
  const second = await readActivity(f.db, "table", scope, {
    ...req,
    cursor: first.nextCursor!,
  });
  expect(second.coverage.partialBuckets).toEqual([epoch]);
});

test("historical activity pagination pins a dated generation across repairs", async () => {
  const { dayPublication, utcDay, updateDay } = await import(
    "./dated-publication.ts"
  );
  const f = fixture(),
    revision = f.current.policyRevision;
  const original = dayPublication(revision, utcDay(epoch), f.current.pages);
  const dayKey = key(sampledKey(revision, `day:${original.day}`));
  f.data.set(dayKey, { body: JSON.stringify(original) });
  const e = sampledFixture(epoch + 86400);
  const live = nextSampledPublication(
    null,
    e,
    (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(
        scope,
        c,
        e.timestamp,
        deriveSampledObservation(scope, e),
        [],
      ),
    ),
  );
  f.data.set(key(sampledKey(revision, "published")), live);
  const request = { ...req, to: epoch + 600, limit: 1 };
  const first = await readActivity(f.db, "table", scope, request);
  expect(first.rows).toHaveLength(1);
  expect(first.nextCursor).not.toBeNull();
  f.data.set(key(sampledKey(revision, `day-manifest:${original.generation}`)), {
    body: JSON.stringify(original),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  });
  // A new adjacent bucket would shift descending page offsets without a pinned directory.
  f.data.set(dayKey, {
    body: JSON.stringify(
      updateDay(original, revision, {
        ...original.pages[0],
        timestamp: epoch + 300,
      }),
    ),
  });
  const second = await readActivity(f.db, "table", scope, {
    ...request,
    cursor: first.nextCursor!,
  });
  expect(second.rows[0].id).not.toBe(first.rows[0].id);
  expect(second.rows[0].transactionHash).toBe(first.rows[0].transactionHash);
  expect(second.publicationId).toBe(first.publicationId);
});
