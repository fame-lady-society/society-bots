import {
  validateSources,
  type WindowSource,
  type ReadPublication,
} from "./dated-publication.ts";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HistoryError } from "./api.ts";
import type { Scope } from "./model.ts";
import { sampledPolicy, type Currency } from "./sampled-market.ts";
import { parseSampledRequest } from "./sampled-api.ts";
import { sampledReader } from "./sampled-reader.ts";
import {
  validateSampledPublication,
  type SampledPublication,
  type SampledBucket,
} from "./sampled-live.ts";

export interface ChartRequest {
  currency: Currency;
  series: string;
  from: number;
  to: number;
  cursor?: string;
}
interface Cursor {
  sources?: WindowSource[];
  v: 1;
  revision: string;
  generation: string;
  currency: Currency;
  series: string;
  from: number;
  to: number;
}
const reset = (): never => {
  throw new HistoryError(409, "cursor-reset-required");
};
const encode = (c: Cursor) =>
  Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string): Cursor {
  if (raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new HistoryError(400, "invalid-query");
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (c.v !== 1) return reset();
    if (c.sources !== undefined) validateSources(c.sources);
    if (
      !/^[a-f0-9]{64}$/.test(c.revision) ||
      !/^[a-f0-9]{64}$/.test(c.generation) ||
      !["ETH", "USDC"].includes(c.currency) ||
      typeof c.series !== "string" ||
      !/^[a-z0-9-]{1,100}$/.test(c.series) ||
      ![c.from, c.to].every(
        (n) => Number.isSafeInteger(n) && n >= 0 && n % 300 === 0,
      ) ||
      c.to <= c.from ||
      c.to - c.from > 86400
    )
      throw new Error();
    return c;
  } catch (e) {
    if (e instanceof HistoryError) throw e;
    throw new HistoryError(400, "invalid-query");
  }
}
export function parseChartRequest(
  raw: string,
  scope: Scope,
  now = Date.now(),
): ChartRequest {
  const q = new URLSearchParams(raw);
  for (const k of q.keys())
    if (
      ![
        "view",
        "currency",
        "series",
        "from",
        "to",
        "resolution",
        "cursor",
      ].includes(k) ||
      q.getAll(k).length !== 1
    )
      throw new HistoryError(400, "invalid-query");
  if (q.get("view") !== "chart") throw new HistoryError(400, "invalid-query");
  const series = q.get("series") ?? "market",
    cursor = q.get("cursor") ?? undefined;
  if (series !== "market" && !scope.pools.some((p) => p.id === series))
    throw new HistoryError(400, "invalid-query");
  if (cursor !== undefined) decode(cursor);
  q.delete("series");
  q.delete("cursor");
  q.set("view", "sampled-market");
  return {
    ...parseSampledRequest(q.toString(), now),
    series,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}
export function projectChartBucket(b: SampledBucket, series: string) {
  const p =
    series === "market" ? null : b.series.find((p) => p.poolId === series);
  if (series !== "market" && !p) throw new Error("Missing chart pool");
  return {
    timestamp: b.timestamp,
    publicationStatus: "published" as
      | "published"
      | "not-yet-published"
      | "outside-published-window",
    price: p ? p.price : b.market.price,
    candle: p ? p.candle : b.market.candle,
    volume: p ? p.volume : b.totals.volume.value,
    inventory: p ? p.inventory : b.totals.inventory.value,
    volumeStatus: p
      ? p.volume === null
        ? "unavailable"
        : p.eventCoverage === "complete"
          ? "complete"
          : "partial"
      : b.totals.volume.status,
    inventoryStatus: p
      ? p.inventory === null
        ? "unavailable"
        : "complete"
      : b.totals.inventory.status,
    tradeCount: p ? p.tradeCount : b.totals.tradeCount,
    eventCoverage: p ? p.eventCoverage : b.totals.eventCoverage,
    ...(p ? { marketVolume: b.totals.volume } : {}),
  };
}
export type ChartBucket = ReturnType<typeof projectChartBucket>;
function gap(
  timestamp: number,
  status: "not-yet-published" | "outside-published-window",
  series: string,
): ChartBucket {
  return {
    timestamp,
    publicationStatus: status,
    price: null,
    candle: null,
    volume: null,
    inventory: null,
    volumeStatus: "unavailable",
    inventoryStatus: "unavailable",
    tradeCount: null,
    eventCoverage: "missing",
    ...(series !== "market"
      ? { marketVolume: { status: "unavailable" as const, value: null } }
      : {}),
  };
}
const state = (p: ReadPublication, t: number) =>
  p.pages.some((r) => r.timestamp === t)
    ? "published"
    : t < p.startTimestamp
      ? "outside-published-window"
      : t >= p.nextTimestamp
        ? "not-yet-published"
        : "outside-published-window";
export async function readChart(
  db: DynamoDBDocumentClient,
  table: string,
  scope: Scope,
  request: ChartRequest,
  now = Date.now,
  pinned?: ReadPublication,
) {
  const revision = sampledPolicy(scope).revision,
    reader = sampledReader(db, table, revision, now);
  const c = request.cursor ? decode(request.cursor) : null;
  if (
    c &&
    (c.revision !== revision ||
      c.currency !== request.currency ||
      c.series !== request.series ||
      c.to - c.from !== request.to - request.from ||
      request.from < c.from ||
      request.from >= c.to)
  )
    reset();
  const current = pinned ?? (await reader.window(request.from, request.to));
  let base: ReadPublication | null = null;
  if (c) {
    if (c.generation === current.generation) base = current;
    else if (c.sources) {
      base = await reader.window(c.from, c.to, c.sources);
      if (base.generation !== c.generation)
        throw new Error("Historical chart manifest mismatch");
    } else {
      const stored = await reader.get(`manifest:${c.generation}`);
      if (!stored) reset();
      if (
        !Number.isSafeInteger(stored!.expiresAt) ||
        typeof stored!.body !== "string"
      )
        throw new Error("Invalid retained manifest");
      if (stored!.expiresAt <= Math.floor(now() / 1000)) reset();
      base = validateSampledPublication(JSON.parse(stored!.body), revision);
      if (base.generation !== c.generation)
        throw new Error("Retained manifest identity mismatch");
    }
  }
  const oldRefs = new Map(
    base?.pages.map((p) => [p.timestamp, p[request.currency]]) ?? [],
  );
  const refs = new Map(current.pages.map((p) => [p.timestamp, p]));
  const changed: number[] = [];
  for (let t = request.from; t < request.to; t += 300) {
    if (
      !base ||
      !c ||
      t < c.from ||
      t >= c.to ||
      state(base, t) !== state(current, t) ||
      oldRefs.get(t) !== refs.get(t)?.[request.currency]
    )
      changed.push(t);
  }
  const pages = await reader.pages(
    changed.flatMap((t) => (refs.has(t) ? [refs.get(t)!] : [])),
    request.currency,
  );
  const upserts = changed.map((t) => {
    const b = pages.get(t);
    if (b) return projectChartBucket(b, request.series);
    const s = state(current, t);
    if (s === "published") throw new Error("Missing published chart page");
    return gap(t, s, request.series);
  });
  const cursor = encode({
    v: 1,
    revision,
    generation: current.generation,
    ...("sources" in current ? { sources: current.sources } : {}),
    currency: request.currency,
    series: request.series,
    from: request.from,
    to: request.to,
  });
  const response = {
    version: "fame-chart-v1" as const,
    mode: c ? ("delta" as const) : ("snapshot" as const),
    baseCursor: request.cursor ?? null,
    cursor,
    currency: request.currency,
    series: request.series,
    from: request.from,
    to: request.to,
    resolution: 300,
    policyRevision: revision,
    publicationId: current.generation,
    publishedThroughTimestamp: current.nextTimestamp,
    priceMethod:
      request.series === "market"
        ? "fame-balance-weighted-spot-v1"
        : "bucket-end-spot",
    candleMethod: "spot-events-at-bucket-end-rate",
    conversionMethod: "bucket-end-spot",
    pools: scope.pools.map((p) => p.id),
    upserts,
    removedTimestamps: [] as number[],
  };
  if (Buffer.byteLength(JSON.stringify(response)) > 150 * 1024)
    throw new Error("Chart response exceeds budget");
  return response;
}
