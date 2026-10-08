import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { digest } from "./model.ts";
import type { SampledPageRef } from "./sampled-live.ts";
import type { ActivityRow, ActivityType } from "./activity-events.ts";
export const ACTIVITY_VERSION = "fame-activity-v1";
export const activityKey = (revision: string, ref: SampledPageRef) => ({
  pk: `activity:${ACTIVITY_VERSION}:${revision}`,
  sk: `${ref.timestamp}:${digest(JSON.stringify([ref.ETH, ref.USDC]))}`,
});
export const activityChunkKey = (revision: string, sha: string) => ({
  pk: `activity-chunk:${ACTIVITY_VERSION}:${revision}`,
  sk: sha,
});
export interface ActivityChunk {
  sha256: string;
  count: number;
  bytes: number;
  types: ActivityType[];
  max: Record<"ETH" | "USDC", string | null>;
}
export interface ActivityIndex {
  version: typeof ACTIVITY_VERSION;
  timestamp: number;
  coverage: "complete" | "partial" | "missing";
  count: number;
  unpriced: Record<"ETH" | "USDC", number>;
  chunks: ActivityChunk[];
}
const atoms = (v: string) => BigInt(v.replace(".", ""));
export function buildActivityIndex(
  timestamp: number,
  rows: ActivityRow[],
  coverage: ActivityIndex["coverage"],
) {
  if (rows.length > 50000)
    throw new Error("Activity bucket exceeds event allowance");
  const pages = [];
  for (let i = 0; i < rows.length; i += 100) {
    const part = rows.slice(i, i + 100),
      body = JSON.stringify(part),
      sha256 = digest(body);
    if (Buffer.byteLength(body) > 250 * 1024)
      throw new Error("Activity chunk too large");
    const max = Object.fromEntries(
      (["ETH", "USDC"] as const).map((c) => [
        c,
        part.reduce<string | null>(
          (m, r) =>
            r.values[c] !== null &&
            (m === null || atoms(r.values[c]!) > atoms(m))
              ? r.values[c]
              : m,
          null,
        ),
      ]),
    ) as ActivityChunk["max"];
    pages.push({
      body,
      ref: {
        sha256,
        count: part.length,
        bytes: Buffer.byteLength(body),
        types: [...new Set(part.map((r) => r.type))].sort(),
        max,
      },
    });
  }
  const index: ActivityIndex = {
    version: ACTIVITY_VERSION,
    timestamp,
    coverage,
    count: rows.length,
    unpriced: {
      ETH: rows.filter((r) => r.values.ETH === null).length,
      USDC: rows.filter((r) => r.values.USDC === null).length,
    },
    chunks: pages.map((p) => p.ref),
  };
  if (Buffer.byteLength(JSON.stringify(index)) > 250 * 1024)
    throw new Error("Activity index too large");
  return { index, pages };
}
export async function writeActivity(
  db: DynamoDBDocumentClient,
  table: string,
  revision: string,
  ref: SampledPageRef,
  rows: ActivityRow[],
  coverage: ActivityIndex["coverage"],
) {
  const built = buildActivityIndex(ref.timestamp, rows, coverage);
  const put = (Key: Record<string, string>, body: string) =>
    db.send(
      new PutCommand({
        TableName: table,
        Item: { ...Key, body },
        ConditionExpression: "attribute_not_exists(pk) OR body = :body",
        ExpressionAttributeValues: { ":body": body },
      }),
    );
  for (let i = 0; i < built.pages.length; i += 4)
    await Promise.all(
      built.pages
        .slice(i, i + 4)
        .map((p) => put(activityChunkKey(revision, p.ref.sha256), p.body)),
    );
  // Commit the index only after every immutable chunk is present.
  await put(activityKey(revision, ref), JSON.stringify(built.index));
  return built.index;
}
export async function activityIndexed(
  db: DynamoDBDocumentClient,
  table: string,
  revision: string,
  ref: SampledPageRef,
) {
  const row = (
    await db.send(
      new GetCommand({
        TableName: table,
        Key: activityKey(revision, ref),
        ConsistentRead: true,
      }),
    )
  ).Item;
  if (!row) return false;
  const index = validateActivityIndex(JSON.parse(row.body));
  if (index.timestamp !== ref.timestamp)
    throw new Error("Activity timestamp mismatch");
  return true;
}

export function validateActivityIndex(value: unknown): ActivityIndex {
  const v = value as ActivityIndex;
  const count = (x: number) => Number.isSafeInteger(x) && x >= 0;
  const size = (x: string | null) =>
    x === null ||
    (typeof x === "string" && /^(0|[1-9][0-9]*)\.[0-9]{18}$/.test(x));
  if (
    !v ||
    v.version !== ACTIVITY_VERSION ||
    !count(v.timestamp) ||
    v.timestamp % 300 !== 0 ||
    !["complete", "partial", "missing"].includes(v.coverage) ||
    !count(v.count) ||
    v.count > 50000 ||
    !v.unpriced ||
    ![v.unpriced.ETH, v.unpriced.USDC].every((x) => count(x) && x <= v.count) ||
    !Array.isArray(v.chunks) ||
    v.chunks.length > 500 ||
    v.chunks.some(
      (c) =>
        !c ||
        !/^[a-f0-9]{64}$/.test(c.sha256) ||
        !count(c.count) ||
        c.count < 1 ||
        c.count > 100 ||
        !count(c.bytes) ||
        c.bytes < 2 ||
        c.bytes > 250 * 1024 ||
        !Array.isArray(c.types) ||
        !c.types.length ||
        c.types.some((t) => !["buy", "sell", "add", "remove"].includes(t)) ||
        !c.max ||
        !size(c.max.ETH) ||
        !size(c.max.USDC),
    ) ||
    v.count !== v.chunks.reduce((n, c) => n + c.count, 0)
  )
    throw new Error("Invalid activity index layout");
  return v;
}
