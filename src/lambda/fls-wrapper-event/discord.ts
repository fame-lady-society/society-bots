import { sendDiscordMessage } from "@/discord/pubsub/send.ts";
import { customDescription, fetchMetadata } from "./metadata.ts";
import { mainnetClient, sepoliaClient } from "@/viem.ts";
import { createLogger } from "@/utils/logging.ts";
import { SNS } from "@aws-sdk/client-sns";
import { APIEmbedField } from "discord-api-types/v10";
import { GetEnsNameReturnType } from "viem";

const logger = createLogger({
  name: "fls-wrapper-event:discord",
});

async function redirectFromGet(url: string) {
  const controller = new AbortController();
  try {
    const timeoutId = setTimeout(() => controller.abort(), 1000);

    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 302) {
      return response.headers.get("location") ?? url;
    }
    return url;
  } catch (error) {
    if (controller.signal.aborted) {
      logger.warn(`Timedout following redirect for ${url}`);
    } else {
      logger.error(`Failed to follow redirect for ${url}`);
    }
    return url;
  }
}

export async function notifyDiscordMetadataUpdate({
  address,
  tokenId,
  channelId,
  client,
  testnet,
  discordMessageTopicArn,
  sns,
}: {
  address: `0x${string}`;
  tokenId: bigint;
  channelId: string;
  client: typeof sepoliaClient | typeof mainnetClient;
  testnet: boolean;
  discordMessageTopicArn: string;
  sns: SNS;
}) {
  const [ensName, metadata] = await Promise.all([
    client.getEnsName({ address }),
    fetchMetadata({
      client,
      address,
      tokenId,
    }),
  ]);
  const displayName = ensName ? ensName : address;
  const fields: APIEmbedField[] = [];
  fields.push({
    name: "name",
    value: metadata.name,
    inline: true,
  });
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
  const description = customDescription(metadata);
  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#FAMEUS",
          description:
            description ?? `A lady was named${testnet ? " on Sepolia" : ""}`,
          fields,
          image: {
            url: await redirectFromGet(
              `https://fls-www.vercel.app/${testnet ? "sepolia" : "mainnet"}/og/token/${tokenId}`,
            ),
          },
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

export async function notifyDiscordSingleToken({
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
  client: typeof sepoliaClient | typeof mainnetClient;
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
    name: "wrapped",
    value: wrappedCount.toString(),
    inline: true,
  });

  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#itsawrap",
          description: `A new Fame Lady Society was wrapped${
            testnet ? " on Sepolia" : ""
          }`,
          image: {
            url: await redirectFromGet(
              `https://img.fameladysociety.com/thumb/${tokenId}`,
            ),
          },
          fields,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

export async function notifyDiscordMultipleTokens({
  tokenIds,
  wrappedCount,
  toAddress,
  channelId,
  client,
  testnet,
  discordMessageTopicArn,
  sns,
}: {
  tokenIds: bigint[];
  wrappedCount: bigint;
  toAddress: `0x${string}`;
  channelId: string;
  client: typeof sepoliaClient | typeof mainnetClient;
  testnet: boolean;
  discordMessageTopicArn: string;
  sns: SNS;
}) {
  let ensName: GetEnsNameReturnType;
  try {
    ensName = await client.getEnsName({ address: toAddress });
  } catch (e) {
    // logger.error(e, "Failed to lookup address", toAddress);
    ensName = toAddress;
  }
  const displayName = ensName ? ensName : toAddress;
  const fields: APIEmbedField[] = [];
  fields.push({
    name: "new",
    value: tokenIds.length.toString(),
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
    name: "wrapped",
    value: wrappedCount.toString(),
    inline: true,
  });

  const url = `https://img.fameladysociety.com/mosaic/${tokenIds
    .map((t) => t.toString())
    .join(",")}`;

  logger.info("Sending discord message with url", url);

  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#itsawrap",
          description: `New Fame Lady Society tokens were wrapped${
            testnet ? " on Sepolia" : ""
          }`,
          image: {
            url: await redirectFromGet(url),
          },
          fields,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}
