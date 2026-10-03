import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
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
  associationId: string,
  send: (command: TransactWriteCommand) => Promise<unknown> = (command) =>
    db.send(command),
) {
  const put = async (command: PutCommand) => {
    try {
      await send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: process.env.GROUP_TABLE!,
                Key: { pk: "groups", sk: m.chatId },
                ConditionExpression:
                  "#state = :active AND associationId = :association",
                ExpressionAttributeNames: { "#state": "state" },
                ExpressionAttributeValues: {
                  ":active": "active",
                  ":association": associationId,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: process.env.GROUP_TABLE!,
                Key: { pk: `ignored#${m.chatId}`, sk: m.messageId },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                ...command.input,
                TableName: table(),
                Item: command.input.Item!,
              },
            },
          ],
        }),
      );
    } catch (e) {
      const reasons = (e as { CancellationReasons?: { Code?: string }[] })
        .CancellationReasons;
      if (
        e instanceof Error &&
        e.name === "TransactionCanceledException" &&
        reasons?.length === 3 &&
        reasons[0].Code === "None" &&
        reasons[1].Code === "None" &&
        reasons[2].Code === "ConditionalCheckFailed"
      ) {
        const duplicate = new Error("Already stored");
        duplicate.name = "ConditionalCheckFailedException";
        throw duplicate;
      }
      throw e;
    }
  };
  // Each write is idempotent. A retry still repairs the projection even if its revision already exists.
  try {
    await put(
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
    await put(
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
    await put(
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
