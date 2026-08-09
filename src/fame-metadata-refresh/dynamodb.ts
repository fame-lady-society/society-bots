import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { MetadataRefreshJob } from "./types.ts";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.DYNAMODB_REGION }));

function tableName() {
  const value = process.env.DYNAMODB_FAME_METADATA_REFRESH_TABLE_NAME;
  if (!value) throw new Error("DYNAMODB_FAME_METADATA_REFRESH_TABLE_NAME is not configured");
  return value;
}

export type MetadataRefreshStore = Pick<DynamoDBDocumentClient, "send">;

export async function getCheckpoint(store: MetadataRefreshStore = db) {
  const result = await store.send(new GetCommand({ TableName: tableName(), Key: { pk: "checkpoint", sk: "base-metadata-update" } }));
  return typeof result.Item?.nextBlock === "number" ? BigInt(result.Item.nextBlock) : null;
}

export async function initializeCheckpoint(startBlock: bigint, store: MetadataRefreshStore = db) {
  await store.send(new PutCommand({
    TableName: tableName(),
    Item: { pk: "checkpoint", sk: "base-metadata-update", nextBlock: Number(startBlock) },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
}

export async function putJob(job: MetadataRefreshJob, store: MetadataRefreshStore = db) {
  const key = { pk: `event#${job.chainId}#${job.transactionHash}`, sk: `log#${job.logIndex}` };
  try {
    await store.send(new PutCommand({ TableName: tableName(), Item: { ...key, tokenId: job.tokenId.toString(), blockNumber: Number(job.blockNumber), state: "pending", attempts: 0 }, ConditionExpression: "attribute_not_exists(pk)" }));
    return { ...job, state: "pending" as const, attempts: 0 };
  } catch (error: unknown) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
    const result = await store.send(new GetCommand({ TableName: tableName(), Key: key }));
    if (!result.Item || typeof result.Item.tokenId !== "string" || typeof result.Item.blockNumber !== "number" || typeof result.Item.state !== "string" || typeof result.Item.attempts !== "number") throw new Error("Metadata refresh job is malformed");
    return { ...job, tokenId: BigInt(result.Item.tokenId), blockNumber: BigInt(result.Item.blockNumber), state: result.Item.state as MetadataRefreshJob["state"], attempts: result.Item.attempts };
  }
}

export async function claimPurchaseNotification(transactionHash: `0x${string}`, logIndex: number, store: MetadataRefreshStore = db) {
  try {
    await store.send(new PutCommand({
      TableName: tableName(),
      Item: { pk: `discord#${transactionHash}`, sk: `log#${logIndex}`, state: "claimed" },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return true;
  } catch (error: unknown) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export async function markAccepted(job: MetadataRefreshJob, store: MetadataRefreshStore = db) {
  await store.send(new UpdateCommand({ TableName: tableName(), Key: { pk: `event#${job.chainId}#${job.transactionHash}`, sk: `log#${job.logIndex}` }, UpdateExpression: "SET #state = :accepted, attempts = :attempts", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":accepted": "accepted", ":attempts": job.attempts + 1 } }));
}

export async function markInFlight(job: MetadataRefreshJob, store: MetadataRefreshStore = db) {
  await store.send(new UpdateCommand({ TableName: tableName(), Key: { pk: `event#${job.chainId}#${job.transactionHash}`, sk: `log#${job.logIndex}` }, UpdateExpression: "SET #state = :inFlight, attempts = :attempts", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":inFlight": "in_flight", ":attempts": job.attempts + 1 } }));
}

export async function advanceCheckpoint(expected: bigint, next: bigint, store: MetadataRefreshStore = db) {
  await store.send(new UpdateCommand({ TableName: tableName(), Key: { pk: "checkpoint", sk: "base-metadata-update" }, UpdateExpression: "SET nextBlock = :next", ConditionExpression: "nextBlock = :expected", ExpressionAttributeValues: { ":next": Number(next), ":expected": Number(expected) } }));
}
