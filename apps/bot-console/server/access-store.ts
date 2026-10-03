import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { policySchema, auditSchema } from "../src/access-contracts";
import type { AccessStore } from "./access";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export function accessStore(
  table = process.env.ACCESS_TABLE!,
  send: (command: GetCommand | QueryCommand | TransactWriteCommand) => Promise<{
    Item?: Record<string, unknown>;
    Items?: Record<string, unknown>[];
  }> = async (command) => {
    if (command instanceof GetCommand) return db.send(command);
    if (command instanceof QueryCommand) return db.send(command);
    await db.send(command);
    return {};
  },
): AccessStore {
  return {
    async read() {
      const r = await send(
        new GetCommand({
          TableName: table,
          Key: { pk: "policy", sk: "current" },
          ConsistentRead: true,
        }),
      );
      return policySchema.parse(r.Item?.value);
    },
    async write(previous, next, audit) {
      try {
        await send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: table,
                  Item: {
                    pk: "policy",
                    sk: "current",
                    version: next.version,
                    value: next,
                  },
                  ConditionExpression: "#v = :previous",
                  ExpressionAttributeNames: { "#v": "version" },
                  ExpressionAttributeValues: { ":previous": previous.version },
                },
              },
              {
                Put: {
                  TableName: table,
                  Item: {
                    pk: "audit",
                    sk: `${String(audit.at).padStart(12, "0")}#${audit.id}`,
                    value: audit,
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        );
        return true;
      } catch (e) {
        if (e instanceof Error && e.name === "TransactionCanceledException") {
          const reasons = (
            e as Error & { CancellationReasons?: { Code?: string }[] }
          ).CancellationReasons;
          if (
            reasons?.[0]?.Code === "ConditionalCheckFailed" &&
            reasons?.[1]?.Code === "None"
          )
            return false;
        }
        throw e;
      }
    },
    async audit() {
      const r = await send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": "audit" },
          ScanIndexForward: false,
          Limit: 50,
          ConsistentRead: true,
        }),
      );
      return (r.Items ?? []).map((i) => auditSchema.parse(i.value));
    },
  };
}
