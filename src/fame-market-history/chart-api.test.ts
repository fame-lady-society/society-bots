import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { readChart, parseChartRequest } from "./chart-api.ts";
import { scope, epoch } from "./worker-fixture.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";
import { sampledMarketBucket } from "./sampled-market.ts";
import {
  nextSampledPublication,
  type SampledPublication,
} from "./sampled-live.ts";
import { sampledKey, sampledPageKey } from "./keys.ts";
import { sampledReader } from "./sampled-reader.ts";
import { digest } from "./model.ts";
const key = (k: any) => `${k.pk}|${k.sk}`;
function fixture() {
  const data = new Map<string, any>(),
    reads: string[] = [];
  let current: SampledPublication | null = null;
  const append = (t: number) => {
    const e = sampledFixture(t),
      o = deriveSampledObservation(scope, e);
    const rows = (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(
        scope,
        c,
        t,
        o,
        [],
        deriveSampledObservation(scope, sampledFixture(t - 300)),
      ),
    );
    current = nextSampledPublication(current, e, rows);
    for (const b of rows) {
      const k = sampledPageKey(
        current.policyRevision,
        b.currency,
        t,
        current.pages.at(-1)![b.currency],
      );
      data.set(key(k), { ...k, body: JSON.stringify(b) });
    }
    save();
  };
  const save = () => {
    data.set(key(sampledKey(current!.policyRevision, "published")), current);
    data.set(
      key(
        sampledKey(current!.policyRevision, `manifest:${current!.generation}`),
      ),
      {
        body: JSON.stringify(current),
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      },
    );
  };
  const db = {
    send: async (command: any) => {
      if (command.input.Key) return { Item: data.get(key(command.input.Key)) };
      const keys = command.input.RequestItems.table.Keys;
      reads.push(...keys.map(key));
      return {
        Responses: {
          table: keys
            .map((k: any) => data.get(key(k)))
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
    save,
    get current() {
      return current!;
    },
    set current(p) {
      current = p;
    },
  };
}
const req = {
  currency: "USDC" as const,
  series: "market",
  from: epoch,
  to: epoch + 600,
};
test("snapshot, idle, append and historical repair read only necessary immutable pages", async () => {
  const f = fixture();
  const a = await readChart(f.db, "table", scope, req);
  expect(a.upserts).toHaveLength(2);
  expect(f.reads).toHaveLength(1);
  f.reads.length = 0;
  const idle = await readChart(f.db, "table", scope, {
    ...req,
    cursor: a.cursor,
  });
  expect(idle.upserts).toEqual([]);
  expect(f.reads).toHaveLength(0);
  f.append(epoch + 300);
  const delta = await readChart(f.db, "table", scope, {
    ...req,
    cursor: a.cursor,
  });
  expect(delta.upserts.map((b) => b.timestamp)).toEqual([epoch + 300]);
  expect(f.reads).toHaveLength(1);
  // Replace an older bucket with the same timestamp: no latest-timestamp cursor can detect this.
  const old = f.current.pages[0],
    k = sampledPageKey(f.current.policyRevision, "USDC", epoch, old.USDC),
    body = JSON.parse(f.data.get(key(k)).body);
  body.market.price = "1.000000000000000000";
  const bytes = JSON.stringify(body),
    sha = digest(bytes),
    replacement = sampledPageKey(f.current.policyRevision, "USDC", epoch, sha);
  f.data.set(key(replacement), { ...replacement, body: bytes });
  const { generation: _, ...manifest } = f.current;
  manifest.pages = manifest.pages.map((p, i) => (i ? p : { ...p, USDC: sha }));
  f.current = { ...manifest, generation: digest(JSON.stringify(manifest)) };
  f.save();
  f.reads.length = 0;
  const repair = await readChart(f.db, "table", scope, {
    ...req,
    cursor: delta.cursor,
  });
  expect(repair.upserts.map((b) => b.timestamp)).toEqual([epoch]);
  expect(repair.upserts[0].price).toBe(body.market.price);
  expect(f.reads).toHaveLength(1);
  const merged = new Map(
    [...a.upserts, ...delta.upserts, ...repair.upserts].map((b) => [
      b.timestamp,
      b,
    ]),
  );
  const full = await readChart(f.db, "table", scope, req);
  expect([...merged.values()]).toEqual(full.upserts);
});
test("rolling grids emit new pending slots without fetching old data; expired cursors reset", async () => {
  const f = fixture(),
    a = await readChart(f.db, "table", scope, req);
  f.reads.length = 0;
  const roll = await readChart(f.db, "table", scope, {
    ...req,
    from: epoch + 300,
    to: epoch + 900,
    cursor: a.cursor,
  });
  expect(roll.upserts.map((b) => b.timestamp)).toEqual([epoch + 600]);
  expect(f.reads).toHaveLength(0);
  f.append(epoch + 300);
  const k = key(
    sampledKey(f.current.policyRevision, `manifest:${a.publicationId}`),
  );
  f.data.get(k).expiresAt = 0;
  await expect(
    readChart(f.db, "table", scope, { ...req, cursor: a.cursor }),
  ).rejects.toMatchObject({ status: 409, code: "cursor-reset-required" });
  await expect(
    readChart(f.db, "table", scope, {
      ...req,
      series: scope.pools[0].id,
      cursor: a.cursor,
    }),
  ).rejects.toMatchObject({ status: 409 });
});
test("bounded unordered batch reads retry only unprocessed keys and fail on missing/corrupt pages", async () => {
  const f = fixture();
  f.append(epoch + 300);
  let calls = 0;
  const db = {
    send: async (command: any) => {
      const keys = command.input.RequestItems.table.Keys;
      calls++;
      if (calls === 1)
        return {
          Responses: { table: [f.data.get(key(keys[1]))] },
          UnprocessedKeys: { table: { Keys: [keys[0]] } },
        };
      expect(keys).toHaveLength(1);
      return { Responses: { table: [f.data.get(key(keys[0]))] } };
    },
  } as unknown as DynamoDBDocumentClient;
  expect(
    (
      await sampledReader(db, "table", f.current.policyRevision).pages(
        f.current.pages,
        "USDC",
      )
    ).size,
  ).toBe(2);
  const stuck = {
    send: async (c: any) => ({ UnprocessedKeys: c.input.RequestItems }),
  } as unknown as DynamoDBDocumentClient;
  await expect(
    sampledReader(stuck, "table", f.current.policyRevision).pages(
      f.current.pages,
      "USDC",
    ),
  ).rejects.toMatchObject({ code: "history-read-budget-exceeded" });
  const missing = {
    send: async () => ({ Responses: { table: [] } }),
  } as unknown as DynamoDBDocumentClient;
  await expect(
    sampledReader(missing, "table", f.current.policyRevision).pages(
      f.current.pages,
      "USDC",
    ),
  ).rejects.toThrow("Missing");
});
test("chart selectors and cursors validate before database reads", () => {
  const q = `view=chart&currency=USDC&resolution=300&from=${epoch}&to=${epoch + 300}`;
  expect(parseChartRequest(q, scope).series).toBe("market");
  for (const suffix of [
    "&series=unknown",
    "&cursor=bad!",
    "&from=0",
    "&unexpected=1",
  ])
    expect(() => parseChartRequest(q + suffix, scope)).toThrow();
});
