import type { Context } from "aws-lambda";
import { readFileSync } from "node:fs";
import { famePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { historyScope, integer } from "./model.ts";
import { aggregateNext } from "./worker.ts";
import { awsAggregation } from "./worker-storage.ts";
import type { TokenMetadata } from "./decode.ts";
import { publishReferences } from "./reference-worker.ts";
import { awsReferences } from "./reference-storage.ts";
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
    const scope = historyScope(famePoolStateRegistry);
    const outcomes = await Promise.allSettled([
      aggregateNext({
        scope,
        startBlock,
        metadata: tokenMetadata,
        store: awsAggregation({ table, bucket }),
      }),
      publishReferences(
        scope,
        awsReferences({ scope, table, bucket }),
        4,
        () => context.getRemainingTimeInMillis() > 20000,
      ),
    ]);
    console.log(
      JSON.stringify({
        event: "fame-reference-publication",
        status: outcomes[1].status,
        ...(outcomes[1].status === "fulfilled"
          ? { result: outcomes[1].value }
          : { code: failureCode(outcomes[1].reason) }),
      }),
    );
    for (const outcome of outcomes)
      if (outcome.status === "rejected") throw outcome.reason;
    const result = outcomes[0].status === "fulfilled" ? outcomes[0].value : {};
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
