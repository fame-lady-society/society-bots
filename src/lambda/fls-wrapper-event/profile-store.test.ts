import { describe, expect, it } from "@jest/globals";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { createProfileNotificationStore } from "./profile-store.ts";
const transactionHash =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

function conditionalFailure() {
  const error = new Error("condition failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

class FakeDocumentClient {
  items = new Map<string, Record<string, unknown>>();

  async send(command: {
    constructor: { name: string };
    input: Record<string, any>;
  }) {
    const key = String(command.input.Key?.key ?? command.input.Item?.key);
    if (command.constructor.name === "GetCommand") {
      return { Item: this.items.get(key) };
    }
    if (command.constructor.name === "PutCommand") {
      if (command.input.ConditionExpression && this.items.has(key)) {
        throw conditionalFailure();
      }
      this.items.set(key, { ...command.input.Item });
      return {};
    }
    if (command.constructor.name === "UpdateCommand") {
      const current = this.items.get(key);
      if (!current) throw conditionalFailure();
      const values = command.input.ExpressionAttributeValues;
      if (values[":expectedBlock"] !== undefined) {
        if (
          current.nextBlock !== values[":expectedBlock"] ||
          current.nextLogIndex !== values[":expectedLogIndex"]
        ) {
          throw conditionalFailure();
        }
        this.items.set(key, {
          ...current,
          nextBlock: values[":nextBlock"],
          nextLogIndex: values[":nextLogIndex"],
        });
        return {};
      }
      if (current.state !== values[":pending"]) throw conditionalFailure();
      this.items.set(key, { ...current, state: values[":published"] });
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }
}

function setup() {
  const db = new FakeDocumentClient();
  const store = createProfileNotificationStore({
    db: db as unknown as Pick<DynamoDBDocumentClient, "send">,
    tableName: "wrapper-events",
  });
  return { db, store };
}

describe("DynamoDB Society profile notification store", () => {
  it("initializes and conditionally advances its independent checkpoint", async () => {
    const { store } = setup();
    await store.initializeCheckpoint(25_883_964n);
    expect(await store.getCheckpoint()).toEqual({
      nextBlock: 25_883_964n,
      nextLogIndex: 0,
    });

    await store.advanceCheckpoint(
      { nextBlock: 25_883_964n, nextLogIndex: 0 },
      { nextBlock: 25_883_965n, nextLogIndex: 0 },
    );
    expect(await store.getCheckpoint()).toEqual({
      nextBlock: 25_883_965n,
      nextLogIndex: 0,
    });
    await expect(
      store.advanceCheckpoint(
        { nextBlock: 25_883_964n, nextLogIndex: 0 },
        { nextBlock: 25_883_966n, nextLogIndex: 0 },
      ),
    ).rejects.toHaveProperty("name", "ConditionalCheckFailedException");
  });

  it("persists pending and published delivery state by event identity", async () => {
    const { store } = setup();
    expect(await store.reserveNotification(transactionHash, 7)).toBe(true);
    await store.markPublished(transactionHash, 7);
    expect(await store.reserveNotification(transactionHash, 7)).toBe(false);
    expect(await store.reserveNotification(transactionHash, 8)).toBe(true);
  });

  it("fails explicitly when the checkpoint record is malformed", async () => {
    const { db, store } = setup();
    await store.initializeCheckpoint(25_883_964n);
    const checkpointKey = [...db.items.keys()][0];
    db.items.set(checkpointKey, {
      key: checkpointKey,
      nextBlock: "not-a-number",
      nextLogIndex: 0,
    });

    await expect(store.getCheckpoint()).rejects.toThrow(
      "Society profile checkpoint is malformed",
    );
  });
});
