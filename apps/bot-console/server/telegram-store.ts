import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { capturedMessageSchema, type CapturedMessage } from "./telegram";
import { z } from "zod";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = () => process.env.MESSAGE_TABLE!;
const conditional = (e: unknown) =>
  e instanceof Error && e.name === "ConditionalCheckFailedException";
export async function saveMessage(
  m: CapturedMessage,
  send: (command: PutCommand) => Promise<unknown> = (command) =>
    db.send(command),
) {
  // Each write is idempotent. A retry still repairs the projection even if its revision already exists.
  try {
    await send(
      new PutCommand({
        TableName: table(),
        Item: {
          ...m,
          pk: `revision#${m.chatId}#${m.messageId}`,
          sk: `v#${m.version}`,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (e) {
    if (!conditional(e)) throw e;
  }
  try {
    await send(
      new PutCommand({
        TableName: table(),
        Item: {
          ...m,
          pk: `chat#${m.chatId}`,
          sk: `m#${String(m.sentAt).padStart(12, "0")}#${m.messageId}`,
        },
        ConditionExpression: "attribute_not_exists(pk) OR #v < :v",
        ExpressionAttributeNames: { "#v": "version" },
        ExpressionAttributeValues: { ":v": m.version },
      }),
    );
  } catch (e) {
    if (!conditional(e)) throw e;
  }
  try {
    await send(
      new PutCommand({
        TableName: table(),
        Item: {
          pk: "status",
          sk: `chat#${m.chatId}`,
          lastCapturedAt: m.receivedAt,
          expires: m.expires,
        },
        ConditionExpression: "attribute_not_exists(pk) OR lastCapturedAt < :t",
        ExpressionAttributeValues: { ":t": m.receivedAt },
      }),
    );
  } catch (e) {
    if (!conditional(e)) throw e;
  }
}
export async function lastCaptured(chatId: string) {
  const r = await db.send(
    new GetCommand({
      TableName: table(),
      Key: { pk: "status", sk: `chat#${chatId}` },
      ConsistentRead: true,
    }),
  );
  return typeof r.Item?.lastCapturedAt === "number"
    ? r.Item.lastCapturedAt
    : null;
}
const cursorSchema = z.object({ pk: z.string(), sk: z.string() }).strict();
export async function listMessages(
  chatId: string,
  cursor?: string,
  messageId?: string,
) {
  const pk = messageId ? `revision#${chatId}#${messageId}` : `chat#${chatId}`;
  let start: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    if (cursor.length > 2048) throw new Error("Invalid cursor");
    try {
      start = cursorSchema.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw new Error("Invalid cursor");
    }
    if (start.pk !== pk) throw new Error("Invalid cursor");
  }
  const r = await db.send(
    new QueryCommand({
      TableName: table(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": pk,
        ":now": Math.floor(Date.now() / 1000),
      },
      FilterExpression: "expires > :now",
      ScanIndexForward: false,
      Limit: 50,
      ExclusiveStartKey: start,
      ConsistentRead: true,
    }),
  );
  return {
    items: (r.Items ?? []).map((i) => capturedMessageSchema.parse(i)),
    cursor: r.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(r.LastEvaluatedKey)).toString("base64url")
      : null,
  };
}
