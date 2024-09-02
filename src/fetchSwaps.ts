import "dotenv/config";
import { Block, Log, createPublicClient, fallback, http } from "viem";
import {
  BASE_FAME_ADDRESS,
  BASE_FAME_NFT_ADDRESS,
  BASE_FAME_WETH_V2_POOL,
  BASE_FAME_WETH_V3_POOL,
} from "./constants.js";
import { base } from "viem/chains";
import { promises as fs } from "fs";
import {
  ERC20TransferEventAbi,
  ERC721TransferEventAbi,
  UniswapV2SyncEvent,
  UniswapV3SwapEventAbi,
  uniswapV2SwapEventAbi,
} from "./events.ts";

const baseRpcs: string[] = JSON.parse(process.env.BASE_RPCS_JSON || "[]");

const client = createPublicClient({
  chain: base,
  transport: fallback(baseRpcs.map((rpc) => http(rpc, { batch: true }))),
});

type SwapV2Event = Log<
  bigint,
  number,
  false,
  undefined,
  true,
  [
    typeof uniswapV2SwapEventAbi,
    typeof UniswapV2SyncEvent,
    typeof ERC20TransferEventAbi
  ],
  "Swap" | "Sync" | "Transfer"
>;
type SwapV3Event = Log<
  bigint,
  number,
  false,
  typeof UniswapV3SwapEventAbi,
  true,
  [typeof UniswapV3SwapEventAbi, typeof ERC20TransferEventAbi],
  "Swap" | "Transfer"
>;
type ERC721TransferEvent = Log<
  bigint,
  number,
  false,
  typeof ERC721TransferEventAbi,
  true,
  [typeof ERC721TransferEventAbi],
  "Transfer"
>;

type AllEvents = SwapV2Event | SwapV3Event | ERC721TransferEvent;
type Output = {
  blocks: {
    transactions: {
      transactionHash: `0x${string}`;
      logs: AllEvents[];
    }[];
  }[];
};

type LogIndex = bigint & { __logIndex: true };
type TransactionIndex = bigint & { __transactionIndex: true };
type BlockNumber = bigint & { __blockNumber: true };

function asLogIndex(logIndex: bigint | number): LogIndex {
  return BigInt(logIndex) as LogIndex;
}
function asTransactionIndex(
  transactionIndex: bigint | number
): TransactionIndex {
  return BigInt(transactionIndex) as TransactionIndex;
}
function asBlockNumber(blockNumber: bigint): BlockNumber {
  return blockNumber as BlockNumber;
}

type AllEventAbi =
  | typeof uniswapV2SwapEventAbi
  | typeof UniswapV3SwapEventAbi
  | typeof ERC721TransferEventAbi
  | typeof ERC20TransferEventAbi
  | typeof UniswapV2SyncEvent;

// const [v2EventFilter, v3EventFilter, transferEventFilter] = await Promise.all([
//   client.createEventFilter({
//     address: BASE_FAME_WETH_V2_POOL,
//     event: UniswapV2SwapEventAbi,
//   }),
//   client.createEventFilter({
//     address: BASE_FAME_WETH_V3_POOL,
//     event: UniswapV3SwapEventAbi,
//   }),
//   client.createEventFilter({
//     address: BASE_FAME_NFT_ADDRESS,
//     event: TransferEventAbi,
//   }),
// ]);

async function* fetchLogsInChunks({
  address,
  logEvents,
  chunkSize = 1000n,
  fromBlock,
  toBlock = "latest",
}: {
  address: `0x${string}`;
  logEvents: AllEventAbi[];
  chunkSize: bigint;
  fromBlock: bigint;
  toBlock: bigint | "latest";
}) {
  let currentBlock = fromBlock;
  const latestBlock =
    toBlock === "latest" ? await client.getBlockNumber() : toBlock;

  while (currentBlock <= latestBlock) {
    const endBlock =
      currentBlock + chunkSize - 1n > latestBlock
        ? latestBlock
        : currentBlock + chunkSize - 1n;

    console.log(
      `Fetching contract address ${address} from ${currentBlock} to ${endBlock} of type ${logEvents
        .map(({ name }) => name)
        .join(", ")}`
    );
    const logs = await client.getLogs({
      address,
      fromBlock: currentBlock,
      events: logEvents,
      toBlock: endBlock,
    });
    if (logs.length > 0) {
      console.log(`Fetched ${logs.length} logs`);
    }
    yield logs;
    currentBlock = endBlock + 1n;
  }
}

async function fetchAllLogs({
  address,
  logEvents,
  chunkSize = 10000n,
}: {
  address: `0x${string}`;
  logEvents: AllEventAbi[];
  chunkSize?: bigint;
}) {
  let allLogs = [];
  for await (const logs of fetchLogsInChunks({
    address,
    logEvents,
    chunkSize,
    fromBlock: 17019740n,
    toBlock: "latest",
  })) {
    allLogs.push(...logs);
  }
  return allLogs;
}

const [v2Swaps, v3Swaps] = await Promise.all([
  // fetchAllLogs({
  //   address: "0x4200000000000000000000000000000000000006",
  //   logEvents: [ERC20TransferEventAbi],
  //   chunkSize: 100n,
  // }),
  // fetchAllLogs({
  //   address: BASE_FAME_ADDRESS,
  //   logEvents: [ERC20TransferEventAbi],
  // }),
  fetchAllLogs({
    address: BASE_FAME_WETH_V2_POOL,
    logEvents: [uniswapV2SwapEventAbi],
  }),
  fetchAllLogs({
    address: BASE_FAME_WETH_V3_POOL,
    logEvents: [UniswapV3SwapEventAbi],
  }),
  // fetchAllLogs({
  //   address: BASE_FAME_NFT_ADDRESS,
  //   logEvents: [ERC721TransferEventAbi],
  // }),
]);

// We have a bunch of events that have a `blockNumber`, 'transactionIndex' and a `logIndex` field.
// Recreate the blockchain history by organizing these events first in a Map<blockNumber, Map<transactionIndex, Map<logIndex, Event>>>
// which we will then sort by `blockNumber`, `transactionIndex` and `logIndex` to get the correct order of events.
// the final structure should look like:
// {
//   blocks: [{
//    transactions: [{
//      logs: [Event]
//    }]
//   }]
// }

function getOrCreateLogMap(
  transactionMap: Map<TransactionIndex, Map<LogIndex, AllEvents>>,
  transactionIndex: TransactionIndex
) {
  let logs = transactionMap.get(transactionIndex);
  if (!logs) {
    logs = new Map();
    transactionMap.set(transactionIndex, logs);
  }
  return logs;
}

function getOrCreateTransactionMap(
  blockMap: Map<BlockNumber, Map<TransactionIndex, Map<LogIndex, AllEvents>>>,
  blockNumber: BlockNumber,
  transactionIndex: TransactionIndex
) {
  let transactions = blockMap.get(blockNumber);
  if (!transactions) {
    transactions = new Map();
    blockMap.set(blockNumber, transactions);
  }
  return getOrCreateLogMap(transactions, transactionIndex);
}

const blockTransactionMap = new Map<
  BlockNumber,
  Map<TransactionIndex, Map<LogIndex, AllEvents>>
>();

for (const event of [...v2Swaps, ...v3Swaps]) {
  const blockNumber = asBlockNumber(event.blockNumber);
  const transactionIndex = asTransactionIndex(event.transactionIndex);
  const logIndex = asLogIndex(event.logIndex);

  const logs = getOrCreateTransactionMap(
    blockTransactionMap,
    blockNumber,
    transactionIndex
  );
  logs.set(logIndex, event as any);
}

const sortedBlocks = [...blockTransactionMap.keys()].sort((a, b) =>
  Number(a - b)
);

const output: Output = {
  blocks: sortedBlocks.map((blockNumber) => {
    const block = blockTransactionMap.get(blockNumber);
    if (!block) {
      return {
        transactions: [],
      };
    }

    const sortedTransactions = [...block.keys()].sort((a, b) => Number(a - b));

    return {
      transactions: sortedTransactions.map((transactionIndex) => {
        // should always exist
        const transaction = block.get(transactionIndex)!;
        const sortedLogs = [...transaction.keys()].sort((a, b) =>
          Number(a - b)
        );

        return {
          // we know there is always at least 1 entry in sortedLogs
          transactionHash: transaction.get(sortedLogs[0])!.transactionHash!,
          logs: sortedLogs.map((logIndex) => transaction.get(logIndex)!),
        };
      }),
    };
  }),
};

// for each transaction, get all of the logs
// await Promise.all(
//   output.blocks.flatMap(({ transactions }) =>
//     transactions.map(async ({ }))
//   )
// );
// )

function bigintReplacer(key: string, value: any) {
  return typeof value === "bigint" ? value.toString() : value;
}
// await fs.writeFile(
//   "fameEventsAll.json",
//   JSON.stringify(allLogs, bigintReplacer, 2)
// );
await fs.writeFile(
  "fameEvents.json",
  JSON.stringify(output, bigintReplacer, 2)
);
