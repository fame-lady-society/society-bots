/** Consume local launch artifacts through actual API handler + DynamoDB Local.
 * This script has no RPC client and rejects non-loopback database endpoints. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { dataset, datasetKey } from "../../src/fame-market-history/dataset.ts";
import {
  activeScopeKey,
  sampledKey,
  sampledPageKey,
} from "../../src/fame-market-history/keys.ts";
import {
  nextSampledPublication,
  type SampledPublication,
} from "../../src/fame-market-history/sampled-live.ts";
import { readLocalSampledMarket } from "../../src/fame-market-history/sampled-local-api.ts";
import { writeActivity } from "../../src/fame-market-history/activity-storage.ts";
import { launchScope } from "../../src/fame-market-history/local-backfill.ts";
import {
  dayPublication,
  dayWrites,
} from "../../src/fame-market-history/dated-publication.ts";
import { projectChartBucket } from "../../src/fame-market-history/chart-api.ts";
const directory = process.argv[2];
if (!directory || process.argv.length !== 3)
  throw new Error("Expected artifact directory");
const endpoint = new URL(
  process.env.FAME_HISTORY_DYNAMODB_ENDPOINT ?? "http://127.0.0.1:18001",
);
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1")
  throw new Error("Only loopback database permitted");
const job = JSON.parse(
  await readFile(path.join(directory, "job.json"), "utf8"),
);
const scope = launchScope();
assert.deepEqual(scope, job.scope);
const metadata = job.metadata;
const currencies = ["ETH", "USDC"] as const;
const days = [];
for (let from = job.from; from < job.to; from += 86400) {
  const dir = path.join(directory, "days", String(from));
  const events = JSON.parse(
    await readFile(path.join(dir, "activity.json"), "utf8"),
  );
  const charts = await Promise.all(
    currencies.map((c) => readLocalSampledMarket(dir, c, from, from + 86400)),
  );
  days.push({ from, events, charts });
}
const client = new DynamoDBClient({
    endpoint: endpoint.href,
    region: "us-west-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  db = DynamoDBDocumentClient.from(client),
  table = `launch-${randomUUID()}`;
await client.send(
  new CreateTableCommand({
    TableName: table,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
  }),
);
try {
  let p: SampledPublication | null = null;
  for (const day of days) {
    const refs = [];
    const { charts, events } = day;
    for (let i = 0; i < 288; i++) {
      const t = day.from + i * 300,
        e = JSON.parse(
          await readFile(
            path.join(directory, "observations", `${t}.json`),
            "utf8",
          ),
        ),
        buckets = charts.map((c) => c.buckets[i]);
      p = nextSampledPublication(p, e, buckets);
      const ref = p.pages.at(-1)!;
      refs.push(ref);
      for (const b of buckets)
        await db.send(
          new PutCommand({
            TableName: table,
            Item: {
              ...sampledPageKey(
                p.policyRevision,
                b.currency,
                t,
                ref[b.currency],
              ),
              body: JSON.stringify(b),
            },
          }),
        );
      await writeActivity(
        db,
        table,
        p.policyRevision,
        ref,
        events.filter((e: any) => e.timestamp >= t && e.timestamp < t + 300),
        buckets[0].totals.eventCoverage as "complete" | "partial" | "missing",
      );
    }
    await db.send(
      new TransactWriteCommand({
        TransactItems: dayWrites(
          table,
          null,
          dayPublication(job.policyRevision, day.from, refs),
        ),
      }),
    );
    console.log(JSON.stringify({ phase: "staged", day: day.from }));
  }
  for (const Item of [
    { ...activeScopeKey, scopeId: scope.id },
    { ...datasetKey(scope.id), ...dataset(scope, metadata) },
    { ...sampledKey(p!.policyRevision, "published"), ...p! },
  ])
    await db.send(new PutCommand({ TableName: table, Item }));
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint.href;
  process.env.AWS_REGION = "us-west-1";
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  process.env.FAME_HISTORY_TABLE = table;
  const { handler } = await import(
    "../../src/fame-market-history/api-lambda.ts"
  );
  const call = async (q: URLSearchParams) => {
    const r = await handler({
      rawQueryString: q.toString(),
      requestContext: { http: { method: "GET" } },
    } as any);
    assert.equal(r.statusCode, 200, r.body);
    return JSON.parse(r.body);
  };
  const results = [];
  for (const day of days) {
    const events = day.events;
    for (const currency of currencies) {
      const q = new URLSearchParams({
        view: "chart",
        currency,
        series: "market",
        resolution: "300",
        from: String(day.from),
        to: String(day.from + 86400),
      });
      const chart = await call(q);
      assert.equal(chart.upserts.length, 288);
      assert.deepEqual(
        chart.upserts,
        day.charts[currency === "ETH" ? 0 : 1].buckets.map((b) =>
          projectChartBucket(b, "market"),
        ),
      );
      assert.equal(chart.pools.length, 2);
      q.set("cursor", chart.cursor);
      assert.deepEqual((await call(q)).upserts, []);
      q.delete("cursor");
      q.delete("series");
      q.set("view", "activity");
      q.set("limit", "100");
      const rows: any[] = [];
      let calls = 0;
      do {
        const activity = await call(q);
        rows.push(...activity.rows);
        if (!activity.nextCursor) break;
        assert(++calls < 100);
        q.set("cursor", activity.nextCursor);
      } while (true);
      assert.equal(rows.length, events.length);
      assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
      assert.deepEqual(
        rows.map((r) => r.id).sort(),
        events.map((e: any) => e.id).sort(),
      );
      assert.equal(
        chart.upserts.reduce((n: number, b: any) => n + (b.tradeCount ?? 0), 0),
        rows.filter((r) => ["buy", "sell"].includes(r.type)).length,
      );
      results.push({
        day: day.from,
        currency,
        buckets: chart.upserts.length,
        events: rows.length,
        activityRequests: calls + 1,
        emptyDelta: true,
      });
    }
  }
  for (const day of days.slice(1)) {
    const q = new URLSearchParams({
      view: "chart",
      currency: "USDC",
      series: "market",
      resolution: "300",
      from: String(day.from - 43200),
      to: String(day.from + 43200),
    });
    const cross = await call(q);
    assert.equal(cross.upserts.length, 288);
    assert.equal(new Set(cross.upserts.map((b: any) => b.timestamp)).size, 288);
  }
  const availability = await call(
    new URLSearchParams({
      view: "availability",
      before: String(job.from),
    }),
  );
  assert.equal(availability.hasEarlier, false);
  assert.equal(availability.earliestAvailableTimestamp, job.from);
  assert.equal(
    (
      await call(
        new URLSearchParams({
          view: "availability",
          before: String(job.from + 86400),
        }),
      )
    ).hasEarlier,
    true,
  );
  const receipt = {
    results,
    midnightWindows: 6,
    availability,
    productionWrites: 0,
    rpcCalls: 0,
  };
  await writeFile(
    path.join(directory, "serving-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
} finally {
  await client.send(new DeleteTableCommand({ TableName: table }));
}
