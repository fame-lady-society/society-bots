import { SNS } from "@aws-sdk/client-sns";
import { baseClient, mainnetClient, sepoliaClient } from "@/viem.js";
import { fetchMetadata } from "./metadata.js";
import { APIEmbed, APIEmbedField } from "discord-api-types/v10";
import { sendDiscordMessage } from "@/discord/pubsub/send.js";

import { erc20Abi, formatEther, formatUnits, parseUnits } from "viem";
import { fameSocietyTokenAddress } from "@/wagmi.generated.ts";
import { base } from "viem/chains";
import { AggregateSwapEvents } from "./aggregate.ts";
import { imageHost } from "@/discord/config.ts";
import { logger } from "@/utils/logging.ts";
import { fillGrid } from "./grid.ts";
import { generateTokenIdListString } from "./utils.ts";

export const formatToken = (
  amount: bigint,
  tokenDecimals: number,
  formatDecimals: number
) => {
  const base = formatUnits(amount, tokenDecimals);
  const [integerPart, fractionalPart] = base.split(".");

  let left = Number(integerPart);
  let suffix = "";

  if (left >= 1_000_000_000_000) {
    left /= 1_000_000_000_000;
    suffix = "T";
  } else if (left >= 1_000_000_000) {
    left /= 1_000_000_000;
    suffix = "B";
  } else if (left >= 1_000_000) {
    left /= 1_000_000;
    suffix = "M";
  } else if (left >= 1000) {
    left /= 1000;
    suffix = "K";
  }

  const formattedLeft =
    left < 1000
      ? left.toLocaleString("en").replaceAll(",", " ")
      : left.toFixed(1);

  const right = suffix
    ? ""
    : fractionalPart && formatDecimals > 0
    ? Number(`0.${fractionalPart}`).toFixed(formatDecimals).slice(2)
    : "";

  return `${formattedLeft}${suffix}${right ? "." + right : ""}`;
};

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
  let displayName: string = toAddress;
  try {
    const ensName = await mainnetClient.getEnsName({ address: toAddress });
    if (ensName) {
      displayName = ensName;
    }
  } catch (error) {
    logger.warn({ error, toAddress }, "Failed to fetch ENS name");
  }
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
    fields.push({
      name: "token ids",
      value: generateTokenIdListString(tokenIds.map(Number)),
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
      description: `New $FAME Society was minted${
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
  let displayName: string = fromAddress;
  try {
    const ensName = await mainnetClient.getEnsName({ address: fromAddress });
    if (ensName) {
      displayName = ensName;
    }
  } catch (error) {
    logger.warn({ error, fromAddress }, "Failed to fetch ENS name");
  }
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
    fields.push({
      name: "token ids",
      value: generateTokenIdListString(tokenIds.map(Number)),
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
      description: `New $FAME Society was burned${
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

const MAX_AMOUNT = parseUnits("1", 18);
const MIN_AMOUNT = parseUnits("0.001", 18);

export async function notifyDiscordSwap({
  blockNumber,
  swapEvent,
  recipient,
  testnet,
  tokenAddress,
  client,
}: {
  blockNumber: bigint;
  swapEvent: AggregateSwapEvents;
  recipient: `0x${string}`;
  testnet: boolean;
  tokenAddress: `0x${string}`;
  client: typeof sepoliaClient | typeof baseClient;
}) {
  const tokenDelta = swapEvent.tokenBalanceDelta.get(recipient);
  const wethDelta = swapEvent.wethBalanceDelta.get(recipient);
  if (typeof tokenDelta === "undefined" || typeof wethDelta === "undefined") {
    logger.info(
      {
        recipient,
        tokenBalanceDelta: [...swapEvent.tokenBalanceDelta.entries()].map(
          ([address, delta]) => `${address}: ${formatUnits(delta, 18)}`
        ),
        wethBalanceDelta: [...swapEvent.wethBalanceDelta.entries()].map(
          ([address, delta]) => `${address}: ${formatUnits(delta, 18)}`
        ),
      },
      "No swap event"
    );
    return [];
  }
  let displayName: string = recipient;
  try {
    const ensName = await mainnetClient.getEnsName({ address: recipient });
    if (ensName) {
      displayName = ensName;
    }
  } catch (error) {
    logger.warn({ error, recipient }, "Failed to fetch ENS name");
  }
  const fields: APIEmbedField[] = [];

  const grid = fillGrid(
    wethDelta < 0n ? -wethDelta : wethDelta,
    MIN_AMOUNT,
    MAX_AMOUNT,
    ["🎬", "🌟", "👑"]
  );
  if (grid) {
    fields.push({
      name: tokenDelta > 0 ? "buy" : "sell",
      value: grid.join(""),
    });
  }
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
      value: formatToken(tokenDelta, 18, 0),
      inline: true,
    });
  } else if (tokenDelta < 0) {
    fields.push({
      name: "sold $FAME",
      value: formatToken(-tokenDelta, 18, 0),
      inline: true,
    });
  }
  if (wethDelta > 0) {
    fields.push({
      name: "for WETH",
      value: formatToken(wethDelta, 18, 4),
      inline: true,
    });
  } else if (wethDelta < 0) {
    fields.push({
      name: "with WETH",
      value: formatToken(-wethDelta, 18, 4),
      inline: true,
    });
  }
  if (swapEvent.isArb) {
    fields.push({
      name: "arb",
      value: "true",
      inline: true,
    });
  }
  if (swapEvent.nftsMinted.length > 0) {
    fields.push({
      name: "minted",
      value: swapEvent.nftsMinted.length.toString(),
      inline: true,
    });
  }
  if (swapEvent.nftsBurned.length > 0) {
    fields.push({
      name: "burned",
      value: swapEvent.nftsBurned.length.toString(),
      inline: true,
    });
  }

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
      title: "$FAME BUY",
      description: `A $FAME Society buy${
        testnet ? " occurred on testnet" : ""
      }`,
      fields,
      image: {
        url: "https://dev.fame.support/assets/image/dance.gif",
      },
    },
  ] as APIEmbed[];
}
