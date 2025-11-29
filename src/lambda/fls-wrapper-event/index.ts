// import { EventBridgeEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import { SNS } from "@aws-sdk/client-sns";
import { createLogger } from "@/utils/logging.ts";
import { Address } from "viem";
import {
  fameLadySocietyAbi,
  fameLadySocietyAddress,
  fameLadySquadAddress,
  saveLadyProxyAddress,
  vaultDonatorAddress,
} from "@/wagmi.generated.ts";
import { mainnetClient } from "@/viem.ts";
import { DefaultEventProcessor } from "./processor.ts";
import {
  notifyDiscordMetadataUpdate,
  notifyDiscordMultipleSweepAndWrap,
  notifyDiscordMultipleTokens,
  notifyDiscordMultipleWrappedAndDonated,
  notifyDiscordSingleSweepAndWrap,
  notifyDiscordSingleToken,
  notifyDiscordSingleWrappedAndDonated,
} from "./discord.ts";

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
  const mainnetProcessor = new DefaultEventProcessor(
    mainnetClient,
    fameLadySocietyAddress[1],
    fameLadySquadAddress[1],
    saveLadyProxyAddress[1],
    vaultDonatorAddress[1],
  );

  // Get last block from DynamoDB
  const lastBlockMainnetResponse = await db.send(
    new GetCommand({
      TableName: process.env.DYNAMODB_TABLE,
      Key: {
        key: "lastBlockMainnet",
      },
    }),
  );

  const latestBlockMainnet = await mainnetClient.getBlockNumber();

  const lastBlockMainnet = BigInt(
    lastBlockMainnetResponse.Item?.value ?? latestBlockMainnet,
  );

  const mainnetResult = await mainnetProcessor.processEvents({
    fromBlock: lastBlockMainnet,
    toBlock: latestBlockMainnet,
  });

  const promises: Promise<void>[] = [];

  // Group all transfer events by transactionHash and to address
  const transferGroupsByTxAndAddress = mainnetResult.transferEvents.reduce(
    (acc, event) => {
      const key = `${event.transactionHash}-${event.args.to}`;
      if (!acc[key]) {
        acc[key] = {
          address: event.args.to,
          transactionHash: event.transactionHash,
          tokenIds: [],
        };
      }
      acc[key].tokenIds.push(event.args.tokenId);
      return acc;
    },
    {} as Record<
      string,
      { address: Address; transactionHash: `0x${string}`; tokenIds: bigint[] }
    >,
  );

  const transferGroups = Object.values(transferGroupsByTxAndAddress);

  for (const group of transferGroups) {
    if (group.tokenIds.length === 1) {
      promises.push(
        notifyDiscordSingleToken({
          tokenId: group.tokenIds[0],
          wrappedCount: mainnetResult.wrappedCount,
          toAddress: group.address,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: mainnetClient,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          blockExplorerUrl: "https://etherscan.io",
          txHash: group.transactionHash,
          sns,
        }),
      );
    } else {
      promises.push(
        notifyDiscordMultipleTokens({
          tokenIds: group.tokenIds,
          wrappedCount: mainnetResult.wrappedCount,
          toAddress: group.address,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: mainnetClient,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          blockExplorerUrl: "https://etherscan.io",
          txHash: group.transactionHash,
          sns,
        }),
      );
    }
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
        discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
        sns,
      }),
    );
  }

  for (const event of mainnetResult.sweepAndWrapEvents) {
    const {
      args: { tokenIds, totalPrice, buyer },
      transactionHash,
    } = event;
    if (tokenIds.length === 1) {
      promises.push(
        notifyDiscordSingleSweepAndWrap({
          tokenId: tokenIds[0],
          wrappedCount: mainnetResult.wrappedCount,
          fromAddress: buyer,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: mainnetClient,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          sns,
          blockExplorerUrl: "https://etherscan.io",
          txHash: transactionHash,
          ethCost: totalPrice,
        }),
      );
    } else {
      promises.push(
        notifyDiscordMultipleSweepAndWrap({
          tokenIds: tokenIds.slice(),
          wrappedCount: mainnetResult.wrappedCount,
          fromAddress: buyer,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: mainnetClient,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          sns,
          blockExplorerUrl: "https://etherscan.io",
          txHash: transactionHash,
          ethCost: totalPrice,
        }),
      );
    }
  }
  const promiseTotalDonatedCount =
    mainnetResult.wrappedAndDonatedEvents.length > 0
      ? mainnetClient.readContract({
          address: fameLadySocietyAddress[1],
          abi: fameLadySocietyAbi,
          functionName: "balanceOf",
          args: ["0xCDF3e235A04624d7f23909EbBaD008Db2c54e1cF"],
        })
      : Promise.resolve(0n);

  for (const event of mainnetResult.wrappedAndDonatedEvents) {
    const {
      args: { tokenIds, donor },
      transactionHash,
    } = event;

    if (tokenIds.length === 1) {
      promises.push(
        promiseTotalDonatedCount.then((totalDonatedCount) =>
          notifyDiscordSingleWrappedAndDonated({
            tokenId: tokenIds[0],
            wrappedCount: mainnetResult.wrappedCount,
            fromAddress: donor,
            channelId: process.env.DISCORD_CHANNEL_ID!,
            client: mainnetClient,
            discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
            sns,
            blockExplorerUrl: "https://etherscan.io",
            txHash: transactionHash,
            totalDonatedCount,
          }),
        ),
      );
    } else {
      promises.push(
        promiseTotalDonatedCount.then((totalDonatedCount) =>
          notifyDiscordMultipleWrappedAndDonated({
            tokenIds: tokenIds.slice(),
            wrappedCount: mainnetResult.wrappedCount,
            fromAddress: donor,
            channelId: process.env.DISCORD_CHANNEL_ID!,
            client: mainnetClient,
            discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
            sns,
            blockExplorerUrl: "https://etherscan.io",
            txHash: transactionHash,
            totalDonatedCount,
          }),
        ),
      );
    }
  }

  await Promise.all(promises);

  await db.send(
    new PutCommand({
      TableName: process.env.DYNAMODB_TABLE,
      Item: {
        key: "lastBlockMainnet",
        value: Number(mainnetResult.newBlock),
      },
    }),
  );
};
