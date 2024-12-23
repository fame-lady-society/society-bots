// import { EventBridgeEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import { SNS } from "@aws-sdk/client-sns";
import { createLogger } from "@/utils/logging.ts";
import { AbiEvent, Address, Hex, zeroAddress } from "viem";
import {
  fameLadySocietyAbi,
  fameLadySocietyAddress,
  fameLadySquadAddress,
  wrappedNftAddress,
} from "@/wagmi.generated.ts";
import { mainnetClient, sepoliaClient } from "@/viem.ts";
import { DefaultEventProcessor } from "./processor.ts";
import {
  notifyDiscordMetadataUpdate,
  notifyDiscordMultipleTokens,
  notifyDiscordSingleToken,
} from "./discord.ts";

type PromiseType<T extends Promise<any>> =
  T extends Promise<infer U> ? U : never;

const logger = createLogger({
  name: "fls-wrapper-event",
});

if (!process.env.DYNAMODB_REGION) {
  throw new Error("DYNAMODB_REGION not set");
}

if (!process.env.DYNAMODB_TABLE) {
  throw new Error("DYNAMODB_TABLE not set");
}

if (!process.env.DISCORD_MESSAGE_TOPIC_ARN) {
  throw new Error("DISCORD_MESSAGE_TOPIC_ARN not set");
}

if (!process.env.DISCORD_CHANNEL_ID) {
  throw new Error("DISCORD_CHANNEL_ID not set");
}

const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.DYNAMODB_REGION,
  }),
  {
    marshallOptions: {
      convertEmptyValues: true,
    },
  },
);

// Modify the handler to use the processor
export const handler = async () => {
  const sns = new SNS({});
  const sepoliaProcessor = new DefaultEventProcessor(
    sepoliaClient,
    wrappedNftAddress[11155111],
  );
  const mainnetProcessor = new DefaultEventProcessor(
    mainnetClient,
    fameLadySocietyAddress[1],
  );

  // Get last blocks from DynamoDB
  const [lastBlockSepoliaResponse, lastBlockMainnetResponse] =
    await Promise.all([
      db.send(
        new GetCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Key: {
            key: "lastBlockSepolia",
          },
        }),
      ),
      db.send(
        new GetCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Key: {
            key: "lastBlockMainnet",
          },
        }),
      ),
    ]);

  const [latestBlockSepolia, latestBlockMainnet] = await Promise.all([
    sepoliaClient.getBlockNumber(),
    mainnetClient.getBlockNumber(),
  ]);

  const lastBlockSepolia = BigInt(
    lastBlockSepoliaResponse.Item?.value ?? latestBlockSepolia,
  );
  const lastBlockMainnet = BigInt(
    lastBlockMainnetResponse.Item?.value ?? latestBlockMainnet,
  );

  const [sepoliaResult, mainnetResult] = await Promise.all([
    sepoliaProcessor.processEvents({
      fromBlock: lastBlockSepolia,
      toBlock: latestBlockSepolia,
    }),
    mainnetProcessor.processEvents({
      fromBlock: lastBlockMainnet,
      toBlock: latestBlockMainnet,
    }),
  ]);

  const promises: Promise<void>[] = [];

  // Group all transfer events by to address
  const sepoliaTransferEventsByToAddress = sepoliaResult.transferEvents.reduce(
    (acc, event) => {
      acc[event.args.to] = [...(acc[event.args.to] || []), event];
      return acc;
    },
    {} as Record<Address, typeof sepoliaResult.transferEvents>,
  );

  const mainnetTransferEventsByToAddress = mainnetResult.transferEvents.reduce(
    (acc, event) => {
      acc[event.args.to] = [...(acc[event.args.to] || []), event];
      return acc;
    },
    {} as Record<Address, typeof mainnetResult.transferEvents>,
  );

  for (const [toAddress, events] of Object.entries(
    sepoliaTransferEventsByToAddress,
  )) {
    const tokenIds = events.map(({ args }) => args.tokenId);
    if (tokenIds.length === 1) {
      promises.push(
        notifyDiscordSingleToken({
          tokenId: events[0].args.tokenId,
          wrappedCount: sepoliaResult.wrappedCount,
          toAddress: toAddress as Address,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: sepoliaClient,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          testnet: true,
          sns,
        }),
      );
    } else {
      promises.push(
        notifyDiscordMultipleTokens({
          tokenIds,
          wrappedCount: sepoliaResult.wrappedCount,
          toAddress: toAddress as Address,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: sepoliaClient,
          testnet: true,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          sns,
        }),
      );
    }
  }

  for (const [toAddress, events] of Object.entries(
    mainnetTransferEventsByToAddress,
  )) {
    const tokenIds = events.map(({ args }) => args.tokenId);
    if (tokenIds.length === 1) {
      promises.push(
        notifyDiscordSingleToken({
          tokenId: tokenIds[0],
          wrappedCount: mainnetResult.wrappedCount,
          toAddress: toAddress as Address,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: mainnetClient,
          testnet: false,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          sns,
        }),
      );
    } else {
      promises.push(
        notifyDiscordMultipleTokens({
          tokenIds,
          wrappedCount: mainnetResult.wrappedCount,
          toAddress: toAddress as Address,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: mainnetClient,
          testnet: false,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          sns,
        }),
      );
    }
  }

  for (const event of sepoliaResult.metadataEvents) {
    const {
      args: { _tokenId: tokenId },
    } = event;
    promises.push(
      notifyDiscordMetadataUpdate({
        address: wrappedNftAddress[11155111],
        tokenId,
        channelId: process.env.DISCORD_CHANNEL_ID!,
        client: sepoliaClient,
        testnet: true,
        discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
        sns,
      }),
    );
  }

  for (const event of mainnetResult.metadataEvents) {
    const {
      args: { _tokenId: tokenId },
    } = event;
    promises.push(
      notifyDiscordMetadataUpdate({
        address: fameLadySocietyAddress[1],
        tokenId,
        channelId: process.env.DISCORD_CHANNEL_ID!,
        client: mainnetClient,
        testnet: false,
        discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
        sns,
      }),
    );
  }

  await Promise.all(promises);

  await Promise.all([
    db.send(
      new PutCommand({
        TableName: process.env.DYNAMODB_TABLE,
        Item: {
          key: "lastBlockSepolia",
          value: Number(sepoliaResult.newBlock),
        },
      }),
    ),
    db.send(
      new PutCommand({
        TableName: process.env.DYNAMODB_TABLE,
        Item: {
          key: "lastBlockMainnet",
          value: Number(mainnetResult.newBlock),
        },
      }),
    ),
  ]);
};
