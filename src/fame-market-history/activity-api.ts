import {
  BatchGetCommand,
  GetCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { HistoryError } from "./api.ts";
import { digest, type Scope } from "./model.ts";
import { sampledPolicy, type Currency } from "./sampled-market.ts";
import { sampledReader } from "./sampled-reader.ts";
import { validateSampledPublication } from "./sampled-live.ts";
import { parseSampledRequest } from "./sampled-api.ts";
import {
  validateActivityIndex,
  ACTIVITY_VERSION,
  activityKey,
  activityChunkKey,
  type ActivityIndex,
} from "./activity-storage.ts";
import type { ActivityRow, ActivityType } from "./activity-events.ts";
export interface ActivityRequest {
  currency: Currency;
  from: number;
  to: number;
  type: ActivityType | "all";
  pool?: string;
  min?: string;
  max?: string;
  limit: number;
  cursor?: string;
}
const decimal = /^(0|[1-9][0-9]{0,19})(\.[0-9]{1,18})?$/;
export const sizeAtoms = (s: string) => {
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0"));
};
function decodeCursor(raw: string) {
  if (raw.length > 1500 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new HistoryError(400, "invalid-query");
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (c.version !== ACTIVITY_VERSION)
      throw new HistoryError(409, "cursor-reset-required");
    if (
      ![c.revision, c.generation, c.query].every(
        (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
      ) ||
      ![c.page, c.chunk, c.row].every(
        (v) => Number.isSafeInteger(v) && v >= 0,
      ) ||
      c.page > 288 ||
      c.chunk > 500 ||
      c.row > 100
    )
      throw new Error();
    return c as {
      version: string;
      revision: string;
      generation: string;
      query: string;
      page: number;
      chunk: number;
      row: number;
    };
  } catch (e) {
    if (e instanceof HistoryError) throw e;
    throw new HistoryError(400, "invalid-query");
  }
}
export function parseActivityRequest(
  raw: string,
  scope: Scope,
  now = Date.now(),
): ActivityRequest {
  const q = new URLSearchParams(raw),
    allowed = [
      "view",
      "currency",
      "from",
      "to",
      "resolution",
      "type",
      "pool",
      "min",
      "max",
      "limit",
      "cursor",
    ];
  for (const k of q.keys())
    if (!allowed.includes(k) || q.getAll(k).length !== 1)
      throw new HistoryError(400, "invalid-query");
  if (q.get("view") !== "activity")
    throw new HistoryError(400, "invalid-query");
  const type = q.get("type") ?? "all",
    pool = q.get("pool") ?? undefined,
    min = q.get("min") ?? undefined,
    max = q.get("max") ?? undefined,
    cursor = q.get("cursor") ?? undefined,
    limit = Number(q.get("limit") ?? "50");
  if (
    !["all", "buy", "sell", "add", "remove"].includes(type) ||
    (pool !== undefined && !scope.pools.some((p) => p.id === pool)) ||
    ![min, max].every((v) => v === undefined || decimal.test(v)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (min !== undefined && max !== undefined && sizeAtoms(min) > sizeAtoms(max))
  )
    throw new HistoryError(400, "invalid-query");
  if (cursor !== undefined) decodeCursor(cursor);
  for (const k of ["type", "pool", "min", "max", "limit", "cursor"])
    q.delete(k);
  q.set("view", "sampled-market");
  return {
    ...parseSampledRequest(q.toString(), now),
    type: type as ActivityRequest["type"],
    ...(pool ? { pool } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    limit,
  };
}
export async function readActivity(
  db: DynamoDBDocumentClient,
  table: string,
  scope: Scope,
  request: ActivityRequest,
  now = Date.now,
) {
  const revision = sampledPolicy(scope).revision,
    reader = sampledReader(db, table, revision, now),
    started = now();
  const { cursor: raw, ...filters } = request,
    query = digest(JSON.stringify(filters)),
    cursor = raw ? decodeCursor(raw) : null;
  if (cursor && (cursor.query !== query || cursor.revision !== revision))
    throw new HistoryError(409, "cursor-reset-required");
  let publication = await reader.publication();
  if (cursor && cursor.generation !== publication.generation) {
    const row = await reader.get(`manifest:${cursor.generation}`);
    if (!row) throw new HistoryError(409, "cursor-reset-required");
    if (!Number.isSafeInteger(row.expiresAt) || typeof row.body !== "string")
      throw new Error("Invalid retained activity manifest");
    if (row.expiresAt <= Math.floor(now() / 1000))
      throw new HistoryError(409, "cursor-reset-required");
    publication = validateSampledPublication(JSON.parse(row.body), revision);
    if (publication.generation !== cursor.generation)
      throw new Error("Activity manifest mismatch");
  }
  const refs = publication.pages
    .filter((p) => p.timestamp >= request.from && p.timestamp < request.to)
    .reverse();
  let page = cursor?.page ?? 0,
    chunk = cursor?.chunk ?? 0,
    rowOffset = cursor?.row ?? 0;
  if (page > refs.length) throw new HistoryError(400, "invalid-query");
  const signal = () => {
    const remaining = 6000 - (now() - started);
    if (remaining <= 0)
      throw new HistoryError(503, "history-read-budget-exceeded");
    return AbortSignal.timeout(remaining);
  };
  // A bounded metadata batch covers quiet/sparse filters without serial per-bucket reads.
  const batch = refs.slice(page, page + 16),
    keys = batch.map((r) => activityKey(revision, r));
  const indexes = new Map<string, ActivityIndex>();
  let pending = keys;
  for (let attempt = 0; pending.length; attempt++) {
    const r = await db.send(
      new BatchGetCommand({
        RequestItems: { [table]: { Keys: pending, ConsistentRead: true } },
      }),
      { abortSignal: signal() },
    );
    for (const item of r.Responses?.[table] ?? []) {
      if (
        !keys.some((k) => k.pk === item.pk && k.sk === item.sk) ||
        typeof item.body !== "string"
      )
        throw new Error("Invalid activity index");
      if (indexes.has(item.sk)) throw new Error("Duplicate activity index");
      const index = validateActivityIndex(JSON.parse(item.body));
      indexes.set(item.sk, index);
    }
    pending = (r.UnprocessedKeys?.[table]?.Keys ?? []).map((k) => {
      const expected = keys.find((e) => e.pk === k.pk && e.sk === k.sk);
      if (!expected || indexes.has(expected.sk))
        throw new Error("Invalid unprocessed activity key");
      return expected;
    });
    if (new Set(pending.map((k) => k.sk)).size !== pending.length)
      throw new Error("Duplicate unprocessed activity key");
    if (pending.length) {
      if (attempt >= 2)
        throw new HistoryError(503, "history-read-budget-exceeded");
      await new Promise((r) => setTimeout(r, 30 * 2 ** attempt));
    }
  }
  const rows: ActivityRow[] = [],
    gaps: { timestamp: number; reason: string }[] = [],
    partial: number[] = [];
  let chunksRead = 0,
    examined = 0,
    unpriced = 0,
    bytes = 0;
  const minimum = request.min === undefined ? null : sizeAtoms(request.min),
    maximum = request.max === undefined ? null : sizeAtoms(request.max);
  const stopPage = page + batch.length;
  outer: for (; page < stopPage; page++, chunk = 0, rowOffset = 0) {
    const index = indexes.get(activityKey(revision, refs[page]).sk);
    if (!index) {
      gaps.push({
        timestamp: refs[page].timestamp,
        reason: "activity-not-indexed",
      });
      continue;
    }
    if (index.timestamp !== refs[page].timestamp)
      throw new Error("Activity timestamp mismatch");
    if (index.coverage !== "complete") partial.push(index.timestamp);
    if (chunk > index.chunks.length)
      throw new HistoryError(400, "invalid-query");
    for (; chunk < index.chunks.length; chunk++, rowOffset = 0) {
      const c = index.chunks[chunk];
      if (rowOffset > c.count) throw new HistoryError(400, "invalid-query");
      if (
        (request.type !== "all" && !c.types.includes(request.type)) ||
        (minimum !== null &&
          (c.max[request.currency] === null ||
            sizeAtoms(c.max[request.currency]!) < minimum))
      )
        continue;
      if (rowOffset === c.count) continue;
      if (chunksRead >= 8 || bytes + c.bytes > 1024 * 1024) break outer;
      const result = await db.send(
        new GetCommand({
          TableName: table,
          Key: activityChunkKey(revision, c.sha256),
          ConsistentRead: true,
        }),
        { abortSignal: signal() },
      );
      const body = result.Item?.body;
      if (
        typeof body !== "string" ||
        Buffer.byteLength(body) !== c.bytes ||
        digest(body) !== c.sha256
      )
        throw new Error("Activity chunk checksum mismatch");
      bytes += Buffer.byteLength(body);
      if (bytes > 1024 * 1024) throw new Error("Activity read budget exceeded");
      const events = JSON.parse(body) as ActivityRow[];
      if (!Array.isArray(events) || events.length !== c.count)
        throw new Error("Activity chunk count mismatch");
      chunksRead++;
      for (; rowOffset < events.length; rowOffset++) {
        const e = events[rowOffset];
        examined++;
        if (request.pool && e.poolId !== request.pool) continue;
        if (request.type !== "all" && e.type !== request.type) continue;
        const size = e.values[request.currency];
        if (size === null) {
          unpriced++;
          if (minimum !== null || maximum !== null) continue;
        } else if (
          (minimum !== null && sizeAtoms(size) < minimum) ||
          (maximum !== null && sizeAtoms(size) > maximum)
        )
          continue;
        rows.push(e);
        if (rows.length >= request.limit) {
          rowOffset++;
          break outer;
        }
      }
    }
  }
  // Normalize an exhausted chunk/bucket without fetching it again on the next page.
  if (page < stopPage) {
    const index = indexes.get(activityKey(revision, refs[page]).sk);
    if (!index) throw new Error("Missing current activity index");
    if (
      chunk < index.chunks.length &&
      rowOffset === index.chunks[chunk].count
    ) {
      chunk++;
      rowOffset = 0;
    }
    if (chunk === index.chunks.length) {
      page++;
      chunk = 0;
      rowOffset = 0;
    }
  }
  const nextCursor =
    page < refs.length
      ? Buffer.from(
          JSON.stringify({
            version: ACTIVITY_VERSION,
            revision,
            generation: publication.generation,
            query,
            page,
            chunk,
            row: rowOffset,
          }),
        ).toString("base64url")
      : null;
  const response = {
    version: ACTIVITY_VERSION,
    currency: request.currency,
    from: request.from,
    to: request.to,
    filters: {
      type: request.type,
      pool: request.pool ?? null,
      min: request.min ?? null,
      max: request.max ?? null,
    },
    publicationId: publication.generation,
    publishedThroughTimestamp: publication.nextTimestamp,
    order: "chain-desc",
    valuationMethod: "bucket-end-spot",
    rows: rows.map((e) => ({
      id: e.id,
      poolId: e.poolId,
      type: e.type,
      eventName: e.eventName,
      timestamp: e.timestamp,
      blockNumber: e.blockNumber,
      transactionIndex: e.transactionIndex,
      logIndex: e.logIndex,
      transactionHash: e.transactionHash,
      fameAtoms: e.fameAtoms,
      fameDecimals: e.fameDecimals,
      quoteToken: e.quoteToken,
      quoteAtoms: e.quoteAtoms,
      quoteDecimals: e.quoteDecimals,
      size: e.values[request.currency],
      sender: e.sender,
      recipient: e.recipient,
      owner: e.owner,
      valuationTimestamp: e.valuationTimestamp,
    })),
    nextCursor,
    coverage: {
      unavailableBuckets: gaps,
      partialBuckets: partial,
      outsidePublishedWindow: request.from < publication.startTimestamp,
      notYetPublished: request.to > publication.nextTimestamp,
    },
    scanned: {
      indexesRead: batch.length,
      chunks: chunksRead,
      events: examined,
      unpriced,
    },
    hasMore: nextCursor !== null,
  };
  if (Buffer.byteLength(JSON.stringify(response)) > 256 * 1024)
    throw new Error("Activity response too large");
  return response;
}
