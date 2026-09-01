import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mainnet } from "viem/chains";

import { ETHEREUM_FLS_NAMING_ADDRESS } from "@/constants.ts";

export type ProfileCheckpoint = {
  nextBlock: bigint;
  nextLogIndex: number;
};

export type ProfileNotificationStore = {
  getCheckpoint(): Promise<ProfileCheckpoint | null>;
  initializeCheckpoint(startBlock: bigint): Promise<void>;
  advanceCheckpoint(
    expected: ProfileCheckpoint,
    next: ProfileCheckpoint,
  ): Promise<void>;
  reserveNotification(
    transactionHash: `0x${string}`,
    logIndex: number,
  ): Promise<boolean>;
  markPublished(
    transactionHash: `0x${string}`,
    logIndex: number,
  ): Promise<void>;
};

const PROFILE_NOTIFICATION_NAMESPACE = [
  "profile-notifications",
  mainnet.id,
  ETHEREUM_FLS_NAMING_ADDRESS.toLowerCase(),
].join(":");
const CHECKPOINT_KEY = `${PROFILE_NOTIFICATION_NAMESPACE}:checkpoint`;

function notificationKey(transactionHash: `0x${string}`, logIndex: number) {
  return [
    PROFILE_NOTIFICATION_NAMESPACE,
    transactionHash.toLowerCase(),
    logIndex,
  ].join(":");
}

export function createProfileNotificationStore({
  db,
  tableName,
}: {
  db: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
}): ProfileNotificationStore {
  return {
    async getCheckpoint() {
      const response = await db.send(
        new GetCommand({
          TableName: tableName,
          Key: { key: CHECKPOINT_KEY },
        }),
      );
      if (!response.Item) return null;
      if (
        typeof response.Item.nextBlock !== "number" ||
        typeof response.Item.nextLogIndex !== "number"
      ) {
        throw new Error("Society profile checkpoint is malformed");
      }
      return {
        nextBlock: BigInt(response.Item.nextBlock),
        nextLogIndex: response.Item.nextLogIndex,
      };
    },

    async initializeCheckpoint(startBlock) {
      await db.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            key: CHECKPOINT_KEY,
            nextBlock: Number(startBlock),
            nextLogIndex: 0,
          },
          ConditionExpression: "attribute_not_exists(#key)",
          ExpressionAttributeNames: { "#key": "key" },
        }),
      );
    },

    async advanceCheckpoint(expected, next) {
      await db.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { key: CHECKPOINT_KEY },
          UpdateExpression:
            "SET nextBlock = :nextBlock, nextLogIndex = :nextLogIndex",
          ConditionExpression:
            "nextBlock = :expectedBlock AND nextLogIndex = :expectedLogIndex",
          ExpressionAttributeValues: {
            ":nextBlock": Number(next.nextBlock),
            ":nextLogIndex": next.nextLogIndex,
            ":expectedBlock": Number(expected.nextBlock),
            ":expectedLogIndex": expected.nextLogIndex,
          },
        }),
      );
    },

    async reserveNotification(transactionHash, logIndex) {
      const key = notificationKey(transactionHash, logIndex);
      try {
        await db.send(
          new PutCommand({
            TableName: tableName,
            Item: { key, state: "pending" },
            ConditionExpression: "attribute_not_exists(#key)",
            ExpressionAttributeNames: { "#key": "key" },
          }),
        );
        return true;
      } catch (error: unknown) {
        if (
          (error as { name?: string }).name !==
          "ConditionalCheckFailedException"
        ) {
          throw error;
        }
      }

      const response = await db.send(
        new GetCommand({ TableName: tableName, Key: { key } }),
      );
      if (response.Item?.state === "published") return false;
      if (response.Item?.state === "pending") return true;
      throw new Error("Society profile notification state is malformed");
    },

    async markPublished(transactionHash, logIndex) {
      await db.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { key: notificationKey(transactionHash, logIndex) },
          UpdateExpression: "SET #state = :published",
          ConditionExpression: "#state = :pending",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":published": "published",
          },
        }),
      );
    },
  };
}
