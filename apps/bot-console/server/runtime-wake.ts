import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  wakeRecordSchema,
  wakeReceiptSchema,
  type WakeRequest,
  type WakeRecord,
} from "../src/runtime-wake-contracts";
export interface WakeStore {
  get(id: string): Promise<WakeRecord | undefined>;
  create(request: WakeRequest, policyVersion: number): Promise<void>;
  finish(record: WakeRecord): Promise<WakeRecord>;
}
export interface WakeService {
  submit(request: WakeRequest, policyVersion: number): Promise<WakeRecord>;
  get(id: string): Promise<WakeRecord | undefined>;
}
export function wakeService(
  store: WakeStore,
  invoke: (request: WakeRequest) => Promise<unknown>,
): WakeService {
  return {
    get: (id) => store.get(id),
    async submit(request, policyVersion) {
      // The conditional policy version and durable request audit precede dispatch.
      let record = await store.get(request.requestId);
      if (!record) {
        await store.create(request, policyVersion);
        record = await store.get(request.requestId);
      }
      if (
        !record ||
        record.request.actor !== request.actor ||
        record.request.runtimeId !== request.runtimeId
      )
        throw new Error("Request ID conflict");
      if (!["pending", "unknown"].includes(record.outcome)) return record;
      let next: WakeRecord;
      try {
        const receipt = wakeReceiptSchema.parse(await invoke(record.request));
        if (
          Object.keys(record.request).some(
            (key) =>
              receipt.request[key as keyof WakeRequest] !==
              record.request[key as keyof WakeRequest],
          )
        )
          throw new Error("Receipt mismatch");
        next = receipt;
      } catch {
        // Neither a transport error nor Lambda FunctionError proves no wake occurred.
        next = { ...record, outcome: "unknown", reason: "delivery-uncertain" };
      }
      return store.finish(next);
    },
  };
}
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 1 }));
type Send = (
  command: GetCommand | TransactWriteCommand | UpdateCommand,
) => Promise<{ Item?: Record<string, unknown> }>;
export function wakeStore(
  table = process.env.ACCESS_TABLE!,
  send: Send = async (command) => {
    if (command instanceof GetCommand) return db.send(command);
    if (command instanceof UpdateCommand) await db.send(command);
    else await db.send(command);
    return {};
  },
): WakeStore {
  const key = (id: string) => ({ pk: "runtime-wake", sk: id });
  const store: WakeStore = {
    async get(id) {
      const r = await send(
        new GetCommand({
          TableName: table,
          Key: key(id),
          ConsistentRead: true,
        }),
      );
      return r.Item ? wakeRecordSchema.parse(r.Item.value) : undefined;
    },
    async create(request, policyVersion) {
      await send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: { pk: "policy", sk: "current" },
                ConditionExpression: "#v = :version",
                ExpressionAttributeNames: { "#v": "version" },
                ExpressionAttributeValues: { ":version": policyVersion },
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...key(request.requestId),
                  value: {
                    request,
                    outcome: "pending",
                    reason: "dispatch-requested",
                  },
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    },
    async finish(record) {
      try {
        await send(
          new UpdateCommand({
            TableName: table,
            Key: key(record.request.requestId),
            UpdateExpression: "SET #v.#o = :outcome, #v.#r = :reason",
            ConditionExpression: "#v.#o IN (:pending, :unknown)",
            ExpressionAttributeNames: {
              "#v": "value",
              "#o": "outcome",
              "#r": "reason",
            },
            ExpressionAttributeValues: {
              ":outcome": record.outcome,
              ":reason": record.reason,
              ":pending": "pending",
              ":unknown": "unknown",
            },
          }),
        );
      } catch (e) {
        if (
          !(e instanceof Error && e.name === "ConditionalCheckFailedException")
        )
          throw e;
      }
      const saved = await store.get(record.request.requestId);
      if (!saved) throw new Error("Wake audit missing");
      return saved;
    },
  };
  return store;
}
export function productionWake() {
  const lambda = new LambdaClient({ region: "us-west-1", maxAttempts: 1 });
  return wakeService(wakeStore(), async (request) => {
    const response = await lambda.send(
      new InvokeCommand({
        FunctionName: process.env.RUNTIME_WAKE_ARN!,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(request)),
      }),
      { abortSignal: AbortSignal.timeout(8000) },
    );
    if (response.FunctionError || response.StatusCode !== 200)
      throw new Error("Command outcome unknown");
    return JSON.parse(Buffer.from(response.Payload ?? []).toString());
  });
}
