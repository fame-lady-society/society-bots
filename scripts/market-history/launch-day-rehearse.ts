/** Frozen launch-day, local-only capture and rebuild. No AWS storage client,
 * dataset activation or production mutation. Retained artifacts make it resumable. */
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  mkdtemp,
} from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fameHistoryRegistry } from "../../src/fame-market-history/registry.ts";
import {
  historyScope,
  digest,
  type Manifest,
  type Header,
} from "../../src/fame-market-history/model.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { collect } from "../../src/fame-market-history/collector.ts";
import { readArchive } from "../../src/fame-market-history/archive.ts";
import {
  immutableFile,
  readJson,
} from "../../src/fame-market-history/local-artifacts.ts";
import {
  sampledReader,
  deriveSampledObservation,
  type SampledEvidence,
} from "../../src/fame-market-history/sampled-rpc.ts";
import { sampledPolicy } from "../../src/fame-market-history/sampled-market.ts";
import { referenceBoundary } from "../../src/fame-market-history/reference-collector.ts";
import {
  rebuildActivity,
  sampledPages,
} from "../../src/fame-market-history/sampled-rebuild.ts";
import {
  buildHistory,
  rebuildParquet,
} from "../../src/fame-market-history/analytics.ts";
import { valuedActivity } from "../../src/fame-market-history/activity-events.ts";
import { readLocalSampledMarket } from "../../src/fame-market-history/sampled-local-api.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
const directory = process.argv[2],
  url = process.env.FAME_HISTORY_RPC_URL;
if (!directory || process.argv.length !== 3 || !url)
  throw new Error("Expected local output directory and RPC configuration");
const startBlock = 17019741;
const full = historyScope(fameHistoryRegistry),
  ids = new Set(
    full.pools
      .filter((p) => ["UniswapV2", "UniswapV3"].includes(p.venueFamily))
      .map((p) => p.id),
  );
assert.equal(ids.size, 2);
const scope = historyScope({
  ...fameHistoryRegistry,
  pools: fameHistoryRegistry.pools.filter(
    (p) => !full.pools.some((d) => d.id === p.id) || ids.has(p.id),
  ),
});
const rpc = boundedTransport({
  url,
  maxRequests: 20000,
  maxResponseBytes: 8 * 1024 * 1024,
  maxTotalResponseBytes: 128 * 1024 * 1024,
  deadline: Date.now() + 15 * 60_000,
});
try {
  for (const d of ["raw", "observations", "pages"])
    await mkdir(path.join(directory, d), { recursive: true });
  const chain = chainReader(scope, rpc.transport, 20000, rpc.capacity);
  const inventory = JSON.parse(
    await readFile(
      new URL(
        "../../docs/research/2026-10-08-genesis-deployment-evidence.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const id of ids)
    assert.equal(
      inventory.pools.find((p: any) => p.id === id)?.creationEvidence.block,
      startBlock,
    );
  const launch = await chain.header(startBlock),
    before = await chain.header(startBlock - 1);
  assert.equal(launch.timestamp, 1720828829);
  assert.equal(launch.parentHash, before.hash);
  // Verify the candidate boundary; never infer historical coverage from block cadence alone.
  const end = await chain.header(startBlock + 43200);
  assert.equal(end.timestamp, launch.timestamp + 86400);
  const job = {
    scopeId: scope.id,
    startBlock,
    endBlockExclusive: end.number,
    launch,
    end,
    chartFrom: Math.floor(launch.timestamp / 300) * 300,
    chartTo: Math.floor(launch.timestamp / 300) * 300 + 86400,
  };
  await immutableFile(
    path.join(directory, "job.json"),
    Buffer.from(JSON.stringify(job)),
  );
  let manifests =
    (await readJson<Manifest[]>(path.join(directory, "ranges.json"))) ?? [];
  for (const m of manifests)
    readArchive(
      m,
      await readFile(path.join(directory, "raw", `${m.sha256}.gz`)),
    );
  let next = manifests.length ? manifests.at(-1)!.toBlock + 1 : startBlock;
  while (next < end.number) {
    const result = await collect({
      scope,
      chain,
      startBlock,
      endBlock: end.number - 1,
      maxBlocks: 2000,
      maxEvents: 20000,
      store: {
        cursor: async () => ({
          startBlock,
          nextBlock: next,
          previousHash: manifests.at(-1)?.lastHash ?? null,
        }),
        reduceRange: async () => {
          throw new Error("Launch range requires smaller configured bound");
        },
        upload: async (_, bytes, sha) =>
          immutableFile(path.join(directory, "raw", `${sha}.gz`), bytes),
        commit: async (m) => {
          manifests.push(m);
          await writeFile(
            path.join(directory, "ranges.tmp"),
            JSON.stringify(manifests),
          );
          await rename(
            path.join(directory, "ranges.tmp"),
            path.join(directory, "ranges.json"),
          );
          next = m.toBlock + 1;
        },
      },
    });
    if (result.status !== "archived")
      throw new Error(`Capture stopped: ${result.status}`);
    console.log(
      JSON.stringify({
        phase: "raw",
        nextBlock: next,
        events: result.eventCount,
        metrics: rpc.metrics,
      }),
    );
  }
  const inputs = await Promise.all(
    manifests.map(async (manifest) => ({
      manifest,
      bytes: await readFile(
        path.join(directory, "raw", `${manifest.sha256}.gz`),
      ),
    })),
  );
  const metadata = JSON.parse(
    await readFile(
      new URL(
        "../../src/fame-market-history/token-metadata.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  metadata.blockNumber = launch.number;
  metadata.blockHash = launch.hash;
  const native = rebuildActivity(
    scope,
    metadata,
    inputs,
    job.chartFrom,
    job.chartTo,
  );
  const sample = sampledReader(scope, rpc.transport),
    observations = new Map();
  let previous: Header = before;
  for (let t = job.chartFrom; t < job.chartTo; t += 300) {
    const file = path.join(directory, "observations", `${t}.json`);
    let e = await readJson<SampledEvidence>(file);
    if (!e) {
      const guess = Math.min(end.number - 1, previous.number + 150),
        low = await chain.header(guess),
        high = await chain.header(guess + 1);
      const boundary =
        low.timestamp < t + 300 && high.timestamp >= t + 300
          ? { block: low, after: high }
          : await referenceBoundary(t, previous, end, chain.header);
      e = await sample(t, boundary.block, boundary.after);
      await immutableFile(file, Buffer.from(JSON.stringify(e)));
    }
    observations.set(t, deriveSampledObservation(scope, e));
    previous = e.block;
    if (observations.size % 24 === 0)
      console.log(
        JSON.stringify({
          phase: "samples",
          buckets: observations.size,
          metrics: rpc.metrics,
        }),
      );
  }
  const pages = sampledPages(scope, native, observations);
  for (const p of pages)
    await immutableFile(path.join(directory, "pages", p.key), p.bytes);
  await immutableFile(
    path.join(directory, "publication.json"),
    Buffer.from(
      JSON.stringify({
        version: "sampled-local-publication-v1",
        sourceRevision: native.sourceRevision,
        policyRevision: sampledPolicy(scope).revision,
        from: job.chartFrom,
        to: job.chartTo,
        pages: pages.map((p) => ({
          key: p.key,
          sha256: p.sha256,
          bytes: p.bytes.length,
        })),
      }),
    ),
  );
  const events = [...native.buckets].flatMap(([t, rows]) =>
    valuedActivity(scope, observations.get(t), rows),
  );
  await immutableFile(
    path.join(directory, "activity.json"),
    Buffer.from(JSON.stringify(events)),
  );
  const summaries = [];
  for (const currency of ["ETH", "USDC"] as const) {
    const r = await readLocalSampledMarket(
      directory,
      currency,
      job.chartFrom,
      job.chartTo,
    );
    summaries.push({
      currency,
      buckets: r.buckets.length,
      prices: r.buckets.filter((b) => b.market.price !== null).length,
      candles: r.buckets.filter((b) => b.market.candle !== null).length,
      unpricedEvents: events.filter((e) => e.values[currency] === null).length,
    });
  }
  const replayDirectory = await mkdtemp(path.join(directory, "replay-"));
  let eventCount = 0,
    tradeCount = 0;
  for (let i = 0; i < inputs.length; i += 8) {
    const built = await buildHistory(
      inputs.slice(i, i + 8),
      metadata,
      path.join(replayDirectory, `parquet-${i}`),
    );
    const replay = await rebuildParquet(
      path.join(replayDirectory, `parquet-${i}`),
      path.join(replayDirectory, `parquet-${i}-rebuilt`),
    );
    assert.deepEqual(replay.dataset, built.dataset);
    eventCount += built.eventCount;
    tradeCount += built.tradeCount;
  }
  const metrics = structuredClone(rpc.metrics);
  for (const file of (await readdir(directory)).filter((f) =>
    /^metrics-.*\.json$/.test(f),
  )) {
    const prior = JSON.parse(
      await readFile(path.join(directory, file), "utf8"),
    );
    metrics.requests += prior.requests;
    metrics.responseBytes += prior.responseBytes;
    for (const [method, count] of Object.entries(prior.methods))
      metrics.methods[method] =
        (metrics.methods[method] ?? 0) + (count as number);
  }
  const receipt = {
    ...job,
    pools: [...ids],
    ranges: manifests.length,
    rawEvents: eventCount,
    trades: tradeCount,
    activityEvents: events.length,
    types: Object.fromEntries(
      ["buy", "sell", "add", "remove"].map((t) => [
        t,
        events.filter((e) => e.type === t).length,
      ]),
    ),
    summaries,
    metrics,
    rawBytes: inputs.reduce((n, i) => n + i.bytes.length, 0),
    parquetReplayEqual: true,
    productionWrites: 0,
  };
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
} catch (e) {
  console.error(
    JSON.stringify({
      error: failureCode(e),
      message:
        e instanceof Error && !e.message.includes("http")
          ? e.message
          : undefined,
      metrics: rpc.metrics,
    }),
  );
  process.exitCode = 1;
} finally {
  await writeFile(
    path.join(directory, `metrics-${Date.now()}.json`),
    JSON.stringify(rpc.metrics),
  );
}
