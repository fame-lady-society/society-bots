import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { launchScope } from "./local-backfill.ts";
import { octoberScope } from "./october-scope.ts";
import { candidateSpec } from "./candidate.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";
import { sampledPolicy, sampledMarketBucket } from "./sampled-market.ts";
import {
  nextSampledPublication,
  type SampledPublication,
} from "./sampled-live.ts";
import { sampledKey, sampledPageKey } from "./keys.ts";
import { dayPublication, utcDay } from "./dated-publication.ts";
import { historyReader } from "./history-reader.ts";
import { readChart } from "./chart-api.ts";
import { readActivity } from "./activity-api.ts";
import {
  activityKey,
  activityChunkKey,
  buildActivityIndex,
} from "./activity-storage.ts";
import type { ActivityRow } from "./activity-events.ts";
import { validateHistory } from "./dataset.ts";
const source = launchScope(),
  target = octoberScope(),
  boundary = candidateSpec("october-30d-v1").from;
const oldRevision = sampledPolicy(source).revision,
  newRevision = sampledPolicy(target).revision;
const history = [
  { from: 0, to: boundary, scopeId: source.id, policyRevision: oldRevision },
];
const key = (k: any) => `${k.pk}|${k.sk}`;
function fixture() {
  const data = new Map<string, any>(),
    reads: string[] = [];
  const publications = new Map<string, SampledPublication>();
  const append = (t: number) => {
    const scope = t < boundary ? source : target,
      revision = sampledPolicy(scope).revision;
    const e = sampledFixture(t, scope),
      o = deriveSampledObservation(scope, e);
    const buckets = (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(
        scope,
        c,
        t,
        o,
        [],
        deriveSampledObservation(scope, sampledFixture(t - 300, scope)),
      ),
    );
    const previous = publications.get(revision) ?? null;
    const p = nextSampledPublication(previous, e, buckets);
    publications.set(revision, p);
    for (const b of buckets) {
      const k = sampledPageKey(
        revision,
        b.currency,
        t,
        p.pages.at(-1)![b.currency],
      );
      data.set(key(k), { ...k, body: JSON.stringify(b) });
    }
    data.set(key(sampledKey(revision, "published")), p);
    const day = dayPublication(
      revision,
      utcDay(t),
      p.pages.filter((r) => utcDay(r.timestamp) === utcDay(t)),
    );
    data.set(key(sampledKey(revision, `day:${utcDay(t)}`)), {
      body: JSON.stringify(day),
    });
    for (const snapshot of [previous, p].filter(
      Boolean,
    ) as SampledPublication[])
      data.set(key(sampledKey(revision, `manifest:${snapshot.generation}`)), {
        body: JSON.stringify(snapshot),
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      });
    const row = {
      id: `event:${t}`,
      poolId: source.pools[0].id,
      timestamp: t + 120,
      type: t < boundary ? "buy" : "sell",
      values: { ETH: "1.000000000000000000", USDC: "2000.000000000000000000" },
    } as ActivityRow;
    const built = buildActivityIndex(t, [row], "complete"),
      k = activityKey(revision, p.pages.at(-1)!);
    data.set(key(k), { ...k, body: JSON.stringify(built.index) });
    for (const c of built.pages)
      data.set(key(activityChunkKey(revision, c.ref.sha256)), { body: c.body });
  };
  const db = {
    send: async (c: any) => {
      if (c.input.Key) {
        reads.push(key(c.input.Key));
        return { Item: data.get(key(c.input.Key)) };
      }
      if (c.input.KeyConditionExpression) {
        const prefix = c.input.ExpressionAttributeValues[":pk"] + "|day:";
        const entry = [...data]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))[0];
        return {
          Items: entry ? [{ ...entry[1], sk: entry[0].split("|")[1] }] : [],
        };
      }
      const keys = c.input.RequestItems.table.Keys;
      reads.push(...keys.map(key));
      return {
        Responses: {
          table: keys.map((k: any) => data.get(key(k))).filter(Boolean),
        },
      };
    },
  } as unknown as DynamoDBDocumentClient;
  append(boundary - 600);
  append(boundary - 300);
  return { db, data, reads, append, publications };
}
const request = {
  from: boundary - 600,
  to: boundary + 600,
  currency: "ETH" as const,
  series: "market",
};
test.each(["ETH", "USDC"] as const)(
  "%s chart preserves old bytes and stitches new pages with deltas",
  async (currency) => {
    const f = fixture(),
      before = JSON.stringify([...f.data]);
    const first = await readChart(
      f.db,
      "table",
      target,
      { ...request, currency },
      Date.now,
      undefined,
      history,
    );
    expect(first.upserts.map((b) => b.publicationStatus)).toEqual([
      "published",
      "published",
      "not-yet-published",
      "not-yet-published",
    ]);
    expect(JSON.stringify([...f.data])).toBe(before);
    const oldKeys = [...f.data.keys()];
    const oldValues = oldKeys.map((k) => JSON.stringify(f.data.get(k)));
    f.append(boundary);
    const delta = await readChart(
      f.db,
      "table",
      target,
      { ...request, currency, cursor: first.cursor },
      Date.now,
      undefined,
      history,
    );
    expect(delta.upserts.map((b) => b.timestamp)).toEqual([boundary]);
    expect(oldKeys.map((k) => JSON.stringify(f.data.get(k)))).toEqual(
      oldValues,
    );
    const single = await readChart(f.db, "table", source, {
      ...request,
      currency,
      to: boundary,
    });
    expect(first.upserts.slice(0, 2)).toEqual(single.upserts);
    const idle = await readChart(
      f.db,
      "table",
      target,
      { ...request, currency, cursor: delta.cursor },
      Date.now,
      undefined,
      history,
    );
    expect(idle.upserts).toEqual([]);
  },
);
test("activity pagination crosses the policy boundary without skips or duplicates", async () => {
  const f = fixture();
  f.append(boundary);
  f.append(boundary + 300);
  const req = { ...request, type: "all" as const, limit: 1 };
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const p = await readActivity(
      f.db,
      "table",
      target,
      { ...req, ...(cursor ? { cursor } : {}) },
      Date.now,
      history,
    );
    ids.push(...p.rows.map((r) => r.id));
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toEqual(
    [boundary + 300, boundary, boundary - 300, boundary - 600].map(
      (t) => `event:${t}`,
    ),
  );
  const filtered = await readActivity(
    f.db,
    "table",
    target,
    { ...req, type: "buy", min: "0.5", limit: 100 },
    Date.now,
    history,
  );
  expect(filtered.rows.map((r) => r.id)).toEqual(
    [boundary - 300, boundary - 600].map((t) => `event:${t}`),
  );
});
test("availability exposes the original earliest boundary before current publication exists", async () => {
  const f = fixture(),
    reader = historyReader(f.db, "table", newRevision, Date.now, history);
  expect(await reader.availability(boundary - 600)).toMatchObject({
    earliestAvailableTimestamp: boundary - 600,
    latestAvailableTimestamp: boundary - 300,
    hasEarlier: false,
  });
  f.append(boundary);
  expect(await reader.availability(boundary)).toMatchObject({
    latestAvailableTimestamp: boundary,
    hasEarlier: true,
  });
});
test("a new pool queried before its creation remains an explicit zero-volume gap", async () => {
  const f = fixture();
  const p = await readChart(
    f.db,
    "table",
    target,
    { ...request, to: boundary, series: "aerodrome-spx-fame" },
    Date.now,
    undefined,
    history,
  );
  expect(
    p.upserts.every((b) => b.reason === "not-yet-created" && b.volume === "0"),
  ).toBe(true);
});
test("untrusted cursor revisions cannot select another stored dataset", async () => {
  const f = fixture();
  const p = await readChart(
    f.db,
    "table",
    target,
    request,
    Date.now,
    undefined,
    history,
  );
  const c = JSON.parse(Buffer.from(p.cursor, "base64url").toString());
  c.sources[0].revision = "f".repeat(64);
  c.generation = "a".repeat(64);
  await expect(
    readChart(
      f.db,
      "table",
      target,
      {
        ...request,
        cursor: Buffer.from(JSON.stringify(c)).toString("base64url"),
      },
      Date.now,
      undefined,
      history,
    ),
  ).rejects.toMatchObject({ status: 400 });
});
test("membership rejects overlapping, gapped and duplicate revisions", () => {
  for (const entry of [
    { ...history[0], from: 300 },
    { ...history[0], to: 301 },
  ])
    expect(() => validateHistory([entry])).toThrow();
  expect(() =>
    validateHistory([
      ...history,
      { ...history[0], from: boundary, to: boundary + 300 },
    ]),
  ).toThrow();
});
