/** Foreground, resumable launch-week trial. Reads RPC; writes only local files. */
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  mkdtemp,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  launchScope,
  withLocalLock,
  localInputs,
  commitLocalRange,
} from "../../src/fame-market-history/local-backfill.ts";
import {
  immutableFile,
  readJson,
} from "../../src/fame-market-history/local-artifacts.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { collect } from "../../src/fame-market-history/collector.ts";
import { referenceBoundary } from "../../src/fame-market-history/reference-collector.ts";
import {
  sampledReader,
  deriveSampledObservation,
  type SampledEvidence,
} from "../../src/fame-market-history/sampled-rpc.ts";
import {
  sampledPolicy,
  type SampledObservation,
} from "../../src/fame-market-history/sampled-market.ts";
import {
  rebuildActivity,
  sampledPages,
} from "../../src/fame-market-history/sampled-rebuild.ts";
import { valuedActivity } from "../../src/fame-market-history/activity-events.ts";
import {
  buildHistory,
  rebuildParquet,
} from "../../src/fame-market-history/analytics.ts";
import { readLocalSampledMarket } from "../../src/fame-market-history/sampled-local-api.ts";
import {
  integer,
  type Header,
  type Manifest,
  type Scope,
} from "../../src/fame-market-history/model.ts";
import {
  validateMetadata,
  type TokenMetadata,
} from "../../src/fame-market-history/decode.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";

const [mode, directory, ...args] = process.argv.slice(2);
if (
  !["prepare", "run", "rebuild", "status"].includes(mode) ||
  !directory ||
  args.length % 2
)
  throw new Error(
    "Usage: run-local-backfill.ts prepare|run|rebuild|status <directory> [--seed dir] [--max-requests n] [--checkpoints n]",
  );
const flags = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--seed", "--max-requests", "--checkpoints"].includes(args[i]) ||
    flags.has(args[i])
  )
    throw new Error("Invalid option");
  flags.set(args[i], args[i + 1]);
}
const maxRequests = integer(
  Number(flags.get("--max-requests") ?? 12000),
  "request bound",
  1,
);
const checkpoints = integer(
  Number(flags.get("--checkpoints") ?? 100000),
  "checkpoint bound",
  1,
);
if (flags.has("--seed") && mode !== "prepare")
  throw new Error("Seed is prepare-only");
const FROM = 1720828800,
  TO = 1721433600,
  START = 17019741; // July 13–20 UTC, two launch pools only.
interface Job {
  version: string;
  scope: Scope;
  policyRevision: string;
  from: number;
  to: number;
  startBlock: number;
  launch: Header;
  before: Header;
  end: Header;
  metadata: TokenMetadata;
}
let stopped = false;
const stop = () => {
  stopped = true;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const put = async (file: string, value: unknown) =>
  immutableFile(file, Buffer.from(JSON.stringify(value)));
async function execute() {
  for (const d of ["raw", "manifests", "observations", "days", "runs"])
    await mkdir(path.join(directory, d), { recursive: true });
  let lastRequest = 0;
  const rpc = boundedTransport({
    url: process.env.FAME_HISTORY_RPC_URL ?? "https://offline.invalid",
    maxRequests,
    maxResponseBytes: 8 * 1024 * 1024,
    maxTotalResponseBytes: 256 * 1024 * 1024,
    deadline: Date.now() + 30 * 60_000,
    fetcher: async (input, init) => {
      if (mode === "rebuild" || mode === "status")
        throw new Error("Offline mode cannot call RPC");
      if (!process.env.FAME_HISTORY_RPC_URL)
        throw new Error("Missing RPC configuration");
      const wait = 100 - (Date.now() - lastRequest);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequest = Date.now();
      return fetch(input, init);
    },
  });
  const started = Date.now();
  let commits = 0;
  try {
    let job = await readJson<Job>(path.join(directory, "job.json"));
    if (!job) {
      if (mode !== "prepare") throw new Error("Prepare the job first");
      const scope = launchScope(),
        chain = chainReader(scope, rpc.transport, 5000, rpc.capacity);
      const launch = await chain.header(START),
        before = await chain.header(START - 1),
        ceiling = await chain.header(START + 7 * 43200 + 100);
      assert.equal(launch.timestamp, FROM + 29);
      assert.equal(launch.parentHash, before.hash);
      const boundary = await referenceBoundary(
        TO - 300,
        launch,
        ceiling,
        chain.header,
      );
      const metadata: TokenMetadata = JSON.parse(
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
      job = {
        version: "local-launch-week-v1",
        scope,
        policyRevision: sampledPolicy(scope).revision,
        from: FROM,
        to: TO,
        startBlock: START,
        launch,
        before,
        end: boundary.after,
        metadata,
      };
      await put(path.join(directory, "job.json"), job);
    }
    assert.equal(job.version, "local-launch-week-v1");
    assert.equal(job.from, FROM);
    assert.equal(job.to, TO);
    assert.equal(job.startBlock, START);
    assert.deepEqual(job.scope, launchScope());
    assert.equal(job.launch.number, START);
    assert.equal(job.launch.timestamp, FROM + 29);
    assert.equal(job.before.number, START - 1);
    assert.equal(job.launch.parentHash, job.before.hash);
    assert(job.end.timestamp >= TO && job.end.timestamp < TO + 60);
    assert.equal(job.policyRevision, sampledPolicy(job.scope).revision);
    validateMetadata(job.scope, job.metadata);
    assert.equal(job.metadata.blockNumber, job.launch.number);
    assert.equal(job.metadata.blockHash, job.launch.hash);
    const scope = job.scope,
      chain = chainReader(scope, rpc.transport, 5000, rpc.capacity);
    if (mode === "prepare" && flags.has("--seed")) {
      const seed = flags.get("--seed")!;
      const manifests: Manifest[] = JSON.parse(
        await readFile(path.join(seed, "ranges.json"), "utf8"),
      );
      for (const m of manifests) {
        assert.equal(m.scopeId, scope.id);
        assert(m.toBlock <= job.end.number);
        await commitLocalRange(
          directory,
          m,
          await readFile(path.join(seed, "raw", `${m.sha256}.gz`)),
        );
      }
      await localInputs(directory, scope, START);
      for (const file of await readdir(path.join(seed, "observations"))) {
        if (!/^\d+\.json$/.test(file)) continue;
        const e: SampledEvidence = JSON.parse(
          await readFile(path.join(seed, "observations", file), "utf8"),
        );
        assert(e.timestamp >= FROM && e.timestamp < TO);
        assert.equal(file, `${e.timestamp}.json`);
        deriveSampledObservation(scope, e);
        await put(path.join(directory, "observations", file), e);
      }
    }
    const inputs = await localInputs(directory, scope, START);
    if (inputs.length) {
      assert.equal(inputs[0].manifest.firstHash, job.launch.hash);
      assert.equal(inputs[0].manifest.previousHash, job.before.hash);
      const last = inputs.at(-1)!.manifest;
      assert(last.toBlock <= job.end.number);
      if (last.toBlock === job.end.number)
        assert.equal(last.lastHash, job.end.hash);
    }
    let next = inputs.at(-1)?.manifest.toBlock;
    let nextBlock = next === undefined ? START : next + 1;
    const sampleFiles = (
      await readdir(path.join(directory, "observations"))
    ).filter((n) => /^\d+\.json$/.test(n));
    const status = () => ({
      retainedSamples: sampleFiles.length,
      phase: nextBlock <= job!.end.number ? "capture" : "sampling-or-rebuild",
      nextBlock,
      endBlock: job!.end.number,
      rawRanges: inputs.length,
      metrics: rpc.metrics,
    });
    if (mode === "prepare" || mode === "status") {
      console.log(JSON.stringify({ ...status(), mode, from: FROM, to: TO }));
      return;
    }
    if (mode === "run") {
      while (nextBlock <= job.end.number && !stopped && commits < checkpoints) {
        const bound =
          (
            await readJson<{ maxBlocks: number }>(
              path.join(directory, "range-bound.json"),
            )
          )?.maxBlocks ?? 2000;
        let bytes: Uint8Array | undefined;
        const result = await collect({
          scope,
          chain,
          startBlock: START,
          endBlock: job.end.number,
          maxBlocks: bound,
          maxEvents: 5000,
          store: {
            cursor: async () => ({
              startBlock: START,
              nextBlock,
              previousHash: inputs.at(-1)?.manifest.lastHash ?? null,
            }),
            reduceRange: async (_, __, maxBlocks) => {
              const file = path.join(directory, "range-bound.json");
              await writeFile(`${file}.tmp`, JSON.stringify({ maxBlocks }));
              await rename(`${file}.tmp`, file);
            },
            upload: async (_, b) => {
              bytes = b;
            },
            commit: async (m) => {
              await commitLocalRange(directory, m, bytes!);
              inputs.push({ manifest: m, bytes: Buffer.from(bytes!) });
              nextBlock = m.toBlock + 1;
              commits++;
            },
          },
        });
        console.log(JSON.stringify({ ...status(), result: result.status }));
        if (result.status !== "archived") return;
      }
    }
    if (mode === "rebuild" && nextBlock <= job.end.number)
      throw new Error("Missing raw ranges in offline rebuild");
    if (nextBlock <= job.end.number || stopped || commits >= checkpoints) {
      console.log(JSON.stringify({ ...status(), paused: true }));
      return;
    }
    const observations = new Map<number, SampledObservation>();
    let previous = job.before;
    for (let t = FROM; t < TO; t += 300) {
      const file = path.join(directory, "observations", `${t}.json`);
      let e = await readJson<SampledEvidence>(file);
      if (!e) {
        if (mode === "rebuild")
          throw new Error("Missing sample in offline rebuild");
        if (stopped || commits >= checkpoints) {
          console.log(
            JSON.stringify({
              phase: "sampling",
              nextTimestamp: t,
              paused: true,
              metrics: rpc.metrics,
            }),
          );
          return;
        }
        const guess = Math.min(job.end.number - 1, previous.number + 150),
          low = await chain.header(guess),
          high = await chain.header(guess + 1);
        const boundary =
          low.timestamp < t + 300 && high.timestamp >= t + 300
            ? { block: low, after: high }
            : await referenceBoundary(t, previous, job.end, chain.header);
        e = await sampledReader(scope, rpc.transport)(
          t,
          boundary.block,
          boundary.after,
        );
        await put(file, e);
        commits++;
      }
      assert.equal(e.timestamp, t);
      assert.equal(e.policyRevision, job.policyRevision);
      assert(
        e.block.timestamp < t + 300 &&
          e.after.timestamp >= t + 300 &&
          e.after.number === e.block.number + 1 &&
          e.after.parentHash === e.block.hash,
      );
      observations.set(t, deriveSampledObservation(scope, e));
      previous = e.block;
      if (observations.size % 96 === 0)
        console.log(
          JSON.stringify({
            phase: "sampling",
            buckets: observations.size,
            metrics: rpc.metrics,
          }),
        );
    }
    const summaries = [];
    let totalActions = 0;
    for (let from = FROM; from < TO; from += 86400) {
      if (stopped) return;
      const dir = path.join(directory, "days", String(from));
      await mkdir(path.join(dir, "pages"), { recursive: true });
      // Full contiguous evidence includes both midnight boundary blocks. No per-day re-fetch.
      const native = rebuildActivity(
        scope,
        job.metadata,
        inputs,
        from,
        from + 86400,
      );
      const pages = sampledPages(scope, native, observations);
      for (const p of pages)
        await immutableFile(path.join(dir, "pages", p.key), p.bytes);
      await put(path.join(dir, "publication.json"), {
        version: "sampled-local-publication-v1",
        sourceRevision: native.sourceRevision,
        policyRevision: job.policyRevision,
        from,
        to: from + 86400,
        pages: pages.map((p) => ({
          key: p.key,
          sha256: p.sha256,
          bytes: p.bytes.length,
        })),
      });
      const events = [...native.buckets].flatMap(([t, rows]) =>
        valuedActivity(scope, observations.get(t)!, rows),
      );
      assert.equal(new Set(events.map((e) => e.id)).size, events.length);
      await put(path.join(dir, "activity.json"), events);
      totalActions += events.length;
      for (const currency of ["ETH", "USDC"] as const) {
        const chart = await readLocalSampledMarket(
          dir,
          currency,
          from,
          from + 86400,
        );
        summaries.push({
          from,
          currency,
          buckets: chart.buckets.length,
          prices: chart.buckets.filter((b) => b.market.price !== null).length,
          candles: chart.buckets.filter((b) => b.market.candle !== null).length,
          events: events.length,
          trades: events.filter((e) => e.type === "buy" || e.type === "sell")
            .length,
          firstCoverage: chart.buckets[0].totals.eventCoverage,
        });
      }
    }
    const replayDir = await mkdtemp(path.join(directory, "parquet-"));
    let rawEvents = 0,
      trades = 0;
    for (let i = 0; i < inputs.length; i += 8) {
      const dir = path.join(replayDir, String(i));
      const built = await buildHistory(
        inputs.slice(i, i + 8),
        job.metadata,
        dir,
      );
      const replay = await rebuildParquet(dir, `${dir}-replay`);
      assert.deepEqual(replay.dataset, built.dataset);
      rawEvents += built.eventCount;
      trades += built.tradeCount;
    }
    const receipt = {
      version: "local-launch-week-proof-v1",
      from: FROM,
      to: TO,
      scopeId: scope.id,
      policyRevision: job.policyRevision,
      rawRanges: inputs.length,
      rawEvents,
      trades,
      activityEvents: totalActions,
      samples: observations.size,
      summaries,
      parquetReplayEqual: true,
      productionWrites: 0,
    };
    await put(path.join(directory, "receipt.json"), receipt);
    console.log(
      JSON.stringify({ phase: "complete", ...receipt, metrics: rpc.metrics }),
    );
  } catch (e) {
    if (failureCode(e) === "work-limit") {
      console.log(
        JSON.stringify({
          phase: "paused",
          reason: "invocation-bound",
          metrics: rpc.metrics,
        }),
      );
      return;
    }
    throw e;
  } finally {
    await writeFile(
      path.join(directory, "runs", `${Date.now()}-${randomUUID()}.json`),
      JSON.stringify({
        mode,
        started,
        elapsedMs: Date.now() - started,
        commits,
        metrics: rpc.metrics,
      }),
    );
  }
}
try {
  await withLocalLock(directory, execute);
} catch (e) {
  console.error(
    JSON.stringify({
      error:
        e instanceof Error && e.message.startsWith("Local writer locked")
          ? "local-writer-locked"
          : failureCode(e),
      frames:
        e instanceof Error
          ? e.stack
              ?.split("\n")
              .slice(1)
              .filter((l) => l.includes("/society-bots/"))
              .slice(0, 3)
          : undefined,
    }),
  );
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
