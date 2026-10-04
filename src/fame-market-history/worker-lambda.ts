import type { Context } from "aws-lambda";
import { readFileSync } from "node:fs";
import { famePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { historyScope, integer } from "./model.ts";
import { aggregateNext } from "./worker.ts";
import { awsAggregation } from "./worker-storage.ts";
import type { TokenMetadata } from "./decode.ts";
import { failureCode } from "./failure.ts";

export const tokenMetadata: TokenMetadata = JSON.parse(
  readFileSync(new URL("./token-metadata.json", import.meta.url), "utf8"),
);

export async function handler(_event: unknown, context: Context) {
  if (context.getRemainingTimeInMillis() < 110_000)
    throw new Error("Insufficient aggregation invocation time");
  const table = process.env.FAME_HISTORY_TABLE;
  const bucket = process.env.FAME_HISTORY_BUCKET;
  if (!table || !bucket)
    throw new Error("Missing history storage configuration");
  const startBlock = integer(
    Number(process.env.FAME_HISTORY_START_BLOCK),
    "start block",
    1,
  );
  try {
    const result = await aggregateNext({
      scope: historyScope(famePoolStateRegistry),
      startBlock,
      metadata: tokenMetadata,
      store: awsAggregation({ table, bucket }),
    });
    console.log(
      JSON.stringify({ event: "fame-history-aggregation", ...result }),
    );
    return result;
  } catch (error) {
    // SDK error text may contain credentials or request details. Leave the
    // checkpoint intact and retain failure evidence for operator inspection.
    console.error(
      JSON.stringify({
        event: "fame-history-aggregation-failed",
        code: failureCode(error),
      }),
    );
    throw new Error("History aggregation stopped; committed progress retained");
  }
}
