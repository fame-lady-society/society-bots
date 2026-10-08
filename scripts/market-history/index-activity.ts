/** Build serving sidecars from verified archives. No RPC calls or chart/cursor writes. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import { awsSampled } from "../../src/fame-market-history/sampled-storage.ts";
import { sampledPolicy } from "../../src/fame-market-history/sampled-market.ts";
import { sampledReader } from "../../src/fame-market-history/sampled-reader.ts";
import { deriveSampledObservation } from "../../src/fame-market-history/sampled-rpc.ts";
import { valuedActivity } from "../../src/fame-market-history/activity-events.ts";
import { buildActivityIndex } from "../../src/fame-market-history/activity-storage.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
try {
  const [directory, mode, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || (mode !== undefined && mode !== "--apply"))
    throw new Error("Expected receipt directory [--apply]");
  const table = process.env.FAME_HISTORY_TABLE,
    bucket = process.env.FAME_HISTORY_BUCKET;
  if (!table || !bucket) throw new Error("Missing storage target");
  const scope = historyScope(famePoolStateRegistry),
    revision = sampledPolicy(scope).revision;
  const metadata = JSON.parse(
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
  const initial = await sampledReader(db, table, revision).publication();
  const from = Number(process.env.FAME_ACTIVITY_FROM ?? initial.startTimestamp),
    to = Number(process.env.FAME_ACTIVITY_TO ?? initial.nextTimestamp);
  if (
    ![from, to].every((v) => Number.isSafeInteger(v) && v % 300 === 0) ||
    from < initial.startTimestamp ||
    to > initial.nextTimestamp ||
    to <= from ||
    to - from > 86400
  )
    throw new Error(
      "Range must be inside the published window, aligned to 300 seconds, at most 24 hours",
    );
  const refs = initial.pages.filter(
      (p) => p.timestamp >= from && p.timestamp < to,
    ),
    buckets = [];
  // Reset bounded archive/evidence caches every 16 buckets, and pin the original page refs.
  for (let offset = 0; offset < refs.length; offset += 16) {
    const part = refs.slice(offset, offset + 16),
      reader = sampledReader(db, table, revision);
    const [eth, usdc] = await Promise.all([
      reader.pages(part, "ETH"),
      reader.pages(part, "USDC"),
    ]);
    const store = awsSampled({ scope, metadata, table, bucket, db });
    for (const ref of part) {
      const evidence = await store.read(ref.timestamp),
        native = await store.activity(evidence);
      if (!native) throw new Error("Native archive not ready");
      const coverage = native.every((p) => p.coverage === "complete")
        ? "complete"
        : native.some((p) => p.coverage !== "missing")
          ? "partial"
          : "missing";
      const events = valuedActivity(
          scope,
          deriveSampledObservation(scope, evidence),
          native,
        ),
        built = buildActivityIndex(ref.timestamp, events, coverage);
      if (mode === "--apply")
        await store.indexActivity(evidence, [
          eth.get(ref.timestamp)!,
          usdc.get(ref.timestamp)!,
        ]);
      buckets.push({
        timestamp: ref.timestamp,
        coverage,
        events: events.length,
        types: Object.fromEntries(
          ["buy", "sell", "add", "remove"].map((t) => [
            t,
            events.filter((e) => e.type === t).length,
          ]),
        ),
        unpriced: built.index.unpriced,
        chunks: built.pages.length,
        bytes:
          Buffer.byteLength(JSON.stringify(built.index)) +
          built.pages.reduce((n, p) => n + Buffer.byteLength(p.body), 0),
      });
    }
    console.log(
      JSON.stringify({
        event: "activity-index-progress",
        mode: mode ?? "read-only",
        processed: buckets.length,
        total: refs.length,
      }),
    );
  }
  const receipt = {
    event: "activity-index-complete",
    mode: mode ?? "read-only",
    publicationId: initial.generation,
    policyRevision: revision,
    from,
    to,
    buckets,
    totals: {
      buckets: buckets.length,
      events: buckets.reduce((n, b) => n + b.events, 0),
      chunks: buckets.reduce((n, b) => n + b.chunks, 0),
      bytes: buckets.reduce((n, b) => n + b.bytes, 0),
    },
    rpcCalls: 0,
    chartWrites: 0,
    liveCursorWrites: 0,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "activity-index.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify({ ...receipt, buckets: undefined }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: "activity-index-failed",
      code: failureCode(error),
    }),
  );
  process.exitCode = 1;
}
