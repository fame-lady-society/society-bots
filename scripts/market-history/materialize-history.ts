/** Default read-only; --apply publishes only older dated pages. No RPC. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import { materializeHistory } from "../../src/fame-market-history/materialize-history.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
try {
  const [directory, mode, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || (mode !== undefined && mode !== "--apply"))
    throw new Error("Expected receipt directory [--apply]");
  const table = process.env.FAME_HISTORY_TABLE,
    bucket = process.env.FAME_HISTORY_BUCKET;
  if (!table || !bucket) throw new Error("Missing storage target");
  const metadata = JSON.parse(
    await readFile(
      new URL(
        "../../src/fame-market-history/token-metadata.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const receipt = await materializeHistory({
    scope: historyScope(famePoolStateRegistry),
    metadata,
    table,
    bucket,
    db: DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
    from: Number(process.env.FAME_HISTORY_FROM),
    to: Number(process.env.FAME_HISTORY_TO),
    apply: mode === "--apply",
    progress: (row) => console.log(JSON.stringify(row)),
  });
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "historical-serving.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify({ ...receipt, rows: receipt.rows.length }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: "historical-serving-failed",
      code: failureCode(error),
    }),
  );
  process.exitCode = 1;
}
