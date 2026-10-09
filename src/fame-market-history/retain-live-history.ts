import {
  GetCommand,
  BatchGetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { sampledReader } from "./sampled-reader.ts";
import { sampledKey } from "./keys.ts";
import {
  dayPublication,
  dayWrites,
  utcDay,
  validateDay,
  type DayPublication,
} from "./dated-publication.ts";
import { activityKey, validateActivityIndex } from "./activity-storage.ts";

/** One-time deployment catch-up: retain already-published immutable references.
 * No price rebuild, source write, or live cursor change. The generation guard
 * makes a concurrent live advance/repair abort the entire directory transaction. */
export async function retainLiveHistory(
  db: DynamoDBDocumentClient,
  table: string,
  revision: string,
  apply: boolean,
) {
  const p = await sampledReader(db, table, revision).publication();
  // Verify both currencies before exposing a durable directory reference.
  await Promise.all(
    (["ETH", "USDC"] as const).map((c) =>
      sampledReader(db, table, revision).pages(p.pages, c),
    ),
  );
  for (let offset = 0; offset < p.pages.length; offset += 100) {
    const refs = p.pages.slice(offset, offset + 100);
    const expected = new Map(
      refs.map((ref) => [
        JSON.stringify(activityKey(revision, ref)),
        ref.timestamp,
      ]),
    );
    const result = await db.send(
      new BatchGetCommand({
        RequestItems: {
          [table]: {
            Keys: refs.map((ref) => activityKey(revision, ref)),
            ConsistentRead: true,
          },
        },
      }),
    );
    if (result.UnprocessedKeys?.[table]?.Keys?.length)
      throw new Error("Activity index read incomplete; retry retention");
    for (const row of result.Responses?.[table] ?? []) {
      const k = JSON.stringify({ pk: row.pk, sk: row.sk });
      if (
        !expected.has(k) ||
        validateActivityIndex(JSON.parse(row.body)).timestamp !==
          expected.get(k)
      )
        throw new Error("Invalid published activity index");
      expected.delete(k);
    }
    if (expected.size) throw new Error("Missing published activity index");
  }
  const transactions = [];
  let added = 0;
  for (const day of [...new Set(p.pages.map((ref) => utcDay(ref.timestamp)))]) {
    const item = (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: sampledKey(revision, `day:${day}`),
          ConsistentRead: true,
        }),
      )
    ).Item;
    const previous: DayPublication | null = item
      ? validateDay(JSON.parse(item.body), revision, day)
      : null;
    const refs = new Map(
      previous?.pages.map((ref) => [ref.timestamp, ref]) ?? [],
    );
    for (const ref of p.pages.filter((ref) => utcDay(ref.timestamp) === day)) {
      const existing = refs.get(ref.timestamp);
      if (existing && (existing.ETH !== ref.ETH || existing.USDC !== ref.USDC))
        throw new Error("Published and dated references disagree");
      if (!existing) added++;
      refs.set(ref.timestamp, ref);
    }
    const next = dayPublication(revision, day, [...refs.values()]);
    if (next.generation !== previous?.generation)
      transactions.push(...dayWrites(table, previous, next));
  }
  if (apply && transactions.length)
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: table,
              Key: sampledKey(revision, "published"),
              ConditionExpression: "generation = :generation",
              ExpressionAttributeValues: { ":generation": p.generation },
            },
          },
          ...transactions,
        ],
      }),
    );
  return {
    policyRevision: revision,
    generation: p.generation,
    from: p.startTimestamp,
    to: p.nextTimestamp,
    added,
    apply,
    rpcCalls: 0,
    liveCursorWrites: 0,
  };
}
