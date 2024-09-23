/*
 * This is an always on NodeJS process that listens for events from the blockchain and adds
 * them to a queue for further processing.
 */

import { getLastIndexedBlock } from "@/fame-event/dynamodb/fameIndex.ts";
import { CHAIN_ID, CLIENT } from "./config.ts";
import { v2PoolForChain, v3PoolForChain } from "@/constants.ts";
import { uniswapV2SwapEventAbi, uniswapV3SwapEventAbi } from "@/events.ts";
import { logger } from "@/utils/logging.ts";
import { createIncomingLogListener } from "./incoming.ts";

export async function listen() {
  const lastIndexedBlock = await getLastIndexedBlock({ chainId: CHAIN_ID });
  const blockNumber = lastIndexedBlock ? lastIndexedBlock.block : 0;

  const onError = (error: Error) => {
    logger.error(error, "Error watching event");
  };

  const { onV2Logs, onV3Logs } = createIncomingLogListener(
    ({ v2Logs, v3Logs }) => {
      // what we need are all unique transaction hashes
      const transactionHashes = new Set<`0x${string}`>();
      for (const log of v2Logs.flat()) {
        transactionHashes.add(log.transactionHash);
      }
      for (const log of v3Logs.flat()) {
        transactionHashes.add(log.transactionHash);
      }
    }
  );

  const unsubscribeV2Swap = CLIENT.watchEvent({
    address: v2PoolForChain(CHAIN_ID),
    event: uniswapV2SwapEventAbi,
    strict: true,
    onLogs: onV2Logs,
    onError,
  });

  const unsubscribeV3Swap = CLIENT.watchEvent({
    address: v3PoolForChain(CHAIN_ID),
    event: uniswapV3SwapEventAbi,
    strict: true,
    onLogs: onV3Logs,
    onError,
  });

  process.on("SIGINT", () => {
    unsubscribeV2Swap();
    unsubscribeV3Swap();
    process.exit(0);
  });
}
