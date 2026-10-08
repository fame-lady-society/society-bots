import { nextSampledPublication } from "../../src/fame-market-history/sampled-live.ts";
/** Default: read-only rehearsal. --apply revises existing pages; no RPC or live cursor writes. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import { awsSampled } from "../../src/fame-market-history/sampled-storage.ts";
import { readSampledMarket } from "../../src/fame-market-history/sampled-api.ts";
import { sampledMarketBucket } from "../../src/fame-market-history/sampled-market.ts";
import { deriveSampledObservation } from "../../src/fame-market-history/sampled-rpc.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
try {
  const [directory, mode, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || (mode !== undefined && mode !== "--apply"))
    throw new Error("Expected output directory [--apply]");
  const table = process.env.FAME_HISTORY_TABLE,
    bucket = process.env.FAME_HISTORY_BUCKET;
  if (!table || !bucket) throw new Error("Missing storage target");
  const scope = historyScope(famePoolStateRegistry),
    metadata = JSON.parse(
      await readFile(
        new URL(
          "../../src/fame-market-history/token-metadata.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 2 }),
  );
  const store = awsSampled({ scope, metadata, table, bucket, db }),
    initial = await store.publication();
  if (!initial) throw new Error("Missing publication");
  const old = await Promise.all(
    (["ETH", "USDC"] as const).map((currency) =>
      readSampledMarket(db, table, scope, {
        currency,
        from: initial.startTimestamp,
        to: initial.nextTimestamp,
      }),
    ),
  );
  const prepared = [];
  const withoutCandles = (b: Record<string, any>) => {
    const { candleMethod, publicationStatus, ...rest } = b;
    return {
      ...rest,
      series: rest.series.map(({ candle, ...p }: Record<string, unknown>) => p),
    };
  };
  for (const ref of initial.pages) {
    const e = await store.read(ref.timestamp),
      prior = await store.previous(ref.timestamp),
      activity = await store.activity(e);
    if (!activity) throw new Error("Missing native archive");
    const buckets = (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(
        scope,
        c,
        e.timestamp,
        deriveSampledObservation(scope, e),
        activity,
        prior ? deriveSampledObservation(scope, prior) : null,
      ),
    );
    for (let i = 0; i < 2; i++) {
      const original = old[i].buckets.find((b) => b.timestamp === e.timestamp);
      if (
        !original ||
        !isDeepStrictEqual(withoutCandles(original), withoutCandles(buckets[i]))
      )
        throw new Error("Rebuild would change non-candle data");
    }
    prepared.push({ e, buckets });
  }
  await mkdir(directory, { recursive: true });
  for (const [i, currency] of (["ETH", "USDC"] as const).entries()) {
    const body = {
      ...old[i],
      buckets: prepared.map((p) => ({
        ...p.buckets[i],
        publicationStatus: "published",
      })),
    };
    if (Buffer.byteLength(JSON.stringify(body)) > 2 * 1024 * 1024)
      throw new Error("Response exceeds serving cap");
    await writeFile(
      path.join(directory, `${currency}.json`),
      JSON.stringify(body),
    );
  }
  let revised = 0,
    conflicts = 0;
  if (mode === "--apply")
    for (const entry of prepared) {
      while (true) {
        const current = await store.publication();
        if (!current) throw new Error("Publication disappeared");
        if (!current.pages.some((p) => p.timestamp === entry.e.timestamp))
          break; // expired while live advanced
        const originalRef = initial.pages.find(
          (p) => p.timestamp === entry.e.timestamp,
        )!;
        const currentRef = current.pages.find(
          (p) => p.timestamp === entry.e.timestamp,
        )!;
        const desiredRef = nextSampledPublication(null, entry.e, entry.buckets)
          .pages[0];
        if (
          !isDeepStrictEqual(currentRef, originalRef) &&
          !isDeepStrictEqual(currentRef, desiredRef)
        )
          throw new Error("Published bucket changed during rebuild");
        try {
          await store.revise(current, entry.e, entry.buckets);
          revised++;
          break;
        } catch (e) {
          const latest = await store.publication();
          if (
            !latest ||
            latest.generation === current.generation ||
            ++conflicts > 5
          )
            throw e;
        }
      }
    }
  const candles = prepared.flatMap((p) =>
    p.buckets.flatMap((b) => b.series.map((s) => s.candle)),
  );
  console.log(
    JSON.stringify({
      event: "sampled-candles-rebuilt",
      mode: mode ?? "read-only",
      buckets: prepared.length,
      revised,
      conflicts,
      nonFlat: candles.filter((c) => c && c.high !== c.low).length,
      partial: candles.filter((c) => c?.coverage === "partial").length,
      referenceOnly: candles.filter((c) => c?.coverage === "reference-only")
        .length,
      missing: candles.filter((c) => !c).length,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      event: "sampled-candles-rebuild-failed",
      failureCode: failureCode(e),
    }),
  );
  process.exitCode = 1;
}
