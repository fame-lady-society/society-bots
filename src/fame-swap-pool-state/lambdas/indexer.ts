import { baseClient } from "@/viem.ts";
import { FAME_POOL_STATE_CONFIRMATION_BLOCKS, FAME_POOL_STATE_TABLE_NAME } from "../config.ts";
import {
  createViemPoolStateIndexerClient,
  indexFamePoolStates,
} from "../indexer.ts";

export async function handler(): Promise<void> {
  const result = await indexFamePoolStates({
    client: createViemPoolStateIndexerClient(baseClient),
    tableName: FAME_POOL_STATE_TABLE_NAME,
    confirmationBlocks: FAME_POOL_STATE_CONFIRMATION_BLOCKS,
  });

  console.log(
    JSON.stringify({
      event: "fame-pool-state-indexed",
      ...result,
    }),
  );
}
