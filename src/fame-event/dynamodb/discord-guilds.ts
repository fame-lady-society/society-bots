import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { NotificationType } from "@/types.ts";
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

export type DiscordGuild = {
  pk: `guild:${string}`;
  sk: "guild";
  guildId: string;
};

function fromDbToDiscordGuild(
  item?: Record<string, unknown> | null
): DiscordGuild | null {
  return item
    ? ({
        pk: item.pk,
        sk: item.sk,
        guildId: item.guildId,
      } as DiscordGuild)
    : null;
}

export async function getDiscordGuild({
  id,
  db = defaultDb,
  tableName = DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME,
}: {
  id: number;
  db?: DynamoDBDocumentClient;
  tableName?: string;
}): Promise<DiscordGuild | null> {
  const response = await db.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: `guild:${id}`,
        sk: "guild",
      },
    })
  );
  return fromDbToDiscordGuild(response.Item);
}

export async function noticeGuild({
  id,
  db = defaultDb,
  tableName = DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME,
}: {
  id: number;
  db?: DynamoDBDocumentClient;
  tableName?: string;
}): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        id: `guild-${id}`,
        sk: "guild",
        guildId: id,
      },
    })
  );
}
