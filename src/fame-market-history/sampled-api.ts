import {
  TransactGetCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { digest, type Scope } from "./model.ts";
import {
  sampledPolicy,
  sampledMarketBucket,
  type Currency,
} from "./sampled-market.ts";
import { sampledKey, sampledPageKey } from "./keys.ts";
import {
  validateSampledPublication,
  type SampledPublication,
  type SampledBucket,
} from "./sampled-live.ts";
import { HistoryError } from "./api.ts";
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
  const started = now(),
    revision = sampledPolicy(scope).revision;
  const get = async (keys: Record<string, string>[]) => {
    if (now() - started > 6500)
      throw new HistoryError(503, "history-read-budget-exceeded");
    const result = await db.send(
      new TransactGetCommand({
        TransactItems: keys.map((Key) => ({ Get: { TableName: table, Key } })),
      }),
    );
    return result.Responses?.map((r) => r.Item) ?? [];
  };
  const item = (await get([sampledKey(revision, "published")]))[0];
  if (!item) throw new HistoryError(503, "sampled-history-not-ready");
  const { pk: _, sk: __, ...value } = item;
  const p = validateSampledPublication(
    value as unknown as SampledPublication,
    revision,
  );
  const generation = p.generation;
  const refs = p.pages.filter(
      (r) => r.timestamp >= request.from && r.timestamp < request.to,
    ),
    buckets: SampledBucket[] = [];
  let bytes = 0;
  for (let i = 0; i < refs.length; i += 64) {
    const part = refs.slice(i, i + 64);
    const rows = await get(
      part.map((r) =>
        sampledPageKey(
          revision,
          request.currency,
          r.timestamp,
          r[request.currency],
        ),
      ),
    );
    if (rows.length !== part.length) throw new Error("Missing sampled page");
    rows.forEach((row, j) => {
      if (
        typeof row?.body !== "string" ||
        digest(row.body) !== part[j][request.currency]
      )
        throw new Error("Sampled page checksum mismatch");
      bytes += Buffer.byteLength(row.body);
      if (bytes > 2 * 1024 * 1024)
        throw new Error("Sampled response too large");
      const bucket = JSON.parse(row.body) as SampledBucket;
      if (
        bucket.currency !== request.currency ||
        bucket.timestamp !== part[j].timestamp ||
        bucket.policyRevision !== revision ||
        bucket.version !== "fame-market-api-v2"
      )
        throw new Error("Sampled page identity mismatch");
      buckets.push(bucket);
    });
  }
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
        const published = buckets.find((b) => b.timestamp === timestamp);
        if (
          !published &&
          timestamp >= p.startTimestamp &&
          timestamp < p.nextTimestamp
        )
          throw new Error("Missing published sampled bucket");
        return {
          ...(published ??
            sampledMarketBucket(scope, request.currency, timestamp, null, [])),
          publicationStatus: published
            ? "published"
            : timestamp < p.startTimestamp
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
