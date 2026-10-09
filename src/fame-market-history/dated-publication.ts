import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { digest } from "./model.ts";
import { sampledKey } from "./keys.ts";
import type { SampledPageRef, SampledPublication } from "./sampled-live.ts";
export const utcDay = (t: number) => Math.floor(t / 86400) * 86400;
export interface DayPublication {
  version: "fame-history-day-v1";
  policyRevision: string;
  day: number;
  pages: SampledPageRef[];
  generation: string;
}
export interface WindowSource {
  key: string;
  generation: string | null;
}
export interface WindowPublication {
  version: "fame-history-window-v1";
  policyRevision: string;
  startTimestamp: number;
  nextTimestamp: number;
  pages: SampledPageRef[];
  generation: string;
  sources: WindowSource[];
}
export type ReadPublication = SampledPublication | WindowPublication;
const sha = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export function validateSources(
  value: unknown,
): asserts value is WindowSource[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 3 ||
    new Set(value.map((s) => s?.key)).size !== value.length ||
    value.some(
      (s) =>
        !s ||
        !/^(published|day:(0|[1-9][0-9]{0,12}))$/.test(s.key) ||
        (s.key !== "published" && Number(s.key.slice(4)) % 86400 !== 0) ||
        (s.generation !== null && !sha(s.generation)),
    )
  )
    throw new Error("Invalid historical cursor sources");
}
export function dayPublication(
  revision: string,
  day: number,
  refs: SampledPageRef[],
): DayPublication {
  const pages = refs
    .map((p) => ({ timestamp: p.timestamp, ETH: p.ETH, USDC: p.USDC }))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (
    !sha(revision) ||
    !Number.isSafeInteger(day) ||
    day < 0 ||
    day % 86400 ||
    pages.length < 1 ||
    pages.length > 288 ||
    pages.some(
      (p, i) =>
        !Number.isSafeInteger(p.timestamp) ||
        p.timestamp % 300 ||
        utcDay(p.timestamp) !== day ||
        !sha(p.ETH) ||
        !sha(p.USDC) ||
        (i > 0 && p.timestamp <= pages[i - 1].timestamp),
    )
  )
    throw new Error("Invalid dated publication");
  const body = {
    version: "fame-history-day-v1" as const,
    policyRevision: revision,
    day,
    pages,
  };
  return { ...body, generation: digest(JSON.stringify(body)) };
}
export function validateDay(p: DayPublication, revision: string, day: number) {
  const expected = dayPublication(revision, day, p.pages);
  if (
    p.version !== expected.version ||
    p.policyRevision !== revision ||
    p.day !== day ||
    p.generation !== expected.generation
  )
    throw new Error("Corrupt dated publication");
  return expected;
}
export function updateDay(
  previous: DayPublication | null,
  revision: string,
  ref: SampledPageRef,
) {
  const day = utcDay(ref.timestamp);
  if (previous) validateDay(previous, revision, day);
  return dayPublication(revision, day, [
    ...(previous?.pages.filter((p) => p.timestamp !== ref.timestamp) ?? []),
    ref,
  ]);
}
/** Pages/activity are staged first. The dated pointer shares the live CAS
 * transaction, so repairs and live appends cannot lose each other's references. */
export function dayWrites(
  table: string,
  previous: DayPublication | null,
  next: DayPublication,
  now = Date.now(),
): NonNullable<TransactWriteCommandInput["TransactItems"]> {
  const snapshots = new Map(
    [previous, next]
      .filter((p): p is DayPublication => !!p)
      .map((p) => [p.generation, p]),
  );
  return [
    ...[...snapshots.values()].map((p) => ({
      Put: {
        TableName: table,
        Item: {
          ...sampledKey(p.policyRevision, `day-manifest:${p.generation}`),
          body: JSON.stringify(p),
          expiresAt: Math.floor(now / 1000) + 86400,
        },
        ConditionExpression: "attribute_not_exists(pk) OR body = :body",
        ExpressionAttributeValues: { ":body": JSON.stringify(p) },
      },
    })),
    {
      Put: {
        TableName: table,
        Item: {
          ...sampledKey(next.policyRevision, `day:${next.day}`),
          body: JSON.stringify(next),
        },
        ConditionExpression: previous
          ? "body = :old"
          : "attribute_not_exists(pk)",
        ...(previous
          ? { ExpressionAttributeValues: { ":old": JSON.stringify(previous) } }
          : {}),
      },
    },
  ];
}
