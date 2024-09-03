import { SNS } from "@aws-sdk/client-sns";
import { baseClient, mainnetClient, sepoliaClient } from "@/viem.js";
import { fetchMetadata } from "./metadata.js";
import { APIEmbed, APIEmbedField } from "discord-api-types/v10";
import { sendDiscordMessage } from "@/discord/pubsub/send.js";

import { erc20Abi, formatUnits } from "viem";
import { fameSocietyTokenAddress } from "@/wagmi.generated.ts";
import { base } from "viem/chains";
import { AggregateSwapEvents } from "./aggregate.ts";
import { imageHost } from "@/discord/config.ts";

export async function notifyDiscordMint({
  tokenIds,
  toAddress,
  testnet,
}: {
  tokenIds: bigint[];
  toAddress: `0x${string}`;
  testnet: boolean;
}) {
  if (tokenIds.length === 0) {
    return [];
  }
  const ensName = await mainnetClient.getEnsName({ address: toAddress });
  const displayName = ensName ? ensName : toAddress;
  const fields: APIEmbedField[] = [];
  if (tokenIds.length === 1) {
    fields.push({
      name: "token id",
      value: tokenIds[0].toString(),
      inline: true,
    });
  } else {
    fields.push({
      name: "minted",
      value: tokenIds.length.toString(),
      inline: true,
    });
  }
  fields.push({
    name: "by",
    value: displayName,
    inline: true,
  });
  if (testnet) {
    fields.push({
      name: "testnet",
      value: "true",
      inline: true,
    });
  }

  return [
    {
      title: "$FAME Society Mint",
      description: `A new $FAME Society was minted${
        testnet ? " on testnet" : ""
      }`,
      image: {
        url:
          tokenIds.length === 1
            ? `https://${imageHost.get()}/thumb/${tokenIds[0]}`
            : `https://${imageHost.get()}/mosaic/${tokenIds.join(",")}`,
      },
      fields,
    },
  ] as APIEmbed[];
}

export async function notifyDiscordBurn({
  tokenIds,
  fromAddress,
  testnet,
}: {
  tokenIds: bigint[];
  fromAddress: `0x${string}`;
  testnet: boolean;
}) {
  if (tokenIds.length === 0) {
    return [];
  }
  const ensName = await mainnetClient.getEnsName({ address: fromAddress });
  const displayName = ensName ? ensName : fromAddress;
  const fields: APIEmbedField[] = [];
  if (tokenIds.length === 1) {
    fields.push({
      name: "token id",
      value: tokenIds[0].toString(),
      inline: true,
    });
  } else {
    fields.push({
      name: "burned",
      value: tokenIds.length.toString(),
      inline: true,
    });
  }
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

  return [
    {
      title: "$FAME Society Mint",
      description: `A new $FAME Society was burned${
        testnet ? " on testnet" : ""
      }`,
      image: {
        url:
          tokenIds.length === 1
            ? `https://${imageHost.get()}/thumb/${tokenIds[0]}`
            : `https://${imageHost.get()}/mosaic/${tokenIds.join(",")}`,
      },
      fields,
    },
  ] as APIEmbed[];
}

export async function notifyDiscordSwap({
  blockNumber,
  swapEvent,
  recipient,
  testnet,
  tokenAddress,
  client,
}: {
  blockNumber: bigint;
  swapEvent: Pick<
    AggregateSwapEvents,
    "tokenBalanceDelta" | "wethBalanceDelta"
  >;
  recipient: `0x${string}`;
  testnet: boolean;
  tokenAddress: `0x${string}`;
  client: typeof sepoliaClient | typeof baseClient;
}) {
  const tokenDelta = swapEvent.tokenBalanceDelta.get(recipient);
  const wethDelta = swapEvent.wethBalanceDelta.get(recipient);
  if (!tokenDelta || !wethDelta) {
    throw new Error(`No swap event for recipient ${recipient}`);
  }
  const ensName = await mainnetClient.getEnsName({ address: recipient });
  const displayName = ensName ? ensName : recipient;
  const fields: APIEmbedField[] = [];
  fields.push({
    name: "recipient",
    value: displayName,
    inline: true,
  });
  if (testnet) {
    fields.push({
      name: "testnet",
      value: "true",
      inline: true,
    });
  }
  if (tokenDelta > 0) {
    fields.push({
      name: "bought $FAME",
      value: formatUnits(tokenDelta, 18),
      inline: true,
    });
  } else if (tokenDelta < 0) {
    fields.push({
      name: "sold $FAME",
      value: formatUnits(-tokenDelta, 18),
      inline: true,
    });
  }
  fields.push({
    name: "for WETH",
    value: formatUnits(wethDelta, 18),
    inline: true,
  });

  // get current balance (should include the swap)
  const currentBalance = await client.readContract({
    abi: erc20Abi,
    address: tokenAddress,
    functionName: "balanceOf",
    args: [recipient],
    blockNumber,
  });
  const percentage = (Number(tokenDelta) / Number(currentBalance)) * 100;

  fields.push({
    name: "percent of position",
    value: `${Math.abs(percentage).toFixed(2)}%`,
    inline: true,
  });

  return [
    {
      title: "$FAME Society Swap",
      description: `A $FAME Society swap occurred${
        testnet ? " on testnet" : ""
      }`,
      fields,
      video: {
        url: "https://images-ext-1.discordapp.net/external/1rMxR_ORQ4JQ4AWNkGYEHA0NvK_f6xv84tmrOU3QDz0/https/media.tenor.com/Sznlx6WCcFkAAAPo/dance-iggy-pop-iggy.mp4",
      },
    },
  ] as APIEmbed[];
}
