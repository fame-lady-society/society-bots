import { sendDiscordMessage } from "@/discord/pubsub/send.ts";
import { customDescription, fetchMetadata } from "./metadata.ts";
import { mainnetClient, sepoliaClient } from "@/viem.ts";
import { createLogger } from "@/utils/logging.ts";
import { SNS } from "@aws-sdk/client-sns";
import { APIEmbedField } from "discord-api-types/v10";
import { formatEther, GetEnsNameReturnType } from "viem";

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
  discordMessageTopicArn,
  sns,
}: {
  address: `0x${string}`;
  tokenId: bigint;
  channelId: string;
  client: typeof mainnetClient;
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

  const description = customDescription(metadata);
  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#FAMEUS",
          description: description ?? `A lady was named`,
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
  discordMessageTopicArn,
  sns,
  blockExplorerUrl,
  txHash,
}: {
  tokenId: bigint;
  wrappedCount: bigint;
  toAddress: `0x${string}`;
  channelId: string;
  client: typeof sepoliaClient | typeof mainnetClient;
  discordMessageTopicArn: string;
  sns: SNS;
  blockExplorerUrl: `https://${string}`;
  txHash: `0x${string}`;
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
  fields.push({
    name: "total wrapped",
    value: wrappedCount.toString(),
    inline: true,
  });

  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#itsawrap",
          description: `A new Fame Lady Society was wrapped`,
          image: {
            url: await redirectFromGet(
              `https://${process.env.IMAGE_HOST}/fls/thumb/${tokenId}`,
            ),
          },
          fields,
          url: `${blockExplorerUrl}/tx/${txHash}`,
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
  discordMessageTopicArn,
  sns,
  blockExplorerUrl,
  txHash,
}: {
  tokenIds: bigint[];
  wrappedCount: bigint;
  toAddress: `0x${string}`;
  channelId: string;
  client: typeof sepoliaClient | typeof mainnetClient;
  discordMessageTopicArn: string;
  sns: SNS;
  blockExplorerUrl: `https://${string}`;
  txHash: `0x${string}`;
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

  fields.push({
    name: "total wrapped",
    value: wrappedCount.toString(),
    inline: true,
  });
  const url = `https://${process.env.IMAGE_HOST}/fls/mosaic/${tokenIds
    .map((t) => t.toString())
    .join(",")}`;

  logger.info("Sending discord message with url", url);

  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#itsawrap",
          description: `New Fame Lady Society tokens were wrapped`,
          image: {
            url: await redirectFromGet(url),
          },
          fields,
          url: `${blockExplorerUrl}/tx/${txHash}`,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

export async function notifyDiscordSingleWrappedAndDonated({
  tokenId,
  wrappedCount,
  fromAddress,
  channelId,
  client,
  discordMessageTopicArn,
  sns,
  totalDonatedCount,
  blockExplorerUrl,
  txHash,
}: {
  tokenId: bigint;
  wrappedCount: bigint;
  fromAddress: `0x${string}`;
  channelId: string;
  client: typeof mainnetClient;
  discordMessageTopicArn: string;
  sns: SNS;
  blockExplorerUrl: `https://${string}`;
  totalDonatedCount: bigint;
  txHash: `0x${string}`;
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
  fields.push({
    name: "total donated",
    value: totalDonatedCount.toString(),
    inline: true,
  });
  fields.push({
    name: "total wrapped",
    value: wrappedCount.toString(),
    inline: true,
  });
  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#donate",
          description: `A new Fame Lady Society was doanted to the vault!`,
          fields,
          url: `${blockExplorerUrl}/tx/${txHash}`,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

export async function notifyDiscordMultipleWrappedAndDonated({
  tokenIds,
  wrappedCount,
  fromAddress,
  channelId,
  client,
  discordMessageTopicArn,
  sns,
  blockExplorerUrl,
  txHash,
  totalDonatedCount,
}: {
  tokenIds: bigint[];
  wrappedCount: bigint;
  fromAddress: `0x${string}`;
  channelId: string;
  client: typeof mainnetClient;
  discordMessageTopicArn: string;
  sns: SNS;
  blockExplorerUrl: `https://${string}`;
  totalDonatedCount: bigint;
  txHash: `0x${string}`;
}) {
  const ensName = await client.getEnsName({ address: fromAddress });
  const displayName = ensName ? ensName : fromAddress;
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
  fields.push({
    name: "total donated",
    value: totalDonatedCount.toString(),
    inline: true,
  });
  fields.push({
    name: "total wrapped",
    value: wrappedCount.toString(),
    inline: true,
  });
  const url = `https://${process.env.IMAGE_HOST}/fls/mosaic/${tokenIds
    .map((t) => t.toString())
    .join(",")}`;
  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#donate",
          description: `New Fame Lady Society tokens were donated to the vault!`,
          image: {
            url: await redirectFromGet(url),
          },
          fields,
          url: `${blockExplorerUrl}/tx/${txHash}`,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

const formatEthCost = (ethCost: bigint) => {
  const value = formatEther(ethCost);
  const dotIndex = value.indexOf(".");
  if (dotIndex === -1) return value;
  const fractionalLength = value.length - dotIndex - 1;
  if (fractionalLength <= 4) return value;
  const rounded = Number(value).toFixed(4);
  return rounded.replace(/\.?0+$/, "");
};

export async function notifyDiscordSingleSweepAndWrap({
  tokenId,
  wrappedCount,
  fromAddress,
  channelId,
  client,
  ethCost,
  discordMessageTopicArn,
  sns,
  blockExplorerUrl,
  txHash,
}: {
  tokenId: bigint;
  wrappedCount: bigint;
  fromAddress: `0x${string}`;
  channelId: string;
  ethCost: bigint;
  client: typeof mainnetClient;
  discordMessageTopicArn: string;
  sns: SNS;
  blockExplorerUrl: `https://${string}`;
  txHash: `0x${string}`;
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
    name: "eth cost",
    value: formatEthCost(ethCost),
    inline: true,
  });
  fields.push({
    name: "by",
    value: displayName,
    inline: true,
  });
  fields.push({
    name: "total wrapped",
    value: wrappedCount.toString(),
    inline: true,
  });
  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#sweep",
          description: `A new Fame Lady Society was swept and wrapped!`,
          fields,
          url: `${blockExplorerUrl}/tx/${txHash}`,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

export async function notifyDiscordMultipleSweepAndWrap({
  tokenIds,
  wrappedCount,
  fromAddress,
  channelId,
  client,
  ethCost,
  discordMessageTopicArn,
  sns,
  blockExplorerUrl,
  txHash,
}: {
  tokenIds: bigint[];
  wrappedCount: bigint;
  fromAddress: `0x${string}`;
  channelId: string;
  ethCost: bigint;
  client: typeof mainnetClient;
  discordMessageTopicArn: string;
  sns: SNS;
  blockExplorerUrl: `https://${string}`;
  txHash: `0x${string}`;
}) {
  const ensName = await client.getEnsName({ address: fromAddress });
  const displayName = ensName ? ensName : fromAddress;
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
  fields.push({
    name: "eth cost",
    value: formatEthCost(ethCost),
    inline: true,
  });
  fields.push({
    name: "total wrapped",
    value: wrappedCount.toString(),
    inline: true,
  });
  const url = `https://${process.env.IMAGE_HOST}/fls/mosaic/${tokenIds
    .map((t) => t.toString())
    .join(",")}`;
  await sendDiscordMessage({
    channelId,
    message: {
      embeds: [
        {
          title: "#sweep",
          description: `New Fame Lady Society tokens were swept and wrapped!`,
          image: {
            url: await redirectFromGet(url),
          },
          fields,
          url: `${blockExplorerUrl}/tx/${txHash}`,
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}
