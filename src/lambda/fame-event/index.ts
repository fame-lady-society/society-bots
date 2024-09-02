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
import { APIEmbedField } from "discord-api-types/v10";
import { createLogger } from "@/utils/logging.js";
import { zeroHash, AbiEvent } from "viem";
import { sepoliaClient, mainnetClient, baseClient } from "@/viem.js";
import { fetchMetadata } from "./metadata.js";
import { sendDiscordMessage } from "@/discord/pubsub/send.js";
import { getLastIndexedBlock } from "./data.js";
import { base, sepolia } from "viem/chains";
import { uniswapV2SwapEventAbi, transferEvent, uniswapV3SwapEventAbi } from "@/events.js";
import { BASE_FAME_NFT_ADDRESS, BASE_FAME_WETH_V2_POOL, BASE_FAME_WETH_V3_POOL, SEPOLIA_EXAMPLE_NFT_ADDRESS, SEPOLIA_EXAMPLE_WETH_V2_POOL, SEPOLIA_EXAMPLE_WETH_V3_POOL } from "@/constants";
import { DISCORD_CHANNEL_ID, DISCORD_MESSAGE_TOPIC_ARN } from "./config.js";
import { notifyDiscordSingleMint } from "./discord.ts";

type PromiseType<T extends Promise<any>> = T extends Promise<infer U>
  ? U
  : never;

const logger = createLogger({
  name: "fame-event",
});



async function findEvents<E extends AbiEvent>(
  client: typeof sepoliaClient | typeof mainnetClient,
  contractAddress: `0x${string}`,
  event: E,
  fromBlock: bigint,
  toBlock: bigint
) {
  const events = await client.getLogs({
    address: contractAddress,
    fromBlock,
    toBlock,
    event,
    strict: true,
  });

  return events.map((event) => {
    return {
      ...event,
      blockNumber: event.blockNumber,
    };
  });
}


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
  const [lastBlockResponse,latestBlock] = await Promise.all([
    getLastIndexedBlock({
      chainId: client.chain.id,
    }),
    client.getBlockNumber(),
  ]);
  const lastBlock = BigInt(
    lastBlockResponse?.block ?? latestBlock
  );
  const [
    v3SwapEvents,
    v2SwapEvents,
    nftTransferEvents,,
  ] = await Promise.all([
    findEvents<typeof uniswapV3SwapEventAbi>(
      sepoliaClient,
      v3PoolAddress,
      uniswapV3SwapEventAbi,
      lastBlock,
      latestBlock
    ),
    findEvents<typeof uniswapV2SwapEventAbi>(
      sepoliaClient,
      v2PoolAddress,
      uniswapV2SwapEventAbi,
      lastBlock,
      latestBlock
    ),
    findEvents<typeof transferEvent>(
      sepoliaClient,
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
  const {latestBlock, v2SwapEvents, v3SwapEvents, nftTransferEvents} = await eventsForClient({
    client,
    v2PoolAddress,
    v3PoolAddress,
    nftAddress,
  });
  
  const eventsMint = new Set<
      PromiseType<ReturnType<typeof findEvents<typeof transferEvent>>>[0]
    >();

  const eventsBurn = new Set<
    PromiseType<ReturnType<typeof findEvents<typeof transferEvent>>>[0]
  >();
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
    swapEvents: swapEventTransactionHashes
  };
}

export const handleForClient = async ({
  client,
  v2PoolAddress,
  v3PoolAddress,
  nftAddress,
}: {
  client: typeof sepoliaClient | typeof baseClient;
  v2PoolAddress: `0x${string}`;
  v3PoolAddress: `0x${string}`;
  nftAddress: `0x${string}`;
}) =>
  // event: EventBridgeEvent<"check-fls-wrap", void>
  {
    const {
      latestBlock,
      mints,
      burns,
      swapEvents
    } = await aggregateEventsForClient({
      client: sepoliaClient,
      v2PoolAddress: SEPOLIA_EXAMPLE_WETH_V2_POOL,
      v3PoolAddress: SEPOLIA_EXAMPLE_WETH_V3_POOL,
      nftAddress: SEPOLIA_EXAMPLE_NFT_ADDRESS,
    })

    // Notify discord
    const sns = new SNS({});
    
    const eventsMintByTo = new Map<
      `0x${string}`,
      PromiseType<ReturnType<typeof findEvents<typeof transferEvent>>>
    >();
    for (const event of mints) {
      const { args: { to } } = event;
      if (!eventsMintByTo.has(to)) {
        eventsMintByTo.set(to, []);
      }
      eventsMintByTo.get(to)?.push(event);
    }

    const eventsBurnByFrom = new Map<
      `0x${string}`,
      PromiseType<ReturnType<typeof findEvents<typeof transferEvent>>>
    >();
    for (const event of burns) {
      const { args: { from } } = event;
      if (!eventsBurnByFrom.has(from)) {
        eventsBurnByFrom.set(from, []);
      }
      eventsBurnByFrom.get(from)?.push(event);
    }

    for (const [to, events] of eventsMintByTo.entries()) {
      const tokenIds = events.map(({ args }) => args.tokenId);
      if (tokenIds.length === 1) {
        await notifyDiscordSingleMint({
          tokenId: tokenIds[0],
          toAddress: to,
          channelId: DISCORD_CHANNEL_ID,
          client,
          discordMessageTopicArn: DISCORD_MESSAGE_TOPIC_ARN,
          testnet: !!client.chain.testnet,
          sns,
        });
      } else {
        await notifyDiscordMultipleTokens({
          tokenIds,
          wrappedCount: 0n, // fake
          toAddress: to,
          channelId: process.env.DISCORD_CHANNEL_ID,
          client: sepoliaClient,
          testnet: true,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN,
          sns,
        });
      }
    }

    for (const [to, events] of mainnetEventsByTo.entries()) {
      const tokenIds = events.map(({ args }) => args.tokenId);
      if (tokenIds.length === 1) {
        await notifyDiscordSingleToken({
          tokenId: tokenIds[0],
          wrappedCount,
          toAddress: to,
          channelId: process.env.DISCORD_CHANNEL_ID,
          client: mainnetClient,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN,
          testnet: false,
          sns,
        });
      } else {
        await notifyDiscordMultipleTokens({
          tokenIds,
          wrappedCount,
          toAddress: to,
          channelId: process.env.DISCORD_CHANNEL_ID,
          client: mainnetClient,
          testnet: false,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN,
          sns,
        });
      }
    }

    for (const event of sepoliaMetadataEvents) {
      const {
        args: { _tokenId: tokenId },
      } = event;
      await notifyDiscordMetadataUpdate({
        address: wrappedNftAddress[5],
        tokenId,
        channelId: process.env.DISCORD_CHANNEL_ID,
        client: sepoliaClient,
        testnet: true,
        discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN,
        sns,
      });
    }

    for (const event of mainnetMetadataEvents) {
      const {
        args: { _tokenId: tokenId },
      } = event;
      await notifyDiscordMetadataUpdate({
        address: fameLadySocietyAddress[1],
        tokenId,
        channelId: process.env.DISCORD_CHANNEL_ID,
        client: mainnetClient,
        testnet: false,
        discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN,
        sns,
      });
    }

    await Promise.all([
      db.send(
        new PutCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Item: {
            key: "lastBlockSepolia",
            value: Number(latestBlockSepolia + 1n),
          },
        })
      ),
      db.send(
        new PutCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Item: {
            key: "lastBlockMainnet",
            value: Number(latestBlockMainnet + 1n),
          },
        })
      ),
    ]);
  };
