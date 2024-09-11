// import { EventBridgeEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  fameLadySocietyAbi,
  fameLadySocietyAddress,
  uniswapV3PoolAbi,
  uniswapV2PoolAbi,
} from "@/wagmi.generated.ts";
import { SNS } from "@aws-sdk/client-sns";
import { APIEmbed, APIEmbedField } from "discord-api-types/v10";
import { createLogger } from "@/utils/logging.js";
import { zeroHash, AbiEvent, TransactionReceipt } from "viem";
import { sepoliaClient, baseClient } from "@/viem.ts";
import { fetchMetadata } from "./metadata.js";
import { sendDiscordMessage } from "@/discord/pubsub/send.js";
import { getLastIndexedBlock, setLastIndexedBlock } from "./data.js";
import { base, sepolia } from "viem/chains";
import {
  uniswapV2SwapEventAbi,
  transferEvent,
  uniswapV3SwapEventAbi,
} from "@/events.js";
import {
  BASE_FAME_ADDRESS,
  BASE_FAME_NFT_ADDRESS,
  BASE_FAME_WETH_V2_POOL,
  BASE_FAME_WETH_V3_POOL,
  SEPOLIA_EXAMPLE_ADDRESS,
  SEPOLIA_EXAMPLE_NFT_ADDRESS,
  SEPOLIA_EXAMPLE_WETH_V2_POOL,
  SEPOLIA_EXAMPLE_WETH_V3_POOL,
} from "@/constants.ts";
import { DISCORD_CHANNEL_ID, DISCORD_MESSAGE_TOPIC_ARN } from "./config.js";
import {
  notifyDiscordBurn,
  notifyDiscordMint,
  notifyDiscordSwap,
} from "./discord.ts";
import { findEvents } from "./utils.ts";
import { EventType } from "./types.ts";
import { aggregateLogs, aggregateSwapEvents } from "./aggregate.ts";
import { CompleteSwapEvent } from "@/webhook/swap/types.ts";

type PromiseType<T extends Promise<any>> = T extends Promise<infer U>
  ? U
  : never;

const logger = createLogger({
  name: "fame-event",
});

async function eventsForClient({
  client,
  v2PoolAddress,
  v3PoolAddress,
  nftAddress,
}: {
  client: typeof sepoliaClient | typeof baseClient;
  v2PoolAddress: `0x${string}`;
  v3PoolAddress: `0x${string}`;
  nftAddress: `0x${string}`;
}) {
  const [lastBlockResponse, latestBlock] = await Promise.all([
    getLastIndexedBlock({
      chainId: client.chain.id,
    }),
    client.getBlockNumber(),
  ]);
  const lastBlock = BigInt(lastBlockResponse?.block ?? latestBlock);
  const [v3SwapEvents, v2SwapEvents, nftTransferEvents, ,] = await Promise.all([
    findEvents<typeof uniswapV3SwapEventAbi>(
      client as typeof sepoliaClient,
      v3PoolAddress,
      uniswapV3SwapEventAbi,
      lastBlock,
      latestBlock
    ),
    findEvents<typeof uniswapV2SwapEventAbi>(
      client as typeof sepoliaClient,
      v2PoolAddress,
      uniswapV2SwapEventAbi,
      lastBlock,
      latestBlock
    ),
    findEvents<typeof transferEvent>(
      client as typeof sepoliaClient,
      nftAddress,
      transferEvent,
      lastBlock,
      latestBlock
    ),
  ]);
  return {
    v3SwapEvents,
    v2SwapEvents,
    nftTransferEvents,
    latestBlock,
  };
}

async function aggregateEventsForClient({
  client,
  v2PoolAddress,
  v3PoolAddress,
  nftAddress,
}: {
  client: typeof sepoliaClient | typeof baseClient;
  v2PoolAddress: `0x${string}`;
  v3PoolAddress: `0x${string}`;
  nftAddress: `0x${string}`;
}) {
  const { latestBlock, v2SwapEvents, v3SwapEvents, nftTransferEvents } =
    await eventsForClient({
      client,
      v2PoolAddress,
      v3PoolAddress,
      nftAddress,
    });

  const eventsMint = new Set<EventType<typeof transferEvent>>();
  const eventsBurn = new Set<EventType<typeof transferEvent>>();
  const swapEventTransactionHashes = new Set<`0x${string}`>();

  // First get all transaction hashes we are interested in
  for (const event of v2SwapEvents) {
    swapEventTransactionHashes.add(event.transactionHash);
  }
  for (const event of v3SwapEvents) {
    swapEventTransactionHashes.add(event.transactionHash);
  }

  for (const event of nftTransferEvents) {
    if (swapEventTransactionHashes.has(event.transactionHash)) {
      continue;
    }
    if (event.args.to === zeroHash) {
      eventsMint.add(event);
    } else if (event.args.from === zeroHash) {
      eventsBurn.add(event);
    }
  }

  return {
    latestBlock,
    mints: eventsMint,
    burns: eventsBurn,
    swapEvents: swapEventTransactionHashes,
  };
}

export const handleForClient = async ({
  client,
  v2PoolAddress,
  v3PoolAddress,
  nftAddress,
  tokenAddress,
}: {
  client: typeof sepoliaClient | typeof baseClient;
  v2PoolAddress: `0x${string}`;
  v3PoolAddress: `0x${string}`;
  nftAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
}) => {
  console.log(`Handling events for chain ${client.chain.name}`);
  const { latestBlock, swapEvents } = await aggregateEventsForClient({
    client,
    v2PoolAddress,
    v3PoolAddress,
    nftAddress,
  });
  console.log(
    `Found ${swapEvents.size} swap events for chain ${client.chain.name}`
  );
  // fetch all transaction receipts for swap events
  const swapEventTransactionReceipts = await Promise.all(
    [...swapEvents].map((txHash) =>
      Promise.all([
        client.getTransactionReceipt({
          hash: txHash,
        }),
        client.getTransaction({
          hash: txHash,
        }),
      ]).then(async ([receipt, tx]) => {
        const logs = await aggregateLogs({ logs: receipt.logs });
        return [
          txHash,
          {
            receipt,
            ...logs,
            ...aggregateSwapEvents({
              ...logs,
              from: tx.from!,
              to: tx.to!,
              value: tx.value,
            }),
          },
        ] as const;
      })
    )
  );

  // Notify discord
  const sns = new SNS({});

  const transactionEmbeds = new Map<
    `0x${string}`,
    {
      embeds: APIEmbed[];
      swapEvent: {
        readonly isArb: boolean;
        readonly nftsMinted: bigint[];
        readonly nftsBurned: bigint[];
        readonly wethBalanceDelta: Map<`0x${string}`, bigint>;
        readonly tokenBalanceDelta: Map<`0x${string}`, bigint>;
        readonly recipientMap: Map<`0x${string}`, CompleteSwapEvent>;
        readonly currentUsdPrice: number;
        readonly receipt: TransactionReceipt;
      };
    }[]
  >();

  console.log(`Handling ${swapEvents.size} swap events`);
  for (const [_, swapEvent] of swapEventTransactionReceipts) {
    const embeds: APIEmbed[] = [];
    const recipient = swapEvent.receipt.from.toLowerCase() as `0x${string}`;
    embeds.push(
      ...(await notifyDiscordSwap({
        swapEvent,
        recipient,
        testnet: !!client.chain.testnet,
        blockNumber: swapEvent.receipt.blockNumber,
        tokenAddress,
        client,
      }))
    );

    embeds.push(
      ...(await notifyDiscordMint({
        testnet: !!client.chain.testnet,
        tokenIds: swapEvent.nftsMinted,
        toAddress: recipient,
      }))
    );
    embeds.push(
      ...(await notifyDiscordBurn({
        testnet: !!client.chain.testnet,
        tokenIds: swapEvent.nftsBurned,
        fromAddress: recipient,
      }))
    );

    const existing = transactionEmbeds.get(recipient) ?? [];
    transactionEmbeds.set(recipient, [
      ...existing,
      {
        embeds,
        swapEvent,
      },
    ]);
  }

  for (const events of transactionEmbeds.values()) {
    for (const { embeds, swapEvent } of events) {
      if (embeds.length === 0) {
        logger.warn(
          `No embeds for transaction ${swapEvent.receipt.transactionHash}`
        );
        continue;
      }
      logger.info(
        `Sending ${embeds.length} embeds for transaction ${swapEvent.receipt.transactionHash}`
      );
      await sendDiscordMessage({
        channelId: DISCORD_CHANNEL_ID,
        message: {
          embeds,
        },
        topicArn: DISCORD_MESSAGE_TOPIC_ARN,
        sns,
      });
    }
  }
  console.log(
    `Handled ${swapEvents.size} swap events and setting last block to ${latestBlock} for chain ${client.chain.name}`
  );
  await setLastIndexedBlock({
    chainId: client.chain.id,
    block: Number(latestBlock),
  });
};

export const handler = async () => {
  console.log("Starting handler");
  try {
    const results = await Promise.allSettled([
      handleForClient({
        client: sepoliaClient,
        v2PoolAddress: SEPOLIA_EXAMPLE_WETH_V2_POOL,
        v3PoolAddress: SEPOLIA_EXAMPLE_WETH_V3_POOL,
        nftAddress: SEPOLIA_EXAMPLE_NFT_ADDRESS,
        tokenAddress: SEPOLIA_EXAMPLE_ADDRESS,
      }),
      handleForClient({
        client: baseClient,
        v2PoolAddress: BASE_FAME_WETH_V2_POOL,
        v3PoolAddress: BASE_FAME_WETH_V3_POOL,
        nftAddress: BASE_FAME_NFT_ADDRESS,
        tokenAddress: BASE_FAME_ADDRESS,
      }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
  } catch (error) {
    logger.error("Error handling events", error);
  }
};
