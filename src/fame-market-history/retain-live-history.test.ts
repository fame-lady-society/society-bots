import {
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { retainLiveHistory } from "./retain-live-history.ts";
import { scope, epoch } from "./worker-fixture.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { sampledMarketBucket } from "./sampled-market.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";
import {
  nextSampledPublication,
  type SampledPublication,
} from "./sampled-live.ts";
import { sampledKey, sampledPageKey } from "./keys.ts";
import { activityKey, buildActivityIndex } from "./activity-storage.ts";
import { utcDay } from "./dated-publication.ts";
const key = (k: any) => `${k.pk}|${k.sk}`;
function fixture() {
  const data = new Map<string, any>();
  let p: SampledPublication | null = null;
  const writes: any[] = [];
  const start = utcDay(epoch) + 86400 - 300;
  for (const t of [start, start + 300]) {
    const e = sampledFixture(t),
      o = deriveSampledObservation(scope, e),
      buckets = (["ETH", "USDC"] as const).map((c) =>
        sampledMarketBucket(scope, c, t, o, []),
      );
    p = nextSampledPublication(p, e, buckets);
    const ref = p.pages.at(-1)!;
    for (const b of buckets) {
      const k = sampledPageKey(
        p.policyRevision,
        b.currency,
        t,
        ref[b.currency],
      );
      data.set(key(k), { ...k, body: JSON.stringify(b) });
    }
    const k = activityKey(p.policyRevision, ref);
    data.set(key(k), {
      ...k,
      body: JSON.stringify(buildActivityIndex(t, [], "complete").index),
    });
  }
  data.set(key(sampledKey(p!.policyRevision, "published")), p);
  const db = {
    send: async (c: any) => {
      if (c instanceof TransactWriteCommand) {
        writes.push(c.input);
        for (const item of c.input.TransactItems ?? [])
          if (item.Put) data.set(key(item.Put.Item), item.Put.Item);
        return {};
      }
      if (c.input.Key) return { Item: data.get(key(c.input.Key)) };
      return {
        Responses: {
          table: c.input.RequestItems.table.Keys.map((k: any) =>
            data.get(key(k)),
          ).filter(Boolean),
        },
      };
    },
  } as unknown as DynamoDBDocumentClient;
  return { db, data, writes, p: p! };
}
test("dry-run and replay retain both days without changing any live record", async () => {
  const f = fixture(),
    original = JSON.stringify(f.p);
  expect(
    (await retainLiveHistory(f.db, "table", f.p.policyRevision, false)).added,
  ).toBe(2);
  expect(f.writes).toEqual([]);
  expect(
    (await retainLiveHistory(f.db, "table", f.p.policyRevision, true)).added,
  ).toBe(2);
  const tx = f.writes[0].TransactItems;
  expect(tx[0].ConditionCheck).toMatchObject({
    Key: sampledKey(f.p.policyRevision, "published"),
    ConditionExpression: "generation = :generation",
    ExpressionAttributeValues: { ":generation": f.p.generation },
  });
  expect(
    tx.filter((x: any) => x.Put && x.Put.Item.sk.startsWith("day:")),
  ).toHaveLength(2);
  expect(
    tx
      .filter((x: any) => x.Put)
      .every((x: any) => x.Put.Item.sk.startsWith("day")),
  ).toBe(true);
  expect(
    JSON.stringify(
      f.data.get(key(sampledKey(f.p.policyRevision, "published"))),
    ),
  ).toBe(original);
  expect(
    (await retainLiveHistory(f.db, "table", f.p.policyRevision, true)).added,
  ).toBe(0);
  expect(f.writes).toHaveLength(1);
});
test("missing activity and corrupt chart evidence prevent retention writes", async () => {
  const f = fixture();
  f.data.delete(key(activityKey(f.p.policyRevision, f.p.pages[0])));
  await expect(
    retainLiveHistory(f.db, "table", f.p.policyRevision, true),
  ).rejects.toThrow("Missing published activity");
  expect(f.writes).toEqual([]);
  const g = fixture();
  g.data.get(
    key(
      sampledPageKey(
        g.p.policyRevision,
        "ETH",
        g.p.pages[0].timestamp,
        g.p.pages[0].ETH,
      ),
    ),
  ).body = "{}";
  await expect(
    retainLiveHistory(g.db, "table", g.p.policyRevision, true),
  ).rejects.toThrow("checksum");
  expect(g.writes).toEqual([]);
});
