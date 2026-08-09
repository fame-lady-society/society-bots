import { SNS } from "@aws-sdk/client-sns";
import { baseClient, mainnetClient } from "@/viem.ts";
import { defaultDb } from "../dynamodb.ts";
import { runMetadataRefreshIndexer } from "../indexer.ts";

export async function handler() {
  await runMetadataRefreshIndexer({ client: baseClient, ensClient: mainnetClient, store: defaultDb, sns: new SNS({}) });
}
