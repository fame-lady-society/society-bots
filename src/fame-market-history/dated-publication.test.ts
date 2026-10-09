import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  dayPublication,
  updateDay,
  validateDay,
  dayWrites,
  utcDay,
  validateSources,
} from "./dated-publication.ts";
import { sampledReader } from "./sampled-reader.ts";
import { sampledKey, sampledPageKey } from "./keys.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { scope, epoch } from "./worker-fixture.ts";
import { sampledMarketBucket } from "./sampled-market.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";
import { nextSampledPublication } from "./sampled-live.ts";
import { readChart } from "./chart-api.ts";
const key = (k: any) => `${k.pk}|${k.sk}`;
function fixture() {
  const rows = new Map<string, any>(),
    reads: string[] = [];
  const make = (t: number) => {
    const e = sampledFixture(t),
      o = deriveSampledObservation(scope, e);
    const buckets = (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(scope, c, t, o, []),
    );
    const p = nextSampledPublication(null, e, buckets);
    for (const b of buckets) {
      const k = sampledPageKey(
        p.policyRevision,
        b.currency,
        t,
        p.pages[0][b.currency],
      );
      rows.set(key(k), { ...k, body: JSON.stringify(b) });
    }
    return p;
  };
  const old = make(epoch),
    live = make(epoch + 86400),
    revision = old.policyRevision;
  rows.set(key(sampledKey(revision, "published")), live);
  let day = dayPublication(revision, utcDay(epoch), old.pages);
  const save = () =>
    rows.set(key(sampledKey(revision, `day:${day.day}`)), {
      body: JSON.stringify(day),
    });
  save();
  const db = {
    send: async (c: any) => {
      if (c.input.Key) {
        reads.push(c.input.Key.sk);
        return { Item: rows.get(key(c.input.Key)) };
      }
      reads.push("pages");
      return {
        Responses: {
          table: c.input.RequestItems.table.Keys.map((k: any) =>
            rows.get(key(k)),
          ).filter(Boolean),
        },
      };
    },
  } as unknown as DynamoDBDocumentClient;
  return {
    rows,
    reads,
    db,
    revision,
    old,
    live,
    make,
    get day() {
      return day;
    },
    set day(p) {
      day = p;
      save();
    },
  };
}
test("dated directories are sparse, canonical, checked and permanent; snapshots expire", () => {
  const f = fixture(),
    d = updateDay(f.day, f.revision, f.make(epoch + 600).pages[0]);
  expect(d.pages.map((p) => p.timestamp)).toEqual([epoch, epoch + 600]);
  expect(validateDay(d, f.revision, d.day)).toEqual(d);
  expect(() =>
    validateDay({ ...d, generation: "0".repeat(64) }, f.revision, d.day),
  ).toThrow();
  expect(() =>
    dayPublication(f.revision, d.day, [...d.pages, d.pages[0]]),
  ).toThrow();
  const writes = dayWrites("table", f.day, d, 1000);
  expect(writes.at(-1)!.Put!.Item!.expiresAt).toBeUndefined();
  expect(writes.at(-1)!.Put!.ConditionExpression).toBe("body = :old");
  expect(writes[0].Put!.Item!.expiresAt).toBe(86401);
});
test("historical chart reads real pages, returns gaps and unchanged delta without page reads", async () => {
  const f = fixture(),
    request = {
      currency: "ETH" as const,
      series: "market",
      from: epoch,
      to: epoch + 600,
    };
  const first = await readChart(f.db, "table", scope, request);
  expect(first.upserts).toHaveLength(2);
  expect(first.upserts[0].publicationStatus).toBe("published");
  f.reads.length = 0;
  const delta = await readChart(f.db, "table", scope, {
    ...request,
    cursor: first.cursor,
  });
  expect(delta.upserts).toEqual([]);
  expect(f.reads).not.toContain("pages");
  // A later live append does not invalidate this historical result.
  f.rows.set(key(sampledKey(f.revision, "published")), f.make(epoch + 86700));
  expect((await readChart(f.db, "table", scope, request)).publicationId).toBe(
    first.publicationId,
  );
});
test("a repaired historical gap produces one delta and retains pinned snapshots", async () => {
  const f = fixture(),
    request = {
      currency: "USDC" as const,
      series: "market",
      from: epoch,
      to: epoch + 900,
    };
  const first = await readChart(f.db, "table", scope, request);
  f.rows.set(key(sampledKey(f.revision, `day-manifest:${f.day.generation}`)), {
    body: JSON.stringify(f.day),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  });
  f.day = updateDay(f.day, f.revision, f.make(epoch + 600).pages[0]);
  const delta = await readChart(f.db, "table", scope, {
    ...request,
    cursor: first.cursor,
  });
  expect(delta.upserts.map((b) => b.timestamp)).toEqual([epoch + 600]);
  f.rows.delete(
    key(
      sampledKey(
        f.revision,
        `day-manifest:${JSON.parse(Buffer.from(first.cursor, "base64url").toString()).sources[0].generation}`,
      ),
    ),
  );
  await expect(
    readChart(f.db, "table", scope, { ...request, cursor: first.cursor }),
  ).rejects.toMatchObject({ status: 409 });
});
test("live fast path remains one read and source ordering is validated", async () => {
  const f = fixture();
  await sampledReader(f.db, "table", f.revision).window(
    epoch + 86400,
    epoch + 86700,
  );
  expect(f.reads).toEqual(["published"]);
  expect(() => validateSources([{ key: "day:1", generation: null }])).toThrow();
  const sources = [
    { key: "published", generation: f.live.generation },
    { key: `day:${utcDay(epoch)}`, generation: null },
  ];
  await expect(
    sampledReader(f.db, "table", f.revision).window(
      epoch,
      epoch + 300,
      sources,
    ),
  ).rejects.toThrow();
});

test("24-hour reads cross UTC days and join live without duplicate references", async () => {
  const f = fixture(),
    from = epoch,
    to = epoch + 86400;
  const secondTime = utcDay(epoch) + 86400;
  const second = f.make(secondTime);
  f.rows.set(key(sampledKey(f.revision, `day:${secondTime}`)), {
    body: JSON.stringify(dayPublication(f.revision, secondTime, second.pages)),
  });
  // Live owns overlap with a day, rather than adding a duplicate.
  f.rows.set(key(sampledKey(f.revision, "published")), second);
  const window = await sampledReader(f.db, "table", f.revision).window(
    from,
    to,
  );
  expect(window.pages.map((p) => p.timestamp)).toEqual([epoch, secondTime]);
  expect(f.reads).toEqual([
    "published",
    `day:${utcDay(epoch)}`,
    `day:${secondTime}`,
  ]);
  const historical =
    window as import("./dated-publication.ts").WindowPublication;
  expect(historical.sources).toHaveLength(3);
  const pinned = await sampledReader(f.db, "table", f.revision).window(
    from,
    to,
    historical.sources,
  );
  expect(pinned).toEqual(window);
});
