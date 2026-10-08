import { readChart } from "../../src/fame-market-history/chart-api.ts";
/** Invoked by loopback-only DynamoDB rehearsal; S3 uses its checksummed object adapter. */
import assert from "node:assert/strict";
import {
  TransactWriteCommand,
  BatchWriteCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { awsSampled } from "../../src/fame-market-history/sampled-storage.ts";
import {
  sampledFixture,
  sampledHeader,
} from "../../src/fame-market-history/sampled-fixture.ts";
import {
  sampledPolicy,
  sampledMarketBucket,
} from "../../src/fame-market-history/sampled-market.ts";
import {
  scope,
  epoch,
  metadata,
} from "../../src/fame-market-history/worker-fixture.ts";
import {
  publishSampled,
  nextSampledPublication,
  prependSampledPublication,
} from "../../src/fame-market-history/sampled-live.ts";
import {
  parseSampledRequest,
  readSampledMarket,
} from "../../src/fame-market-history/sampled-api.ts";
import { deriveSampledObservation } from "../../src/fame-market-history/sampled-rpc.ts";
import {
  sampledKey,
  sampledPageKey,
} from "../../src/fame-market-history/keys.ts";
export async function rehearseSampled(
  db: DynamoDBDocumentClient,
  s3: S3Client,
  table: string,
) {
  const store = awsSampled({
    scope,
    metadata,
    db,
    s3,
    table,
    bucket: "local-objects",
  });
  // Existing worker rehearsal has raw ranges starting at block 100; first full bucket is epoch+300.
  const start = epoch + 300,
    initial = {
      startTimestamp: start,
      nextTimestamp: start,
      anchor: sampledHeader(100),
      policyRevision: sampledPolicy(scope).revision,
    };
  const cursor = await store.cursor(initial);
  assert.deepEqual(
    await store.cursor({
      ...initial,
      startTimestamp: start + 300,
      nextTimestamp: start + 300,
    }),
    cursor,
  );
  const first = sampledFixture(start);
  const contenders = await Promise.allSettled([
    store.commit(cursor, first),
    store.commit(cursor, first),
  ]);
  assert.equal(contenders.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.collected())!.nextTimestamp, start + 300);
  assert.equal(await store.publication(), null);
  assert.equal(
    (await store.activity(first))!.reduce((n, r) => n + r.tradeCount, 0),
    2,
  );
  // Commit succeeds but response is lost. Durable publication is the recovery cursor.
  await assert.rejects(() =>
    publishSampled(scope, {
      ...store,
      publish: async (...args) => {
        await store.publish(...args);
        throw new Error("response lost");
      },
    }),
  );
  assert.equal((await store.publication())!.nextTimestamp, start + 300);
  assert.equal((await publishSampled(scope, store)).published, 0);
  const request = parseSampledRequest(
    `view=sampled-market&currency=USDC&resolution=300&from=${start}&to=${start + 300}`,
  );
  const result = await readSampledMarket(db, table, scope, request);
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].totals.tradeCount, 2);
  assert.equal(
    result.buckets[0].series.filter((p) => p.price !== null).length,
    5,
  );
  // Reader only needs transaction reads; no network pricing or S3 dependency.
  const readOnlyDb = {
    send: async (command: unknown) => {
      assert.notEqual(command instanceof TransactWriteCommand, true);
      return db.send(command as never);
    },
  } as unknown as DynamoDBDocumentClient;
  assert.equal(
    (
      await readSampledMarket(readOnlyDb, table, scope, {
        ...request,
        currency: "ETH",
      })
    ).buckets.length,
    1,
  );
  // A stale writer must not roll the generation back, even if its row body matches.
  const old = await store.read(start);
  const ethBucket = (
    await readSampledMarket(db, table, scope, { ...request, currency: "ETH" })
  ).buckets[0];
  await assert.rejects(() =>
    store.publish(null, old, [ethBucket, result.buckets[0]]),
  );
  // Independent backwards imports race safely with each other and live publication.
  const beforeImport = (await store.publication())!;
  const savedCursor = await store.collected();
  const historical = sampledFixture(epoch);
  const historicalRows = (["ETH", "USDC"] as const).map((c) =>
    sampledMarketBucket(
      scope,
      c,
      epoch,
      deriveSampledObservation(scope, historical),
      [],
    ),
  );
  const jobId = "a".repeat(64);
  const imports = await Promise.allSettled([
    store.importPrevious(beforeImport, historical, historicalRows, jobId),
    store.importPrevious(beforeImport, historical, historicalRows, jobId),
  ]);
  assert.equal(imports.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual(await store.collected(), savedCursor);
  assert.equal(
    (await store.publication())!.nextTimestamp,
    beforeImport.nextTimestamp,
  );
  assert.equal((await store.publication())!.startTimestamp, epoch);
  assert.deepEqual(await store.read(epoch), historical);
  const nextEvidence = sampledFixture(start + 300);
  await store.commit(savedCursor!, nextEvidence);
  const nextRows = (["ETH", "USDC"] as const).map((c) =>
    sampledMarketBucket(
      scope,
      c,
      nextEvidence.timestamp,
      deriveSampledObservation(scope, nextEvidence),
      [],
    ),
  );
  // A publisher holding the pre-import generation loses, then resumes normally.
  await assert.rejects(() =>
    store.publish(beforeImport, nextEvidence, nextRows),
  );
  await store.publish(await store.publication(), nextEvidence, nextRows);
  // The converse race: live publication wins before an importer commits.
  // Use the actual valid pre-append generation, not a fabricated manifest.
  const previousJoined = prependSampledPublication(
    beforeImport,
    historical,
    historicalRows,
  );
  const earlier = sampledFixture(epoch - 300);
  const earlierRows = (["ETH", "USDC"] as const).map((c) =>
    sampledMarketBucket(
      scope,
      c,
      earlier.timestamp,
      deriveSampledObservation(scope, earlier),
      [],
    ),
  );
  await assert.rejects(() =>
    store.importPrevious(previousJoined, earlier, earlierRows, jobId),
  );
  await assert.rejects(() => store.read(epoch - 300)); // Failed transaction exposed no observation.
  const importedView = await readSampledMarket(db, table, scope, {
    currency: "ETH",
    from: epoch,
    to: start + 600,
  });
  assert.equal(importedView.buckets.length, 3);
  assert.equal(importedView.buckets[1].totals.tradeCount, 2);
  assert.ok(importedView.buckets[0].series.every((p) => p.price !== null));
  await assert.rejects(() =>
    store.importPrevious(beforeImport, historical, historicalRows, jobId),
  );
  const rows = await db.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": `sampled:${sampledPolicy(scope).revision}`,
      },
    }),
  );
  assert.ok(rows.Items?.length);
  // Rebuild changes only immutable page references, not the live frontier or collector.
  const revisionBefore = (await store.publication())!;
  const revisionCursor = await store.collected();
  const revisedActivity = (await store.activity(first))!;
  const active = revisedActivity.find((a) => a.tradeCount > 0)!;
  active.spot = {
    open: { numerator: "1", denominator: "1" },
    high: { numerator: "2", denominator: "1" },
    low: { numerator: "1", denominator: "1" },
    close: { numerator: "2", denominator: "1" },
    count: active.tradeCount,
  };
  const revisedBuckets = (["ETH", "USDC"] as const).map((c) =>
    sampledMarketBucket(
      scope,
      c,
      start,
      deriveSampledObservation(scope, first),
      revisedActivity,
    ),
  );
  const chartRequest = {
    currency: "ETH" as const,
    series: active.poolId,
    from: start,
    to: start + 300,
  };
  const beforeChart = await readChart(db, table, scope, chartRequest);
  await store.revise(revisionBefore, first, revisedBuckets);
  const deltaChart = await readChart(db, table, scope, {
    ...chartRequest,
    cursor: beforeChart.cursor,
  });
  assert.equal(deltaChart.upserts.length, 1);
  assert.ok(deltaChart.upserts[0].candle);
  assert.equal(
    (
      await readChart(db, table, scope, {
        ...chartRequest,
        cursor: deltaChart.cursor,
      })
    ).upserts.length,
    0,
  );
  assert.equal(
    (await store.publication())!.nextTimestamp,
    revisionBefore.nextTimestamp,
  );
  assert.deepEqual(await store.collected(), revisionCursor);
  await assert.rejects(() =>
    store.revise(revisionBefore, first, revisedBuckets),
  );
  await store.revise((await store.publication())!, first, revisedBuckets); // idempotent
  const revisedRead = await readSampledMarket(db, table, scope, {
    currency: "ETH",
    from: start,
    to: start + 300,
  });
  assert.equal(revisedRead.buckets[0].totals.tradeCount, 2);
  assert.ok(
    revisedRead.buckets[0].series.find((p) => p.poolId === active.poolId)!
      .candle,
  );
  // Synthetic 24-hour load uses real DynamoDB page records and transaction reads.
  let publication = (await store.publication())!;
  let writes: Record<string, unknown>[] = [];
  const flush = async () => {
    if (!writes.length) return;
    const r = await db.send(
      new BatchWriteCommand({
        RequestItems: {
          [table]: writes.map((Item) => ({ PutRequest: { Item } })),
        },
      }),
    );
    assert.equal(Object.keys(r.UnprocessedItems ?? {}).length, 0);
    writes = [];
  };
  for (let i = 2; i < 288; i++) {
    const evidence = sampledFixture(start + i * 300),
      observation = deriveSampledObservation(scope, evidence);
    const buckets = (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(scope, c, evidence.timestamp, observation, []),
    );
    publication = nextSampledPublication(publication, evidence, buckets);
    const ref = publication.pages.at(-1)!;
    for (const b of buckets) {
      writes.push({
        ...sampledPageKey(
          publication.policyRevision,
          b.currency,
          b.timestamp,
          ref[b.currency],
        ),
        body: JSON.stringify(b),
      });
      if (writes.length === 25) await flush();
    }
  }
  await flush();
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...sampledKey(publication.policyRevision, "published"),
        ...publication,
      },
    }),
  );
  for (const currency of ["ETH", "USDC"] as const) {
    const full = await readSampledMarket(db, table, scope, {
      currency,
      from: start,
      to: start + 86400,
    });
    assert.equal(full.buckets.length, 288);
    assert.ok(Buffer.byteLength(JSON.stringify(full)) < 2 * 1024 * 1024);
  }
  console.log(
    JSON.stringify({
      event: "sampled-production-local-proof",
      competingCollectors: "one-committed",
      lostPublicationResponse: "recovered",
      currencies: 2,
      loadBuckets: 288,
      tradeCount: 2,
      historicalImport:
        "concurrent-safe; live cursor preserved; stale publisher resumed",
    }),
  );
}
