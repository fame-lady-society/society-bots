import { SNS } from "@aws-sdk/client-sns";
import { APIEmbed } from "discord-api-types/v10";
import { createLogger } from "@/utils/logging.js";
import { zeroHash, TransactionReceipt } from "viem";
import { sepoliaClient, baseClient } from "@/viem.ts";
import { sendDiscordMessage } from "@/discord/pubsub/send.js";
import {
  getLastIndexedBlock,
  setLastIndexedBlock,
} from "../../dynamodb/fameIndex.ts";
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
import { CompleteSwapEvent } from "@/webhook/swap/types.js";
import {
  DiscordGuildChannelNotification,
  getNotifications,
} from "@/fame-event/dynamodb/discord-guilds-notifications.ts";
import { NotificationType } from "@/types.ts";

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
      fameBuyNotifications: APIEmbed[];
      fameSellNotifications: APIEmbed[];
      nftMintNotifications: APIEmbed[];
      nftBurnNotifications: APIEmbed[];
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
  const activeNotifications = await getNotifications();
  const activeNotificationMap = new Map<
    string,
    {
      guildId: string;
      channelId: string;
      notifications: NotificationType[];
    }
  >();
  for (const notification of activeNotifications) {
    const key = `${notification.guildId}:${notification.channelId}`;
    const existing = activeNotificationMap.get(key) ?? {
      guildId: notification.guildId,
      channelId: notification.channelId,
      notifications: [],
    };
    activeNotificationMap.set(key, {
      ...existing,
      notifications: [...existing.notifications, notification.notification],
    });
  }

  console.log(`Handling ${swapEvents.size} swap events`);
  for (const [_, swapEvent] of swapEventTransactionReceipts) {
    const fameBuyNotifications: APIEmbed[] = [];
    const fameSellNotifications: APIEmbed[] = [];
    const nftMintNotifications: APIEmbed[] = [];
    const nftBurnNotifications: APIEmbed[] = [];
    const recipient = swapEvent.receipt.from.toLowerCase() as `0x${string}`;
    const { buy, sell } = await notifyDiscordSwap({
      swapEvent,
      recipient,
      testnet: !!client.chain.testnet,
      blockNumber: swapEvent.receipt.blockNumber,
      tokenAddress,
      client,
      txHash: swapEvent.receipt.transactionHash,
    });
    if (buy) {
      fameBuyNotifications.push(...buy);
    }
    if (sell) {
      fameSellNotifications.push(...sell);
    }
    nftMintNotifications.push(
      ...(await notifyDiscordMint({
        testnet: !!client.chain.testnet,
        tokenIds: swapEvent.nftsMinted,
        toAddress: recipient,
        client,
        txHash: swapEvent.receipt.transactionHash,
      }))
    );
    nftBurnNotifications.push(
      ...(await notifyDiscordBurn({
        testnet: !!client.chain.testnet,
        tokenIds: swapEvent.nftsBurned,
        fromAddress: recipient,
        client,
        txHash: swapEvent.receipt.transactionHash,
      }))
    );

    const existing = transactionEmbeds.get(recipient) ?? [];
    transactionEmbeds.set(recipient, [
      ...existing,
      {
        fameBuyNotifications,
        fameSellNotifications,
        nftMintNotifications,
        nftBurnNotifications,
        swapEvent,
      },
    ]);
  }

  for (const events of transactionEmbeds.values()) {
    for (const {
      swapEvent,
      fameBuyNotifications,
      fameSellNotifications,
      nftMintNotifications,
      nftBurnNotifications,
    } of events) {
      for (const {
        channelId,
        notifications,
      } of activeNotificationMap.values()) {
        const embeds: APIEmbed[] = [];
        if (
          notifications.includes("fame-buy") &&
          fameBuyNotifications.length > 0
        ) {
          embeds.push(...fameBuyNotifications, ...nftMintNotifications);
        }
        if (
          notifications.includes("fame-sell") &&
          fameSellNotifications.length > 0
        ) {
          embeds.push(...fameSellNotifications, ...nftBurnNotifications);
        }
        if (
          notifications.includes("fame-nft-mint") &&
          !notifications.includes("fame-buy")
        ) {
          embeds.push(...nftMintNotifications);
        }
        if (
          notifications.includes("fame-nft-burn") &&
          !notifications.includes("fame-sell")
        ) {
          embeds.push(...nftBurnNotifications);
        }
        if (embeds.length === 0) {
          continue;
        }
        logger.info(
          `Sending ${embeds.length} embeds for transaction ${swapEvent.receipt.transactionHash} for ${channelId}`
        );
        await sendDiscordMessage({
          channelId,
          message: {
            embeds,
          },
          topicArn: DISCORD_MESSAGE_TOPIC_ARN,
          sns,
        });
      }
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
  logger.info("Starting handler");
  await Promise.allSettled([
    handleForClient({
      client: sepoliaClient,
      v2PoolAddress: SEPOLIA_EXAMPLE_WETH_V2_POOL,
      v3PoolAddress: SEPOLIA_EXAMPLE_WETH_V3_POOL,
      nftAddress: SEPOLIA_EXAMPLE_NFT_ADDRESS,
      tokenAddress: SEPOLIA_EXAMPLE_ADDRESS,
    }).catch((error) => {
      logger.error("Error handling events for sepolia", error);
    }),
    handleForClient({
      client: baseClient,
      v2PoolAddress: BASE_FAME_WETH_V2_POOL,
      v3PoolAddress: BASE_FAME_WETH_V3_POOL,
      nftAddress: BASE_FAME_NFT_ADDRESS,
      tokenAddress: BASE_FAME_ADDRESS,
    }).catch((error) => {
      logger.error("Error handling events for base", error);
    }),
  ]);
  logger.info("Handler finished");
};
