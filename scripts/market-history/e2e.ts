import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  buildHistory,
  rebuildParquet,
} from "../../src/fame-market-history/analytics.ts";
import { localHistoryServer } from "./local-http.ts";

const [source, output] = process.argv.slice(2);
if (!source || !output || process.argv.length !== 4)
  throw new Error("Usage: e2e.ts SOURCE_DIRECTORY NEW_OUTPUT_DIRECTORY");
const started = Date.now();
const result = await buildHistory(
  [
    {
      manifest: JSON.parse(
        await readFile(path.join(source, "manifest.json"), "utf8"),
      ),
      bytes: await readFile(path.join(source, "raw.jsonl.gz")),
    },
  ],
  JSON.parse(await readFile(path.join(source, "tokens.json"), "utf8")),
  output,
);
const rebuilt = await rebuildParquet(output, `${output}-rebuilt`);
if (JSON.stringify(result.dataset) !== JSON.stringify(rebuilt.dataset))
  throw new Error("Fresh Parquet-only rebuild differs");
const active = result.dataset.candles[300].find((c) => c.tradeCount > 0);
if (!active) throw new Error("End-to-end sample must include trades");
const token = randomBytes(32).toString("hex");
const server = localHistoryServer(result.dataset, token);
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected local TCP address");
  const url = `http://127.0.0.1:${address.port}/fame/history?pool=${encodeURIComponent(active.poolId)}&resolution=300&from=${active.timestamp}&to=${active.timestamp + 300}`;
  if ((await fetch(url)).status !== 401)
    throw new Error("Local authentication check failed");
  const authorization = { Authorization: `Bearer ${token}` };
  const oversized = new URL(url);
  oversized.searchParams.set("to", String(active.timestamp + 300 * 1001));
  if ((await fetch(oversized, { headers: authorization })).status !== 400)
    throw new Error("HTTP query bound check failed");
  if (
    (await fetch(url, { method: "POST", headers: authorization })).status !==
    404
  )
    throw new Error("HTTP read-only method check failed");
  const response = await fetch(url, {
    headers: authorization,
  });
  if (response.status !== 200) throw new Error("History response failed");
  const body = await response.json();
  if (JSON.stringify(body.points) !== JSON.stringify([active]))
    throw new Error("HTTP response differs from computed candle");
  await writeFile(
    path.join(output, "api-example.json"),
    JSON.stringify(body, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      {
        event: "history-e2e-verified",
        eventCount: result.eventCount,
        tradeCount: result.tradeCount,
        unknownEvents: result.unknownEvents,
        invalidTrades: result.invalidTrades,
        parquetBytes: result.parquetBytes,
        parquetOnlyRebuildMatches: true,
        httpStatus: response.status,
        decoderReview: result.dataset.metadata.decoderReview,
        elapsedMs: Date.now() - started,
        rssBytes: process.memoryUsage().rss,
        output,
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
