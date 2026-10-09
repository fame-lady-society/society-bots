/** Verify immutable local publication, Parquet replay and existing production native amounts. AWS reads only. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { historyScope, digest } from "../../src/fame-market-history/model.ts";
import {
  deriveSampledObservation,
  type SampledEvidence,
} from "../../src/fame-market-history/sampled-rpc.ts";
import { sampledMarketBucket } from "../../src/fame-market-history/sampled-market.ts";
import { candleKey } from "../../src/fame-market-history/keys.ts";
import { immutableFile } from "../../src/fame-market-history/local-artifacts.ts";
try {
  if (process.argv.length !== 3) throw new Error("Expected local directory");
  const dir = path.resolve(process.argv[2]);
  const job = JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"));
  const manifest = JSON.parse(
    await readFile(path.join(dir, "publication.json"), "utf8"),
  );
  if (digest(JSON.stringify(job)) !== manifest.jobRevision)
    throw new Error("Job changed");
  const scope = historyScope(famePoolStateRegistry);
  if (scope.id !== job.scopeId) throw new Error("Scope changed");
  const buckets: ReturnType<typeof sampledMarketBucket>[] = [];
  for (const page of manifest.pages) {
    if (!/^(ETH|USDC)-[0-9]+\.json$/.test(page.key))
      throw new Error("Invalid page key");
    const bytes = await readFile(path.join(dir, "pages", page.key));
    if (bytes.length !== page.bytes || digest(bytes) !== page.sha256)
      throw new Error("Page changed");
    buckets.push(...JSON.parse(bytes.toString()).buckets);
  }
  const parquet = path.join(dir, "observations.parquet");
  if (digest(await readFile(parquet)) !== manifest.parquetSha256)
    throw new Error("Parquet changed");
  const instance = await DuckDBInstance.create(":memory:"),
    conn = await instance.connect();
  let replayed = 0;
  try {
    const rows = (
      await conn.runAndReadAll(
        `SELECT timestamp,payload FROM read_parquet('${parquet.replaceAll("'", "''")}') ORDER BY timestamp`,
      )
    ).getRows();
    if (rows.length !== (job.to - job.from) / 300)
      throw new Error("Missing Parquet observations");
    for (const [timestamp, payload] of rows) {
      const t = Number(timestamp),
        e = JSON.parse(String(payload)) as SampledEvidence;
      if (t !== e.timestamp || t !== job.from + replayed * 300)
        throw new Error("Parquet order mismatch");
      const observation = deriveSampledObservation(scope, e);
      for (const currency of ["ETH", "USDC"] as const) {
        const actual = buckets.find(
          (b) => b.timestamp === t && b.currency === currency,
        );
        if (!actual) throw new Error("Missing serving bucket");
        const prices = sampledMarketBucket(scope, currency, t, observation, []);
        for (const p of actual.series) {
          const expected = prices.series.find((x) => x.poolId === p.poolId);
          if (
            !expected ||
            expected.price !== p.price ||
            expected.inventory !== p.inventory
          )
            throw new Error("Parquet valuation mismatch");
        }
      }
      replayed++;
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
  const eth = buckets.filter((b) => b.currency === "ETH");
  if (eth.length !== 288 || buckets.length !== 576)
    throw new Error("Expected full day in both currencies");
  const expected = eth.flatMap((b) =>
    b.series.map((p) => ({
      key: candleKey(scope.id, p.poolId, b.timestamp),
      pool: p,
    })),
  );
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 2 }),
  );
  let matched = 0,
    missing = 0;
  const mismatches: unknown[] = [];
  for (let i = 0; i < expected.length; i += 100) {
    const batch = expected.slice(i, i + 100);
    let keys = batch.map((x) => x.key);
    for (let retry = 0; keys.length && retry < 5; retry++) {
      const response = await db.send(
        new BatchGetCommand({
          RequestItems: { [job.table]: { Keys: keys, ConsistentRead: true } },
        }),
      );
      const items = response.Responses?.[job.table] ?? [];
      const pending = response.UnprocessedKeys?.[job.table]?.Keys ?? [];
      for (const key of keys) {
        if (pending.some((k) => k.pk === key.pk && k.sk === key.sk)) continue;
        const item = items.find((k) => k.pk === key.pk && k.sk === key.sk);
        if (!item) {
          missing++;
          continue;
        }
        const p = batch.find(
          (x) => x.key.pk === key.pk && x.key.sk === key.sk,
        )!.pool;
        if (
          p.baseVolumeAtoms !== item.baseVolumeAtoms ||
          p.quoteVolumeAtoms !== item.quoteVolumeAtoms ||
          p.tradeCount !== item.tradeCount
        )
          mismatches.push({
            key,
            expected: p,
            actual: {
              baseVolumeAtoms: item.baseVolumeAtoms,
              quoteVolumeAtoms: item.quoteVolumeAtoms,
              tradeCount: item.tradeCount,
            },
          });
        else matched++;
      }
      keys = pending as typeof keys;
    }
    if (keys.length) throw new Error("Unprocessed comparison reads");
  }
  const report = {
    event: "sampled-local-verification",
    replayed,
    matchedNativePoolBuckets: matched,
    missingExistingPoolBuckets: missing,
    mismatches,
    tradeCount: eth.reduce((n, b) => n + (b.totals.tradeCount ?? 0), 0),
    completeEventBuckets: eth.filter(
      (b) => b.totals.eventCoverage === "complete",
    ).length,
    priceCoverage: (["ETH", "USDC"] as const).map((currency) => ({
      currency,
      available: buckets
        .filter((b) => b.currency === currency)
        .flatMap((b) => b.series)
        .filter((p) => p.price !== null).length,
      expected: 1440,
    })),
    quietPricedPoolBuckets: eth
      .flatMap((b) => b.series)
      .filter(
        (p) =>
          p.tradeCount === 0 &&
          p.eventCoverage === "complete" &&
          p.price !== null,
      ).length,
  };
  await immutableFile(
    path.join(dir, `verification-${Date.now()}.json`),
    Buffer.from(JSON.stringify(report)),
  );
  console.log(JSON.stringify(report));
  if (mismatches.length || missing) process.exitCode = 1;
} catch {
  console.error(
    "Sampled verification failed; details withheld. Check local artifact integrity and AWS read access.",
  );
  process.exitCode = 1;
}
