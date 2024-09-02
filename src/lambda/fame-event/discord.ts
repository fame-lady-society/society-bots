import { SNS } from "@aws-sdk/client-sns";
import { baseClient, mainnetClient, sepoliaClient } from "@/viem";
import { fetchMetadata } from "./metadata";
import { APIEmbedField } from "discord-api-types/v10";
import { sendDiscordMessage } from "@/discord/pubsub/send";
import { CompleteSwapEvent } from "@/webhook/swap/handler";

export async function notifyDiscordMint({
  tokenId,
  wrappedCount,
  toAddress,
  channelId,
  client,
  testnet,
  discordMessageTopicArn,
  sns,
}: {
  tokenId: bigint;
  wrappedCount: bigint;
  toAddress: `0x${string}`;
  channelId: string;
  client: typeof sepoliaClient | typeof mainnetClient | typeof baseClient;
  testnet: boolean;
  discordMessageTopicArn: string;
  sns: SNS;
}) {
  const ensName = await client.getEnsName({ address: toAddress });
  const displayName = ensName ? ensName : toAddress;
  const fields: APIEmbedField[] = [];
  fields.push({
    name: "token id",
    value: tokenId.toString(),
    inline: true,
  });
  fields.push({
    name: "by",
    value: displayName,
    inline: true,
  });
  if (testnet) {
    fields.push({
      name: "sepolia",
      value: "true",
      inline: true,
    });
  }
  fields.push({
    name: "minted",
    value: wrappedCount.toString(),
    inline: true,
  });

  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "$FAME Society Mint",
          description: `A new $FAME Society was minted${
            testnet ? " on Sepolia" : ""
          }`,
          image: {
            url: `https://www.fameladysociety.com/fame/token/image/${tokenId}`,
          },
          fields,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

export async function notifyDiscordBurn({
  tokenId,
  wrappedCount,
  fromAddress,
  channelId,
  client,
  testnet,
  discordMessageTopicArn,
  sns,
}: {
  tokenId: bigint;
  wrappedCount: bigint;
  fromAddress: `0x${string}`;
  channelId: string;
  client: typeof sepoliaClient | typeof mainnetClient | typeof baseClient;
  testnet: boolean;
  discordMessageTopicArn: string;
  sns: SNS;
}) {
  const ensName = await client.getEnsName({ address: fromAddress });
  const displayName = ensName ? ensName : fromAddress;
  const fields: APIEmbedField[] = [];
  fields.push({
    name: "token id",
    value: tokenId.toString(),
    inline: true,
  });
  fields.push({
    name: "by",
    value: displayName,
    inline: true,
  });
  if (testnet) {
    fields.push({
      name: "sepolia",
      value: "true",
      inline: true,
    });
  }
  fields.push({
    name: "burned",
    value: wrappedCount.toString(),
    inline: true,
  });

  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "$FAME Society Mint",
          description: `A new $FAME Society was burned${
            testnet ? " on Sepolia" : ""
          }`,
          image: {
            url: `https://www.fameladysociety.com/fame/token/image/${tokenId}`,
          },
          fields,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

export async function notifyDiscordSwap({
  completeSwapEvent,
  recipient,
  channelId,
  client,
  testnet,
  discordMessageTopicArn,
  sns,
}: {
  completeSwapEvent: CompleteSwapEvent;
  recipient: `0x${string}`;
  channelId: string;
  client: typeof sepoliaClient | typeof mainnetClient | typeof baseClient;
  testnet: boolean;
  discordMessageTopicArn: string;
  sns: SNS;
}) {
  
}
