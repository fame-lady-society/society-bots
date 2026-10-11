/** Read-only historical admission proof. Local artifacts only; no AWS writes. */
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  octoberScope,
  octoberMetadata,
} from "../../src/fame-market-history/october-scope.ts";
import { admissionOrigins } from "../../src/fame-market-history/pool-lifecycle.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { referenceBoundary } from "../../src/fame-market-history/reference-collector.ts";
import {
  sampledReader,
  deriveSampledObservation,
} from "../../src/fame-market-history/sampled-rpc.ts";
import { sampledMarketBucket } from "../../src/fame-market-history/sampled-market.ts";
import { buildHistory } from "../../src/fame-market-history/analytics.ts";
import { rebuildActivity } from "../../src/fame-market-history/sampled-rebuild.ts";
import { collect } from "../../src/fame-market-history/collector.ts";
import { immutableFile } from "../../src/fame-market-history/local-artifacts.ts";
import type { Cursor, Manifest } from "../../src/fame-market-history/model.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
const directory = process.argv[2],
  url = process.env.FAME_HISTORY_RPC_URL;
if (!directory || process.argv.length !== 3 || !url)
  throw new Error("Expected new local output directory and RPC configuration");
const rpc = boundedTransport({
  url,
  maxRequests: 6000,
  maxResponseBytes: 8 * 1024 * 1024,
  maxTotalResponseBytes: 128 * 1024 * 1024,
  deadline: Date.now() + 600000,
});
try {
  await mkdir(directory, { recursive: false });
  const scope = octoberScope(),
    chain = chainReader(scope, rpc.transport, 5000, rpc.capacity),
    sample = sampledReader(scope, rpc.transport);
  const metadata = octoberMetadata(
    JSON.parse(
      await readFile(
        new URL(
          "../../src/fame-market-history/token-metadata.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  const receipts = [];
  for (const id of ["aerodrome-spx-fame", "aerodrome-cbbtc-fame"]) {
    const origin = admissionOrigins[id],
      from = Math.floor(origin.timestamp / 300) * 300,
      to = from + 86400;
    const low = await chain.header(origin.block - 300),
      ceiling = await chain.header(origin.block + 43300);
    const first = await referenceBoundary(
        from - 300,
        low,
        ceiling,
        chain.header,
      ),
      last = await referenceBoundary(
        to - 300,
        first.block,
        ceiling,
        chain.header,
      );
    let cursor: Cursor = {
      startBlock: first.block.number,
      nextBlock: first.block.number,
      previousHash: null,
    };
    let upload!: Uint8Array;
    const inputs: { manifest: Manifest; bytes: Uint8Array }[] = [];
    while (cursor.nextBlock <= last.after.number) {
      const result = await collect({
        scope,
        chain,
        startBlock: cursor.startBlock,
        endBlock: last.after.number,
        maxBlocks: 2000,
        maxEvents: 5000,
        store: {
          cursor: async () => cursor,
          upload: async (_, bytes) => {
            upload = bytes;
          },
          reduceRange: async (_, __, maxBlocks) => {
            cursor = { ...cursor, maxBlocks };
          },
          commit: async (manifest) => {
            await immutableFile(
              path.join(directory, `${manifest.sha256}.gz`),
              upload,
            );
            await immutableFile(
              path.join(directory, `${id}-${manifest.fromBlock}.json`),
              Buffer.from(JSON.stringify(manifest)),
            );
            inputs.push({ manifest, bytes: upload });
            cursor = {
              ...cursor,
              nextBlock: manifest.toBlock + 1,
              previousHash: manifest.lastHash,
            };
          },
        },
      });
      if (result.status !== "archived" && result.status !== "yielded")
        throw new Error("Admission raw capture did not progress");
    }
    const native = {
      eventCount: 0,
      tradeCount: 0,
      parquetBytes: 0,
      rebuildMatches: true,
    };
    for (let i = 0; i < inputs.length; i += 8) {
      const proof = await buildHistory(
        inputs.slice(i, i + 8),
        metadata,
        path.join(directory, `${id}-parquet-${i}`),
      );
      if (proof.unknownEvents || proof.invalidTrades || !proof.rebuildMatches)
        throw new Error("Admission native rebuild mismatch");
      native.eventCount += proof.eventCount;
      native.tradeCount += proof.tradeCount;
      native.parquetBytes += proof.parquetBytes;
    }
    const activity = rebuildActivity(scope, metadata, inputs, from, to);
    let previous = await sample(from - 300, first.block, first.after);
    await immutableFile(
      path.join(directory, `${id}-${from - 300}-sample.json`),
      Buffer.from(JSON.stringify(previous)),
    );
    const counts = { ETH: 0, USDC: 0 },
      candles = { ETH: 0, USDC: 0 };
    let trades = 0,
      actions = 0;
    for (let t = from; t < to; t += 300) {
      const guess = await chain.header(previous.block.number + 150),
        after = await chain.header(guess.number + 1);
      const boundary =
        guess.timestamp < t + 300 && after.timestamp >= t + 300
          ? { block: guess, after }
          : await referenceBoundary(
              t,
              previous.block,
              last.after,
              chain.header,
            );
      const evidence = await sample(t, boundary.block, boundary.after);
      if (
        (await chain.header(boundary.after.number)).hash !== boundary.after.hash
      )
        throw new Error("Admission boundary changed");
      await immutableFile(
        path.join(directory, `${id}-${t}-sample.json`),
        Buffer.from(JSON.stringify(evidence)),
      );
      const rows = activity.buckets.get(t)!;
      for (const currency of ["ETH", "USDC"] as const) {
        const bucket = sampledMarketBucket(
          scope,
          currency,
          t,
          deriveSampledObservation(scope, evidence),
          rows,
          deriveSampledObservation(scope, previous),
        );
        const pool = bucket.series.find((p) => p.poolId === id);
        if (pool?.price !== null && pool?.price !== undefined)
          counts[currency]++;
        if (pool?.candle) candles[currency]++;
        await immutableFile(
          path.join(directory, `${id}-${t}-${currency}.json`),
          Buffer.from(JSON.stringify(bucket)),
        );
      }
      const row = rows.find((p) => p.poolId === id)!;
      trades += row.tradeCount;
      actions += row.activityEvents?.length ?? 0;
      previous = evidence;
    }
    if (counts.ETH !== 288 || counts.USDC !== 288 || actions === 0)
      throw new Error(
        "Admission price or activity gaps; inspect local artifacts",
      );
    receipts.push({
      id,
      from,
      to,
      priced: counts,
      candles,
      trades,
      actions,
      rawRanges: inputs.length,
      native: {
        eventCount: native.eventCount,
        tradeCount: native.tradeCount,
        parquetBytes: native.parquetBytes,
        rebuildMatches: native.rebuildMatches,
      },
    });
  }
  const receipt = { receipts, metrics: rpc.metrics, productionWrites: 0 };
  await immutableFile(
    path.join(directory, "receipt.json"),
    Buffer.from(JSON.stringify(receipt, null, 2)),
  );
  console.log(JSON.stringify(receipt));
} catch (e) {
  console.error(
    JSON.stringify({ error: failureCode(e), metrics: rpc.metrics }),
  );
  process.exitCode = 1;
}
