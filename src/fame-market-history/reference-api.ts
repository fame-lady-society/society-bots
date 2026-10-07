import {
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  publicReference,
  referenceKey,
  unavailableReference,
  type ReferencePoint,
  type ReferenceProgress,
} from "./reference.ts";
export async function readReferences(
  db: DynamoDBDocumentClient,
  table: string,
  scopeId: string,
  progress: ReferenceProgress | undefined,
  from: number,
  to: number,
  signal: AbortSignal,
) {
  const rows = new Map<number, ReferencePoint>();
  if (
    !progress ||
    to <= progress.startTimestamp ||
    from >= progress.nextTimestamp
  )
    return rows;
  const first = Math.max(from, progress.startTimestamp),
    end = Math.min(to, progress.nextTimestamp);
  let cursor: Record<string, unknown> | undefined;
  for (let page = 0; page < 2; page++) {
    const key = referenceKey(scopeId, first);
    const result = await db.send(
      new QueryCommand({
        TableName: table,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": key.pk,
          ":from": key.sk,
          ":to": String(end - 300).padStart(16, "0"),
        },
        Limit: 288 - rows.size,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
      { abortSignal: signal },
    );
    for (const item of result.Items ?? []) {
      const t = item.timestamp;
      if (
        !Number.isSafeInteger(t) ||
        t % 300 ||
        t < first ||
        t >= end ||
        item.pk !== key.pk ||
        item.sk !== referenceKey(scopeId, t).sk ||
        rows.has(t)
      )
        throw new Error("Reference row boundary mismatch");
      const point = publicReference(item, progress.policyRevision);
      if (point.sampledAt! >= t + 300)
        throw new Error("Future reference sample");
      rows.set(t, point);
    }
    cursor = result.LastEvaluatedKey;
    if (!cursor) break;
    if (rows.size >= 288) throw new Error("Reference read limit");
  }
  if (cursor || rows.size !== (end - first) / 300)
    throw new Error("Reference coverage gap");
  return rows;
}
export function referenceAt(
  timestamp: number,
  progress: ReferenceProgress | undefined,
  rows: Map<number, ReferencePoint>,
) {
  if (
    progress &&
    timestamp >= progress.startTimestamp &&
    timestamp < progress.nextTimestamp
  ) {
    const row = rows.get(timestamp);
    if (!row) throw new Error("Reference coverage gap");
    return row;
  }
  return unavailableReference(
    !progress || timestamp < progress.startTimestamp
      ? "before-reference-start"
      : "not-yet-published",
  );
}
