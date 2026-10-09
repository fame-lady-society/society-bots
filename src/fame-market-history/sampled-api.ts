import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Scope } from "./model.ts";
import {
  sampledPolicy,
  sampledMarketBucket,
  type Currency,
} from "./sampled-market.ts";
import { HistoryError } from "./api.ts";
import { sampledReader } from "./sampled-reader.ts";
export function parseSampledRequest(raw: string, now = Date.now()) {
  const q = new URLSearchParams(raw),
    allowed = new Set(["view", "currency", "from", "to", "resolution"]);
  for (const key of q.keys())
    if (!allowed.has(key) || q.getAll(key).length !== 1)
      throw new HistoryError(400, "invalid-query");
  const currency = q.get("currency"),
    from = Number(q.get("from")),
    to = Number(q.get("to"));
  if (
    q.get("view") !== "sampled-market" ||
    q.get("resolution") !== "300" ||
    (currency !== "ETH" && currency !== "USDC") ||
    !["from", "to"].every((k) => /^(0|[1-9][0-9]*)$/.test(q.get(k) ?? "")) ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from % 300 ||
    to % 300 ||
    to <= from ||
    to - from > 86400 ||
    to > Math.floor(now / 300000) * 300
  )
    throw new HistoryError(400, "invalid-query");
  return { currency: currency as Currency, from, to };
}
export async function readSampledMarket(
  db: DynamoDBDocumentClient,
  table: string,
  scope: Scope,
  request: ReturnType<typeof parseSampledRequest>,
  now = Date.now,
) {
  const reader = sampledReader(db, table, sampledPolicy(scope).revision, now);
  const p = await reader.window(request.from, request.to);
  const generation = p.generation;
  const buckets = await reader.pages(
    p.pages.filter(
      (r) => r.timestamp >= request.from && r.timestamp < request.to,
    ),
    request.currency,
  );
  const response = {
    version: "fame-market-api-v2",
    ...request,
    resolution: 300,
    publicationId: generation,
    publishedThroughTimestamp: p.nextTimestamp,
    buckets: Array.from(
      { length: (request.to - request.from) / 300 },
      (_, i) => {
        const timestamp = request.from + i * 300;
        const published = buckets.get(timestamp);
        if (!published && p.pages.some((r) => r.timestamp === timestamp))
          throw new Error("Missing published sampled bucket");
        return {
          ...(published ??
            sampledMarketBucket(scope, request.currency, timestamp, null, [])),
          publicationStatus: published
            ? "published"
            : timestamp < p.nextTimestamp
              ? "outside-published-window"
              : "not-yet-published",
        };
      },
    ),
  };
  if (Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024)
    throw new Error("Sampled response too large");
  return response;
}
