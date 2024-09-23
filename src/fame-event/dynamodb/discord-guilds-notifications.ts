import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME } from "../lambdas/messaging/config.ts";

export const defaultDb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: process.env.DYNAMODB_REGION,
  }),
  {
    marshallOptions: {
      convertEmptyValues: true,
    },
  }
);

type NotificationType =
  | "fame-buy"
  | "fame-sell"
  | "fame-nft-mint"
  | "fame-nft-burn";

export type DiscordGuildChannelNotification = {
  pk: `guild:${string}:channel:${string}:notification:${NotificationType}`;
  sk: "notifications";
  guildId: string;
  channelId: string;
  notification: NotificationType;
};

function fromDbToDiscordGuildChannelNotification(
  item?: Record<string, unknown> | null
): DiscordGuildChannelNotification | null {
  return item
    ? ({
        pk: item.pk,
        sk: item.sk,
        guildId: item.guildId,
        channelId: item.channelId,
        notification: item.notification,
      } as DiscordGuildChannelNotification)
    : null;
}

export async function getNotifications({
  db = defaultDb,
  tableName = DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME,
}: {
  db?: DynamoDBDocumentClient;
  tableName?: string;
} = {}): Promise<DiscordGuildChannelNotification[]> {
  const response = await db.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "sk = :sk",
      ExpressionAttributeValues: {
        ":sk": "notifications",
      },
      IndexName: "GSI1",
    })
  );
  return (response.Items ?? [])
    .map(fromDbToDiscordGuildChannelNotification)
    .filter((item): item is DiscordGuildChannelNotification => item !== null);
}

export async function getNotification({
  guildId,
  channelId,
  notification,
  db = defaultDb,
  tableName = DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME,
}: {
  guildId: string;
  channelId: string;
  notification: NotificationType;
  db?: DynamoDBDocumentClient;
  tableName?: string;
}): Promise<DiscordGuildChannelNotification | null> {
  const response = await db.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: `guild:${guildId}:channel:${channelId}:notification:${notification}`,
        sk: "notifications",
      },
    })
  );
  return fromDbToDiscordGuildChannelNotification(response.Item);
}

export async function putNotifications({
  guildId,
  channelId,
  notification,
  db = defaultDb,
  tableName = DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME,
}: {
  guildId: string;
  channelId: string;
  notification: NotificationType;
  db?: DynamoDBDocumentClient;
  tableName?: string;
}): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `guild:${guildId}:channel:${channelId}:notification:${notification}`,
        sk: "notifications",
        guildId,
        channelId,
        notification,
      },
    })
  );
}

export async function deleteNotification({
  guildId,
  channelId,
  notification,
  db = defaultDb,
  tableName = DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME,
}: {
  guildId: string;
  channelId: string;
  notification: NotificationType;
  db?: DynamoDBDocumentClient;
  tableName?: string;
}): Promise<void> {
  await db.send(
    new DeleteCommand({
      TableName: tableName,
      Key: {
        pk: `guild:${guildId}:channel:${channelId}:notification:${notification}`,
        sk: "notifications",
      },
    })
  );
}
