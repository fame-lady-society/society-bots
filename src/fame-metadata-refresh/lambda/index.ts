import { SNS } from "@aws-sdk/client-sns";
import type { Context } from "aws-lambda";
import { baseClient, mainnetClient } from "@/viem.ts";
import { defaultDb } from "../dynamodb.ts";
import { runMetadataRefreshIndexer } from "../indexer.ts";

export async function handler(_event: unknown, context: Pick<Context, "getRemainingTimeInMillis">) {
  await runMetadataRefreshIndexer({
    client: baseClient,
    ensClient: mainnetClient,
    store: defaultDb,
    sns: new SNS({}),
    remainingTimeInMillis: () => context.getRemainingTimeInMillis(),
  });
}
