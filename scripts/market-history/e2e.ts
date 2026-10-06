import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildHistory,
  rebuildParquet,
} from "../../src/fame-market-history/analytics.ts";
const [source, output] = process.argv.slice(2);
if (!source || !output || process.argv.length !== 4)
  throw new Error("Usage: e2e.ts SOURCE_DIRECTORY NEW_OUTPUT_DIRECTORY");
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
if (!result.tradeCount)
  throw new Error("End-to-end sample must include trades");
console.log(
  JSON.stringify({
    event: "history-parquet-rebuild-verified",
    eventCount: result.eventCount,
    tradeCount: result.tradeCount,
    marketBuckets: result.dataset.market.length,
    parquetOnlyRebuildMatches: true,
    decoderReview: result.dataset.metadata.decoderReview,
  }),
);
