import { activeDataset } from "../../src/fame-market-history/dataset.ts";
import { retainLiveHistory } from "../../src/fame-market-history/retain-live-history.ts";
import { sampledPolicy } from "../../src/fame-market-history/sampled-market.ts";
/** Default read-only; --apply publishes only older dated pages. No RPC. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { materializeHistory } from "../../src/fame-market-history/materialize-history.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
try {
  const [directory, ...flags] = process.argv.slice(2);
  if (
    !directory ||
    new Set(flags).size !== flags.length ||
    flags.some((f) => !["--apply", "--retain-live"].includes(f))
  )
    throw new Error("Expected receipt directory [--retain-live] [--apply]");
  const apply = flags.includes("--apply");
  const table = process.env.FAME_HISTORY_TABLE,
    bucket = process.env.FAME_HISTORY_BUCKET;
  if (!table || !bucket) throw new Error("Missing storage target");
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 2 }),
  );
  const selected = await activeDataset(table, db);
  const scope = selected.scope;
  if (flags.includes("--retain-live")) {
    const receipt = await retainLiveHistory(
      db,
      table,
      sampledPolicy(scope).revision,
      apply,
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "retain-live.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify(receipt));
  } else {
    const receipt = await materializeHistory({
      scope,
      metadata: selected.metadata,
      table,
      bucket,
      db,
      from: Number(process.env.FAME_HISTORY_FROM),
      to: Number(process.env.FAME_HISTORY_TO),
      apply,
      progress: (row) => console.log(JSON.stringify(row)),
    });
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "historical-serving.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(JSON.stringify({ ...receipt, rows: receipt.rows.length }));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: "historical-serving-failed",
      code: failureCode(error),
    }),
  );
  process.exitCode = 1;
}
