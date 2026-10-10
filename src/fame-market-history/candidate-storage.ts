import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  candidateKey,
  candidateHash,
  candidateSpec,
  validateCandidateBounds,
  type CandidateBounds,
} from "./candidate.ts";
import { dataset, datasetKey } from "./dataset.ts";
import { activeScopeKey, progressKey, sampledKey } from "./keys.ts";
import { cursorKey } from "./storage.ts";
import { launchScope } from "./local-backfill.ts";
import type { TokenMetadata } from "./decode.ts";
import type { RpcMetrics } from "./rpc.ts";
export const CANDIDATE_LEASE_MS = 360_000; // Longer than the deployed 300s Lambda timeout.
const conditional = (e: unknown) =>
  e instanceof Error && e.name === "ConditionalCheckFailedException";
export function candidateStore(
  db: DynamoDBDocumentClient,
  table: string,
  now = Date.now,
) {
  const get = async (Key: Record<string, string>) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  const read = async () => {
    const row = await get(candidateKey);
    if (
      row &&
      (row.specHash !== candidateHash() ||
        row.spec !== JSON.stringify(candidateSpec()) ||
        !["running", "paused"].includes(row.desired) ||
        typeof row.completed !== "boolean")
    )
      throw new Error(
        "Candidate specification changed; use a reviewed new chunk",
      );
    return row;
  };
  return {
    read,
    control: async (command: "start" | "pause" | "resume") => {
      if (command === "start") {
        try {
          await db.send(
            new PutCommand({
              TableName: table,
              Item: {
                ...candidateKey,
                spec: JSON.stringify(candidateSpec()),
                specHash: candidateHash(),
                desired: "running",
                completed: false,
                createdAt: now(),
              },
              ConditionExpression: "attribute_not_exists(pk)",
            }),
          );
        } catch (e) {
          if (!conditional(e)) throw e;
          await read();
        } // Idempotent start never resets progress or resumes a paused job.
      } else
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: candidateKey,
            UpdateExpression: "SET desired = :desired",
            ConditionExpression: "specHash = :spec AND completed = :false",
            ExpressionAttributeValues: {
              ":desired": command === "pause" ? "paused" : "running",
              ":spec": candidateHash(),
              ":false": false,
            },
          }),
        );
      return read();
    },
    acquire: async (owner: string) => {
      try {
        const r = await db.send(
          new UpdateCommand({
            TableName: table,
            Key: candidateKey,
            UpdateExpression: "SET leaseOwner = :owner, leaseUntil = :until",
            ConditionExpression:
              "specHash = :spec AND desired = :running AND completed = :false AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)",
            ExpressionAttributeValues: {
              ":owner": owner,
              ":until": now() + CANDIDATE_LEASE_MS,
              ":now": now(),
              ":spec": candidateHash(),
              ":running": "running",
              ":false": false,
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        return r.Attributes!;
      } catch (e) {
        if (conditional(e)) {
          await read();
          return null;
        }
        throw e;
      }
    },
    canContinue: async (owner: string) => {
      const r = await read();
      return (
        r?.desired === "running" &&
        r.leaseOwner === owner &&
        r.leaseUntil > now()
      );
    },
    initialize: async (
      owner: string,
      bounds: CandidateBounds,
      metadata: TokenMetadata,
    ) => {
      validateCandidateBounds(bounds);
      const scope = launchScope();
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table,
                Key: candidateKey,
                UpdateExpression: "SET bounds = :bounds",
                ConditionExpression:
                  "leaseOwner = :owner AND leaseUntil > :now AND attribute_not_exists(bounds)",
                ExpressionAttributeValues: {
                  ":owner": owner,
                  ":now": now(),
                  ":bounds": bounds,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: { ...activeScopeKey, scopeId: scope.id },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: table,
                Item: { ...datasetKey(scope.id), ...dataset(scope, metadata) },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    },
    finish: async (
      owner: string,
      result: Record<string, unknown>,
      metrics: RpcMetrics,
    ) => {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: candidateKey,
          UpdateExpression:
            "SET lastResult = :result, lastRunAt = :now, lastMetrics = :metrics, completed = :done REMOVE leaseOwner, leaseUntil ADD measuredRequests :requests, measuredResponseBytes :bytes",
          ConditionExpression: "leaseOwner = :owner",
          ExpressionAttributeValues: {
            ":owner": owner,
            ":now": now(),
            ":result": result,
            ":metrics": metrics,
            ":done": result.phase === "complete",
            ":requests": metrics.requests,
            ":bytes": metrics.responseBytes,
          },
        }),
      );
    },
    status: async () => {
      const job = await read();
      if (!job) return { state: "not-started", spec: candidateSpec() };
      const s = candidateSpec();
      const [raw, aggregation, collected, published] = await Promise.all([
        get(cursorKey(s.scopeId)),
        get(progressKey(s.scopeId)),
        get(sampledKey(s.policyRevision, "collected")),
        get(sampledKey(s.policyRevision, "published")),
      ]);
      return {
        job,
        rawNextBlock: raw?.nextBlock ?? s.startBlock,
        parquetNextBlock: aggregation?.nextBlock ?? s.startBlock,
        sampleNextTimestamp: collected?.nextTimestamp ?? s.from,
        publishedNextTimestamp: published?.nextTimestamp ?? s.from,
        leaseActive: !!job.leaseOwner && job.leaseUntil > now(),
      };
    },
    aggregationNext: async () =>
      (await get(progressKey(candidateSpec().scopeId)))?.nextBlock ??
      candidateSpec().startBlock,
  };
}
