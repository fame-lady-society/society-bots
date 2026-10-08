import { scope, epoch } from "./worker-fixture.ts";
import { sampledFixture, sampledHeader } from "./sampled-fixture.ts";
import {
  collectSampled,
  nextSampledPublication,
  validateSampledPublication,
  type SampledCursor,
  type SampledStore,
} from "./sampled-live.ts";
import { sampledMarketBucket, sampledPolicy } from "./sampled-market.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";
import { parseSampledRequest, readSampledMarket } from "./sampled-api.ts";
import { sampledPageKey } from "./keys.ts";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
test("collection initializes once and resumes without replaying committed buckets", async () => {
  let cursor: SampledCursor = {
    startTimestamp: epoch,
    nextTimestamp: epoch,
    anchor: sampledHeader(99),
    policyRevision: sampledPolicy(scope).revision,
  };
  const timestamps: number[] = [];
  const store: Pick<SampledStore, "cursor" | "commit"> = {
    cursor: async () => cursor,
    commit: async (c, e) => {
      expect(c.nextTimestamp).toBe(cursor.nextTimestamp);
      timestamps.push(e.timestamp);
      cursor = { ...cursor, nextTimestamp: e.timestamp + 300, anchor: e.block };
    },
  };
  const chain = {
    finalized: async () => sampledHeader(110),
    header: async (n: number) => sampledHeader(n),
  };
  await collectSampled(
    scope,
    store,
    chain,
    async (t) => sampledFixture(t),
    () => true,
    1,
  );
  await collectSampled(
    scope,
    store,
    chain,
    async (t) => sampledFixture(t),
    () => true,
    4,
  );
  expect(timestamps).toEqual([epoch, epoch + 300]);
});
test("publication survives map reordering and reader detects corrupted content", async () => {
  const e = sampledFixture(),
    o = deriveSampledObservation(scope, e),
    buckets = (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(scope, c, epoch, o, []),
    );
  const p = nextSampledPublication(null, e, buckets);
  const shuffled = JSON.parse(
    JSON.stringify(p, (k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse())
        : v,
    ),
  );
  expect(validateSampledPublication(shuffled, p.policyRevision)).toEqual(p);
  let corrupt = false;
  const db = {
    send: async (command: any) => ({
      Responses: command.input.TransactItems.map(({ Get }: any) => ({
        Item:
          Get.Key.sk === "published"
            ? shuffled
            : {
                ...sampledPageKey(
                  p.policyRevision,
                  "ETH",
                  epoch,
                  p.pages[0].ETH,
                ),
                body: corrupt ? "{}" : JSON.stringify(buckets[0]),
              },
      })),
    }),
  } as unknown as DynamoDBDocumentClient;
  const request = { currency: "ETH" as const, from: epoch, to: epoch + 300 };
  expect(
    (await readSampledMarket(db, "table", scope, request)).buckets,
  ).toHaveLength(1);
  corrupt = true;
  await expect(readSampledMarket(db, "table", scope, request)).rejects.toThrow(
    "checksum",
  );
});
test("request rejects duplicate currency, arbitrary currencies and oversized ranges", () => {
  const q = `view=sampled-market&currency=ETH&resolution=300&from=${epoch}&to=${epoch + 300}`;
  expect(parseSampledRequest(q).currency).toBe("ETH");
  for (const query of [
    q + "&currency=ETH",
    q.replace("currency=ETH", "currency=USD"),
    q.replace(String(epoch + 300), String(epoch + 86700)),
  ])
    expect(() => parseSampledRequest(query)).toThrow();
});

test("a fresh deployment returns explicit gaps around available publication", async () => {
  const e = sampledFixture(),
    o = deriveSampledObservation(scope, e),
    rows = (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(scope, c, epoch, o, []),
    );
  const p = nextSampledPublication(null, e, rows);
  const db = {
    send: async (command: any) => ({
      Responses: command.input.TransactItems.map(({ Get }: any) => ({
        Item:
          Get.Key.sk === "published" ? p : { body: JSON.stringify(rows[0]) },
      })),
    }),
  } as unknown as DynamoDBDocumentClient;
  const r = await readSampledMarket(db, "table", scope, {
    currency: "ETH",
    from: epoch - 300,
    to: epoch + 600,
  });
  expect(r.buckets.map((b) => b.publicationStatus)).toEqual([
    "outside-published-window",
    "published",
    "not-yet-published",
  ]);
  expect(r.buckets[0].totals.tradeCount).toBeNull();
  expect(r.buckets[2].series.every((p) => p.price === null)).toBe(true);
});
