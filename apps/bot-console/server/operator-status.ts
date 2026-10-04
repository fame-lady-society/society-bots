import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  snapshotSchema,
  runtime,
  recent,
  type RuntimeStatus,
} from "../src/runtime-contracts";
export const statusKey = "runtime:overclaw-leader";
export function projectStatus(
  item: unknown,
  now: number,
): RuntimeStatus | null {
  if (item === undefined) return null;
  if (
    !item ||
    typeof item !== "object" ||
    !("data" in item) ||
    !("revision" in item) ||
    typeof item.data !== "string" ||
    Buffer.byteLength(item.data) > 16384
  )
    throw new Error("Invalid status");
  const s = snapshotSchema.parse(JSON.parse(item.data));
  if (item.revision !== s.revision) throw new Error("Invalid revision");
  for (const at of [
    s.publishedAt,
    s.lifecycle.observedAt,
    s.lifecycle.lastHeardAt,
    s.lifecycle.checkpointCreatedAt,
    s.workers.observedAt,
  ]) {
    if (at !== null && at > now + 30)
      throw new Error("Invalid observation time");
  }
  const l = s.lifecycle;
  const w = s.workers;
  return {
    schemaVersion: 1,
    runtimeId: runtime.id,
    revision: s.revision,
    publishedAt: s.publishedAt,
    lifecycle: {
      availability: l.availability,
      observedAt: l.observedAt,
      error: l.error,
      phase: l.phase,
      lastHeardAt: l.lastHeardAt,
      ready: l.ready,
      startup: l.startup,
      blocker: l.blocker,
      checkpointCreatedAt: l.checkpointCreatedAt,
      launchVersion: l.launchVersion,
      heartbeatCurrent:
        l.generation !== null &&
        l.generation === l.lastHeardGeneration &&
        recent(l.lastHeardAt, now),
    },
    workers: {
      availability: w.availability,
      observedAt: w.observedAt,
      error: w.error,
      counts:
        w.counts === null
          ? null
          : {
              queued: w.counts.queued,
              launching: w.counts.launching,
              ready: w.counts.ready,
              draining: w.counts.draining,
              terminating: w.counts.terminating,
              stopping: w.counts.stopping,
              asleep: w.counts.asleep,
              paused: w.counts.paused,
              recovery: w.counts.recovery,
            },
      total: w.total,
    },
  };
}
export function operatorStatusReader() {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: process.env.OPERATOR_STATUS_REGION,
      maxAttempts: 1,
    }),
  );
  return async () => {
    if (
      !process.env.OPERATOR_STATUS_TABLE ||
      !process.env.OPERATOR_STATUS_REGION
    )
      throw new Error("Status is not configured");
    const response = await client.send(
      new GetCommand({
        TableName: process.env.OPERATOR_STATUS_TABLE,
        Key: { pk: statusKey },
        ConsistentRead: true,
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
    return response.Item;
  };
}
