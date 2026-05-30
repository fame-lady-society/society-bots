import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { baseClient } from "../src/viem.ts";
import {
  handleFamePoolQuoteBatchRequest,
} from "../src/fame-swap-pool-state/cl-quote.ts";
import {
  handleFamePoolStateBatchRequest,
} from "../src/fame-swap-pool-state/api.ts";
import {
  createViemPoolStateIndexerClient,
  indexFamePoolStates,
} from "../src/fame-swap-pool-state/indexer.ts";
import type {
  PoolStateDocumentClient,
  PoolStateDynamoResponse,
} from "../src/fame-swap-pool-state/dynamodb/pool-state.ts";

type SentCommand = Parameters<PoolStateDocumentClient["send"]>[0];

class LocalPoolStateDb implements PoolStateDocumentClient {
  private readonly items = new Map<string, Record<string, unknown>>();

  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    if (command instanceof GetCommand) {
      return { Item: this.items.get(keyFromValue(command.input.Key)) };
    }
    if (command instanceof BatchGetCommand) {
      const responses: Record<string, Record<string, unknown>[]> = {};
      const requestItems = objectValue(command.input.RequestItems);
      for (const [tableName, request] of Object.entries(requestItems)) {
        const keys = objectValue(request).Keys;
        if (!Array.isArray(keys)) {
          throw new Error("BatchGetCommand keys must be an array.");
        }
        responses[tableName] = keys
          .map((key) => this.items.get(keyFromValue(key)))
          .filter((item): item is Record<string, unknown> => item !== undefined);
      }
      return { Responses: responses };
    }
    if (command instanceof PutCommand) {
      const item = objectValue(command.input.Item);
      const existing = this.items.get(keyFromRecord(item));
      enforcePutCondition(command, item, existing);
      this.items.set(keyFromRecord(item), item);
      return {};
    }
    if (command instanceof UpdateCommand) {
      const key = keyFromValue(command.input.Key);
      const existing = this.items.get(key);
      if (!existing) throwConditionalFailure();
      const values = objectValue(command.input.ExpressionAttributeValues);
      const observedThroughBlock = numberField(values, ":observedThroughBlock");
      if (
        typeof existing.observedThroughBlock === "number" &&
        existing.observedThroughBlock >= observedThroughBlock
      ) {
        throwConditionalFailure();
      }
      this.items.set(key, {
        ...existing,
        observedThroughBlock,
        sourceRegistryId: stringField(values, ":sourceRegistryId"),
        updatedAt: stringField(values, ":updatedAt"),
      });
      return {};
    }
    throw new Error("Unexpected DynamoDB command.");
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function keyFromRecord(record: Record<string, unknown>): string {
  return `${stringField(record, "pk")}\u0000${stringField(record, "sk")}`;
}

function keyFromValue(value: unknown): string {
  return keyFromRecord(objectValue(value));
}

function stringField(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
}

function numberField(item: Record<string, unknown>, key: string): number {
  const value = item[key];
  if (typeof value !== "number") throw new Error(`${key} must be a number.`);
  return value;
}

function eventVersion(item: Record<string, unknown>) {
  return {
    blockNumber: numberField(item, "lastReserveChangeBlock"),
    transactionIndex: numberField(item, "lastEventTransactionIndex"),
    logIndex: numberField(item, "lastEventLogIndex"),
  };
}

function compareEventVersions(
  left: ReturnType<typeof eventVersion>,
  right: ReturnType<typeof eventVersion>,
): number {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber - right.blockNumber;
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex - right.transactionIndex;
  }
  return left.logIndex - right.logIndex;
}

function throwConditionalFailure(): never {
  const error = new Error("conditional");
  error.name = "ConditionalCheckFailedException";
  throw error;
}

function enforcePutCondition(
  command: PutCommand,
  item: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): void {
  if (!existing) return;
  const condition = String(command.input.ConditionExpression ?? "");
  if (condition.length === 0) return;
  if (condition === "attribute_not_exists(pk)") throwConditionalFailure();
  const values = objectValue(command.input.ExpressionAttributeValues);
  if (condition.includes("lastReserveChangeBlock")) {
    if (numberField(existing, "observedThroughBlock") > numberField(values, ":observedThroughBlock")) {
      throwConditionalFailure();
    }
    if (compareEventVersions(eventVersion(item), eventVersion(existing)) <= 0) {
      throwConditionalFailure();
    }
    return;
  }
  if (condition.includes("cursorBlock")) {
    const current = {
      cursorBlock: numberField(existing, "cursorBlock"),
      cursorTransactionIndex: numberField(existing, "cursorTransactionIndex"),
      cursorLogIndex: numberField(existing, "cursorLogIndex"),
      sourceRegistryId: stringField(existing, "sourceRegistryId"),
    };
    const incoming = {
      cursorBlock: numberField(values, ":cursorBlock"),
      cursorTransactionIndex: numberField(values, ":cursorTransactionIndex"),
      cursorLogIndex: numberField(values, ":cursorLogIndex"),
      sourceRegistryId: stringField(values, ":sourceRegistryId"),
    };
    const stale =
      current.cursorBlock > incoming.cursorBlock ||
      (current.cursorBlock === incoming.cursorBlock &&
        current.cursorTransactionIndex > incoming.cursorTransactionIndex) ||
      (current.cursorBlock === incoming.cursorBlock &&
        current.cursorTransactionIndex === incoming.cursorTransactionIndex &&
        current.cursorLogIndex > incoming.cursorLogIndex) ||
      (current.cursorBlock === incoming.cursorBlock &&
        current.cursorTransactionIndex === incoming.cursorTransactionIndex &&
        current.cursorLogIndex === incoming.cursorLogIndex &&
        current.sourceRegistryId !== incoming.sourceRegistryId);
    if (stale) throwConditionalFailure();
    return;
  }
  if (condition.includes("observedThroughBlock")) {
    const currentBlock = numberField(existing, "observedThroughBlock");
    const incomingBlock = numberField(values, ":observedThroughBlock");
    const currentSourceRegistryId = stringField(existing, "sourceRegistryId");
    const rawIncomingSourceRegistryId = values[":sourceRegistryId"];
    const incomingSourceRegistryId =
      typeof rawIncomingSourceRegistryId === "string"
        ? rawIncomingSourceRegistryId
        : currentSourceRegistryId;
    if (
      currentBlock > incomingBlock ||
      (currentBlock === incomingBlock && currentSourceRegistryId !== incomingSourceRegistryId)
    ) {
      throwConditionalFailure();
    }
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body || "{}") as unknown;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.split("\n", 1)[0] ?? "Unknown error";
  }
  return "Unknown error";
}

async function main(): Promise<void> {
  const port = Number(process.env.FAME_POOL_STATE_LOCAL_PORT ?? "3977");
  const token = process.env.FAME_POOL_STATE_SERVICE_TOKEN ?? "local-route-lab";
  const seedConfirmationBlocks = Number(
    process.env.FAME_POOL_STATE_LOCAL_SEED_CONFIRMATION_BLOCKS ?? "64",
  );
  const finalConfirmationBlocks = Number(
    process.env.FAME_POOL_STATE_LOCAL_FINAL_CONFIRMATION_BLOCKS ?? "2",
  );
  const tableName = "LocalPoolState";
  const db = new LocalPoolStateDb();
  const client = createViemPoolStateIndexerClient(baseClient);
  const seedResult = await indexFamePoolStates({
    client,
    db,
    tableName,
    confirmationBlocks: seedConfirmationBlocks,
    clReplayMaintenanceMode: "checkpoint",
    clReplayTrustPromotion: true,
  });
  console.log(
    JSON.stringify({
      event: "local-indexed",
      phase: "checkpoint-seed",
      result: seedResult,
    }),
  );
  const result = await indexFamePoolStates({
    client: createViemPoolStateIndexerClient(baseClient),
    db,
    tableName,
    confirmationBlocks: finalConfirmationBlocks,
    clReplayMaintenanceMode: "steady-state",
    clReplayTrustPromotion: true,
  });
  console.log(
    JSON.stringify({ event: "local-indexed", phase: "steady-state", result }),
  );

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== "POST") {
          json(response, 405, { error: "method-not-allowed" });
          return;
        }
        if (request.headers.authorization !== `Bearer ${token}`) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        const body = await readBody(request);
        if (request.url === "/fame/pool-state") {
          json(
            response,
            200,
            await handleFamePoolStateBatchRequest({ request: body, db, tableName }),
          );
          return;
        }
        if (request.url === "/fame/pool-quotes") {
          json(
            response,
            200,
            await handleFamePoolQuoteBatchRequest({ request: body, db, tableName }),
          );
          return;
        }
        json(response, 404, { error: "not-found" });
      } catch (error) {
        json(response, 500, {
          error: safeErrorMessage(error),
        });
      }
    })();
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ event: "local-server-ready", port }));
  });
}

await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ event: "local-server-failed", error: safeErrorMessage(error) }),
  );
  process.exitCode = 1;
});
