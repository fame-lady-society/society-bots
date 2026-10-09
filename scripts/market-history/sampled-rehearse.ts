/** Read-only first-milestone probe. Writes a local evidence/response artifact only. */
import { writeFile } from "node:fs/promises";
import { fameHistoryRegistry } from "../../src/fame-market-history/registry.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
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
try {
  const output = process.argv[2],
    count = Number(process.argv[3] ?? 1);
  if (
    !output ||
    process.argv.length > 4 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 4
  )
    throw new Error("Usage: sampled-rehearse.ts output.json [1..4]");
  const url = process.env.FAME_HISTORY_RPC_URL;
  if (!url) throw new Error("Missing RPC configuration");
  const scope = historyScope(fameHistoryRegistry);
  const rpc = boundedTransport({
    url,
    maxRequests: 160,
    maxResponseBytes: 256 * 1024,
    deadline: Date.now() + 110_000,
  });
  const chain = chainReader(scope, rpc.transport, 1),
    head = await chain.finalized();
  const cache = new Map([[head.number, head]]);
  const header = async (n: number) => {
    let h = cache.get(n);
    if (!h) {
      h = await chain.header(n);
      cache.set(n, h);
    }
    return h;
  };
  const start = Math.floor(head.timestamp / 300) * 300 - count * 300;
  let distance = 500,
    low = await header(Math.max(0, head.number - distance));
  while (low.timestamp >= start + 300) {
    distance *= 2;
    if (low.number === 0) throw new Error("No historical bracket");
    low = await header(Math.max(0, head.number - distance));
  }
  const read = sampledReader(scope, rpc.transport),
    results = [];
  for (
    let timestamp = start;
    timestamp < start + count * 300;
    timestamp += 300
  ) {
    const boundary = await referenceBoundary(timestamp, low, head, header);
    const evidence = await read(timestamp, boundary.block, boundary.after);
    if (
      (await chain.header(boundary.after.number)).hash !== boundary.after.hash
    )
      throw new Error("Boundary changed");
    const observation = deriveSampledObservation(scope, evidence);
    // Event capture is not part of this probe: unknown volume must remain unknown.
    const responses = (["ETH", "USDC"] as const).map((currency) =>
      sampledMarketBucket(scope, currency, timestamp, observation, []),
    );
    results.push({ evidence, observation, responses });
    low = boundary.block;
  }
  await writeFile(
    output,
    JSON.stringify({ metrics: rpc.metrics, results }, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      event: "sampled-market-read-only",
      buckets: results.length,
      pricedSeries: results.map((r) =>
        r.responses.map((v) => ({
          currency: v.currency,
          available: v.series.filter((s) => s.price !== null).length,
        })),
      ),
      metrics: rpc.metrics,
    }),
  );
} catch {
  console.error(
    "Sampled market rehearsal failed; provider details withheld. Check arguments, access, limits and source qualification.",
  );
  process.exitCode = 1;
}
