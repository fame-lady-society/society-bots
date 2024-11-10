// import { EventBridgeEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import { SNS } from "@aws-sdk/client-sns";
import { APIEmbedField } from "discord-api-types/v10";
import { createLogger } from "@/utils/logging.js";
import { AbiEvent, GetEnsNameReturnType, zeroAddress } from "viem";
import { customDescription, fetchMetadata } from "./metadata.js";
import { sendDiscordMessage } from "@/discord/pubsub/send.ts";
import { fameLadySocietyAbi, fameLadySocietyAddress, wrappedNftAddress } from "@/wagmi.generated.ts";
import { mainnetClient, sepoliaClient } from "@/viem.ts";
import { bigIntToStringJsonFormat } from "@/utils/json.ts";

type PromiseType<T extends Promise<any>> = T extends Promise<infer U>
  ? U
  : never;

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
  }
);

async function redirectFromGet(url: string) {
  const controller = new AbortController();
  try {
    const timeoutId = setTimeout(() => controller.abort(), 1000);

    const response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal
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

async function notifyDiscordMetadataUpdate({
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
              `https://fls-www.vercel.app/${testnet ? "sepolia" : "mainnet"}/og/token/${tokenId}`
            ),
          },
        },
      ],
    },
    topicArn: discordMessageTopicArn,
    sns,
  });
}

async function notifyDiscordSingleToken({
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
          description: `A new Fame Lady Society was wrapped${testnet ? " on Sepolia" : ""
            }`,
          image: {
            url: await redirectFromGet(
              `https://img.fameladysociety.com/thumb/${tokenId}`
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

async function notifyDiscordMultipleTokens({
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
    logger.error(e, "Failed to lookup address", toAddress);
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
          description: `New Fame Lady Society tokens were wrapped${testnet ? " on Sepolia" : ""
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

const transferEvent = {
  type: "event",
  anonymous: false,
  inputs: [
    {
      name: "from",
      internalType: "address",
      type: "address",
      indexed: true,
    },
    { name: "to", internalType: "address", type: "address", indexed: true },
    {
      name: "tokenId",
      internalType: "uint256",
      type: "uint256",
      indexed: true,
    },
  ],
  name: "Transfer",
} as const;

const metadataEvent = {
  type: "event",
  anonymous: false,
  inputs: [
    {
      name: "_tokenId",
      internalType: "uint256",
      type: "uint256",
      indexed: false,
    },
  ],
  name: "MetadataUpdate",
} as const;

export const handler = async () =>
// event: EventBridgeEvent<"check-fls-wrap", void>
{
  // Get last bock read
  const [lastBlockSepoliaResponse, lastBlockMainnetResponse] =
    await Promise.all([
      db.send(
        new GetCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Key: {
            key: "lastBlockSepolia",
          },
        })
      ),
      db.send(
        new GetCommand({
          TableName: process.env.DYNAMODB_TABLE,
          Key: {
            key: "lastBlockMainnet",
          },
        })
      ),
    ]);

  const [latestBlockSepolia, latestBlockMainnet] = await Promise.all([
    sepoliaClient.getBlockNumber(),
    mainnetClient.getBlockNumber(),
  ]);

  const lastBlockSepolia = BigInt(
    lastBlockSepoliaResponse.Item?.value ?? latestBlockSepolia
  );
  const lastBlockMainnet = BigInt(
    lastBlockMainnetResponse.Item?.value ?? latestBlockMainnet
  );

  // Get events from last block read
  const [
    sepoliaTransferEvents,
    mainnetTransferEvents,
    sepoliaMetadataEvents,
    mainnetMetadataEvents,
  ] = await Promise.all([
    findEvents<typeof transferEvent>(
      sepoliaClient,
      wrappedNftAddress[11155111],
      transferEvent,
      lastBlockSepolia,
      latestBlockSepolia
    ).then((events) => {
      logger.info(`Found ${events.length} events on Sepolia`);
      return events.filter((event) => event.args.from === zeroAddress);
    }),
    findEvents<typeof transferEvent>(
      mainnetClient,
      fameLadySocietyAddress[1],
      transferEvent,
      lastBlockMainnet,
      latestBlockMainnet
    ).then((events) => {
      logger.info({ events: JSON.parse(JSON.stringify(events, bigIntToStringJsonFormat)) }, `Found ${events.length} events on Mainnet`);
      return events.filter((event) => event.args.from === zeroAddress);
    }),
    findEvents<typeof metadataEvent>(
      sepoliaClient,
      wrappedNftAddress[11155111],
      metadataEvent,
      lastBlockSepolia,
      latestBlockSepolia
    ),
    findEvents<typeof metadataEvent>(
      mainnetClient,
      fameLadySocietyAddress[1],
      metadataEvent,
      lastBlockMainnet,
      latestBlockMainnet
    ),
  ]);

  const promises: Promise<void>[] = [];

  // Notify discord
  const sns = new SNS({});
  // Group events by to address
  const sepoliaEventsByTo = new Map<
    `0x${string}`,
    PromiseType<ReturnType<typeof findEvents<typeof transferEvent>>>
  >();
  const mainnetEventsByTo = new Map<
    `0x${string}`,
    PromiseType<ReturnType<typeof findEvents<typeof transferEvent>>>
  >();
  for (const event of sepoliaTransferEvents) {
    const events = sepoliaEventsByTo.get(event.args.to) || [];
    events.push(event);
    sepoliaEventsByTo.set(event.args.to, events);
  }
  for (const event of mainnetTransferEvents) {
    const events = mainnetEventsByTo.get(event.args.to) || [];
    events.push(event);
    mainnetEventsByTo.set(event.args.to, events);
  }

  const wrappedCount =
    sepoliaEventsByTo.size || mainnetEventsByTo.size
      ? await mainnetClient.readContract({
        address: fameLadySocietyAddress[1],
        abi: fameLadySocietyAbi,
        functionName: "balanceOf",
        args: [fameLadySocietyAddress[1]],
      })
      : 0n;

  // Now push out the events
  for (const [to, events] of sepoliaEventsByTo.entries()) {
    const tokenIds = events.map(({ args }) => args.tokenId);
    if (tokenIds.length === 1) {
      promises.push(
        notifyDiscordSingleToken({
          tokenId: tokenIds[0],
          wrappedCount: 0n, // fake
          toAddress: to,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: sepoliaClient,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          testnet: true,
          sns,
        })
      );
    } else {
      promises.push(
        notifyDiscordMultipleTokens({
          tokenIds,
          wrappedCount: 0n, // fake
          toAddress: to,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: sepoliaClient,
          testnet: true,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          sns,
        })
      );
    }
  }

  for (const [to, events] of mainnetEventsByTo.entries()) {
    const tokenIds = events.map(({ args }) => args.tokenId!);
    if (tokenIds.length === 1) {
      promises.push(
        notifyDiscordSingleToken({
          tokenId: tokenIds[0],
          wrappedCount,
          toAddress: to,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: mainnetClient,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          testnet: false,
          sns,
        })
      );
    } else {
      promises.push(
        notifyDiscordMultipleTokens({
          tokenIds,
          wrappedCount,
          toAddress: to,
          channelId: process.env.DISCORD_CHANNEL_ID!,
          client: mainnetClient,
          testnet: false,
          discordMessageTopicArn: process.env.DISCORD_MESSAGE_TOPIC_ARN!,
          sns,
        })
      );
    }
  }

  for (const event of sepoliaMetadataEvents) {
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
      })
    );
  }

  for (const event of mainnetMetadataEvents) {
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
      })
    );
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
