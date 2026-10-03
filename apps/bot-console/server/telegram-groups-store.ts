import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  groupSchema,
  inviteSchema,
  type TelegramGroup,
} from "../src/telegram-groups-contracts";
import { GroupConflict, type GroupStore } from "./telegram-groups";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
type Command =
  | GetCommand
  | PutCommand
  | QueryCommand
  | UpdateCommand
  | TransactWriteCommand;
// Injection keeps transaction/condition contracts testable without AWS credentials.
export function dynamoGroupStore(
  table = process.env.GROUP_TABLE!,
  send: (command: Command) => Promise<{
    Item?: Record<string, unknown>;
    Items?: Record<string, unknown>[];
    LastEvaluatedKey?: Record<string, unknown>;
  }> = async (c) => {
    if (c instanceof GetCommand) return db.send(c);
    if (c instanceof QueryCommand) return db.send(c);
    if (c instanceof PutCommand) await db.send(c);
    else if (c instanceof UpdateCommand) await db.send(c);
    else await db.send(c);
    return {};
  },
): GroupStore {
  const key = (pk: string, sk: string) => ({ pk, sk });
  const groupKey = (id: string) => key("groups", id);
  const inviteKey = (id: string) => key("invites", id);
  const conditional = (e: unknown) =>
    e instanceof Error && e.name === "ConditionalCheckFailedException";
  const conflictTransaction = (e: unknown) => {
    if (!(e instanceof Error) || e.name !== "TransactionCanceledException")
      return false;
    const reasons = (e as Error & { CancellationReasons?: { Code?: string }[] })
      .CancellationReasons;
    return (
      !!reasons?.some((r) => r.Code === "ConditionalCheckFailed") &&
      reasons.every(
        (r) => !r.Code || ["None", "ConditionalCheckFailed"].includes(r.Code),
      )
    );
  };
  const versionCondition = (previous: TelegramGroup | undefined) =>
    previous
      ? {
          ConditionExpression:
            "requestId = :request AND #state = :state AND updatedAt = :updated",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":request": previous.requestId,
            ":state": previous.state,
            ":updated": previous.updatedAt,
          },
        }
      : { ConditionExpression: "attribute_not_exists(pk)" };
  return {
    async ignore(chatId, messageId, expires) {
      await send(
        new PutCommand({
          TableName: table,
          Item: { ...key(`ignored#${chatId}`, messageId), expires },
        }),
      );
    },
    async ignored(chatId, messageId) {
      const r = await send(
        new GetCommand({
          TableName: table,
          Key: key(`ignored#${chatId}`, messageId),
          ConsistentRead: true,
        }),
      );
      return !!r.Item;
    },
    async list() {
      const items: TelegramGroup[] = [];
      let cursor;
      do {
        const result = await send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": "groups" },
            ConsistentRead: true,
            ExclusiveStartKey: cursor,
          }),
        );
        items.push(
          ...(result.Items ?? []).map((i: unknown) => groupSchema.parse(i)),
        );
        cursor = result.LastEvaluatedKey;
      } while (cursor);
      return items;
    },
    async get(id) {
      const r = await send(
        new GetCommand({
          TableName: table,
          Key: groupKey(id),
          ConsistentRead: true,
        }),
      );
      return r.Item ? groupSchema.parse(r.Item) : undefined;
    },
    async invite(id) {
      const r = await send(
        new GetCommand({
          TableName: table,
          Key: inviteKey(id),
          ConsistentRead: true,
        }),
      );
      return r.Item ? inviteSchema.parse(r.Item) : undefined;
    },
    async issue(invite) {
      try {
        await send(
          new PutCommand({
            TableName: table,
            Item: { ...inviteKey(invite.id), ...invite },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return true;
      } catch (e) {
        if (conditional(e)) return false;
        throw e;
      }
    },
    async revoke(id, actor) {
      try {
        await send(
          new UpdateCommand({
            TableName: table,
            Key: inviteKey(id),
            UpdateExpression: "SET #state = :revoked, revokedBy = :actor",
            ConditionExpression: "#state = :available",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: {
              ":revoked": "revoked",
              ":available": "available",
              ":actor": actor,
            },
          }),
        );
      } catch (e) {
        if (conditional(e))
          throw new GroupConflict("Code is no longer available.");
        throw e;
      }
    },
    async rate(scope, limit, now) {
      const window = Math.floor(now / 60);
      try {
        await send(
          new UpdateCommand({
            TableName: table,
            Key: key("rate", `${scope}#${window}`),
            UpdateExpression: "SET expires = :expires ADD attempts :one",
            ConditionExpression:
              "attribute_not_exists(attempts) OR attempts < :limit",
            ExpressionAttributeValues: {
              ":expires": (window + 2) * 60,
              ":one": 1,
              ":limit": limit,
            },
          }),
        );
        return true;
      } catch (e) {
        if (conditional(e)) return false;
        throw e;
      }
    },
    async redeem(id, group, previous, now) {
      try {
        await send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: table,
                  Key: inviteKey(id),
                  UpdateExpression:
                    "SET #state = :used, chatId = :chat, usedAt = :now",
                  ConditionExpression: "#state = :available AND expires > :now",
                  ExpressionAttributeNames: { "#state": "state" },
                  ExpressionAttributeValues: {
                    ":used": "used",
                    ":available": "available",
                    ":chat": group.id,
                    ":now": now,
                  },
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: { ...groupKey(group.id), ...group },
                  ...versionCondition(previous),
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: {
                    ...key(`audit#${group.id}`, group.requestId),
                    ...group,
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        );
        return true;
      } catch (e) {
        if (conflictTransaction(e)) return false;
        throw e;
      }
    },
    async decide(previous, next) {
      try {
        await send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: { ...groupKey(next.id), ...next },
                  ...versionCondition(previous),
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: {
                    ...key(
                      `audit#${next.id}`,
                      `${next.requestId}#${next.state}`,
                    ),
                    ...next,
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        );
      } catch (e) {
        if (conflictTransaction(e))
          throw new GroupConflict("Group changed. Refresh and try again.");
        throw e;
      }
    },
  };
}
