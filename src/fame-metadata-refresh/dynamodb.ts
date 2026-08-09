import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { MetadataRefreshJob } from "./types.ts";

export const defaultDb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.DYNAMODB_REGION }));

function tableName() {
  const value = process.env.DYNAMODB_FAME_METADATA_REFRESH_TABLE_NAME;
  if (!value) throw new Error("DYNAMODB_FAME_METADATA_REFRESH_TABLE_NAME is not configured");
  return value;
}

export type MetadataRefreshStore = Pick<DynamoDBDocumentClient, "send">;
export type MetadataRefreshCheckpoint = { nextBlock: bigint; nextLogIndex: number };
export type MetadataRefreshCheckpointId = "base-metadata-update" | "base-marketplace-purchase";

export async function getCheckpoint(store: MetadataRefreshStore = defaultDb, checkpointId: MetadataRefreshCheckpointId = "base-metadata-update") {
  const result = await store.send(new GetCommand({ TableName: tableName(), Key: { pk: "checkpoint", sk: checkpointId } }));
  if (typeof result.Item?.nextBlock !== "number" || typeof result.Item?.nextLogIndex !== "number") return null;
  return { nextBlock: BigInt(result.Item.nextBlock), nextLogIndex: result.Item.nextLogIndex };
}

export async function initializeCheckpoint(startBlock: bigint, store: MetadataRefreshStore = defaultDb, checkpointId: MetadataRefreshCheckpointId = "base-metadata-update") {
  await store.send(new PutCommand({
    TableName: tableName(),
    Item: { pk: "checkpoint", sk: checkpointId, nextBlock: Number(startBlock), nextLogIndex: 0 },
    ConditionExpression: "attribute_not_exists(pk)",
  }));
}

export async function putJob(job: MetadataRefreshJob, store: MetadataRefreshStore = defaultDb) {
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

function purchaseNotificationKey(transactionHash: `0x${string}`, logIndex: number) {
  return { pk: `discord#${transactionHash}`, sk: `log#${logIndex}` };
}

export async function shouldPublishPurchaseNotification(transactionHash: `0x${string}`, logIndex: number, store: MetadataRefreshStore = defaultDb) {
  const key = purchaseNotificationKey(transactionHash, logIndex);
  try {
    await store.send(new PutCommand({
      TableName: tableName(),
      Item: { ...key, state: "pending" },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return true;
  } catch (error: unknown) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
  }
  const result = await store.send(new GetCommand({ TableName: tableName(), Key: key }));
  if (result.Item?.state === "published") return false;
  if (result.Item?.state === "pending") return true;
  throw new Error("Purchase notification state is malformed");
}

export async function markPurchaseNotificationPublished(transactionHash: `0x${string}`, logIndex: number, store: MetadataRefreshStore = defaultDb) {
  await store.send(new UpdateCommand({
    TableName: tableName(),
    Key: purchaseNotificationKey(transactionHash, logIndex),
    UpdateExpression: "SET #state = :published",
    ConditionExpression: "#state = :pending",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: { ":pending": "pending", ":published": "published" },
  }));
}

export async function markAccepted(job: MetadataRefreshJob, store: MetadataRefreshStore = defaultDb) {
  await store.send(new UpdateCommand({ TableName: tableName(), Key: { pk: `event#${job.chainId}#${job.transactionHash}`, sk: `log#${job.logIndex}` }, UpdateExpression: "SET #state = :accepted, attempts = :attempts", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":accepted": "accepted", ":attempts": job.attempts + 1 } }));
}

export async function markInFlight(job: MetadataRefreshJob, store: MetadataRefreshStore = defaultDb) {
  await store.send(new UpdateCommand({ TableName: tableName(), Key: { pk: `event#${job.chainId}#${job.transactionHash}`, sk: `log#${job.logIndex}` }, UpdateExpression: "SET #state = :inFlight, attempts = :attempts", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":inFlight": "in_flight", ":attempts": job.attempts + 1 } }));
}

export async function advanceCheckpoint(expected: MetadataRefreshCheckpoint, next: MetadataRefreshCheckpoint, store: MetadataRefreshStore = defaultDb, checkpointId: MetadataRefreshCheckpointId = "base-metadata-update") {
  await store.send(new UpdateCommand({ TableName: tableName(), Key: { pk: "checkpoint", sk: checkpointId }, UpdateExpression: "SET nextBlock = :nextBlock, nextLogIndex = :nextLogIndex", ConditionExpression: "nextBlock = :expectedBlock AND nextLogIndex = :expectedLogIndex", ExpressionAttributeValues: { ":nextBlock": Number(next.nextBlock), ":nextLogIndex": next.nextLogIndex, ":expectedBlock": Number(expected.nextBlock), ":expectedLogIndex": expected.nextLogIndex } }));
}
