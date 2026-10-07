import {
  referencePolicy,
  referenceProgress,
  referenceProgressKey,
} from "./reference.ts";
import { readReferences, referenceAt } from "./reference-api.ts";
import {
  QueryCommand,
  TransactGetCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { activeScopeKey, candleKey, marketKey, progressKey } from "./keys.ts";
import type { Scope } from "./model.ts";
import type { TokenMetadata } from "./decode.ts";
import type { Candle } from "./analytics.ts";
import type { MarketCandle } from "./market.ts";
import type { ConvertedCandle, MarketLiquidity } from "./valuation.ts";
import {
  VALUATION_VERSION,
  ROUTES,
  ETH_USD_FEED,
  MAX_OBSERVATION_AGE,
} from "./valuation.ts";

export class HistoryError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export interface HistoryRequest {
  view: "market" | "pool";
  pool?: string;
  from: number;
  to: number;
  resolution: 300;
}
function fail(code: string): never {
  throw new HistoryError(503, code);
}
export function parseHistoryRequest(
  rawQuery: string,
  scope: Scope,
  now = Date.now(),
): HistoryRequest {
  const params = new URLSearchParams(rawQuery);
  const allowed = new Set(["view", "pool", "from", "to", "resolution"]);
  for (const key of params.keys())
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      throw new HistoryError(400, "invalid-query");
  const view = params.get("view");
  const pool = params.get("pool") ?? undefined;
  if (
    (view !== "market" && view !== "pool") ||
    (view === "market" && pool !== undefined) ||
    (view === "pool" && !scope.pools.some((p) => p.id === pool)) ||
    params.get("resolution") !== "300"
  )
    throw new HistoryError(400, "invalid-query");
  const number = (name: string) => {
    const text = params.get(name) ?? "";
    const value = Number(text);
    if (
      !/^(0|[1-9][0-9]*)$/.test(text) ||
      !Number.isSafeInteger(value) ||
      value % 300 !== 0
    )
      throw new HistoryError(400, "invalid-query");
    return value;
  };
  const from = number("from"),
    to = number("to");
  if (
    to <= from ||
    to - from > 288 * 300 ||
    to > (Math.floor(now / 300_000) + 1) * 300
  )
    throw new HistoryError(400, "invalid-query");
  return { view, ...(pool ? { pool } : {}), from, to, resolution: 300 };
}
type Item = Record<string, any>;
const natural = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const revision = (n: unknown): n is string =>
  typeof n === "string" && /^[0-9a-f]{64}$/.test(n);
const atoms = (n: unknown): n is string =>
  typeof n === "string" && /^(0|[1-9][0-9]*)$/.test(n);
const price = (n: unknown): n is string | null =>
  n === null || (typeof n === "string" && /^\d+\.\d{18}$/.test(n));
const coverage = (n: unknown) =>
  ["complete", "partial", "missing"].includes(n as string);
function candle(c: Item): Candle {
  if (
    !c ||
    !natural(c.timestamp) ||
    c.timestamp % 300 ||
    !coverage(c.coverage) ||
    !atoms(c.baseVolumeAtoms) ||
    !atoms(c.quoteVolumeAtoms) ||
    !natural(c.tradeCount) ||
    !natural(c.rejectedEvents) ||
    ![c.open, c.high, c.low, c.close].every(price) ||
    typeof c.poolId !== "string"
  )
    fail("history-integrity");
  return {
    poolId: c.poolId,
    timestamp: c.timestamp,
    coverage: c.coverage,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    baseVolumeAtoms: c.baseVolumeAtoms,
    quoteVolumeAtoms: c.quoteVolumeAtoms,
    tradeCount: c.tradeCount,
    rejectedEvents: c.rejectedEvents,
  };
}
/** Deliberate response allowlist: storage keys, leases and artifact references stay private. */
function market(
  c: Item,
  scope: Scope,
): MarketCandle & { includedPoolIds: string[]; missingPoolIds: string[] } {
  const expected = scope.pools.map((p) => p.id);
  if (
    !coverage(c.coverage) ||
    !atoms(c.baseVolumeAtoms) ||
    !natural(c.tradeCount) ||
    !natural(c.rejectedEvents) ||
    JSON.stringify(c.expectedPoolIds) !== JSON.stringify(expected) ||
    !Array.isArray(c.pools) ||
    c.pools.length !== expected.length ||
    !Array.isArray(c.quotes)
  )
    fail("history-integrity");
  const pools: Candle[] = c.pools.map(candle);
  if (pools.some((p) => p.timestamp !== c.timestamp)) fail("history-integrity");
  if (JSON.stringify(pools.map((p) => p.poolId)) !== JSON.stringify(expected))
    fail("history-integrity");
  return {
    timestamp: c.timestamp,
    coverage: c.coverage,
    baseVolumeAtoms: c.baseVolumeAtoms,
    tradeCount: c.tradeCount,
    rejectedEvents: c.rejectedEvents,
    expectedPoolIds: expected,
    includedPoolIds: pools
      .filter((p) => p.coverage !== "missing")
      .map((p) => p.poolId),
    missingPoolIds: pools
      .filter((p) => p.coverage === "missing")
      .map((p) => p.poolId),
    pools,
    quotes: c.quotes.map((q: Item) => {
      const { poolId: _, ...row } = candle({ ...q, poolId: "quote" });
      if (
        typeof q.quoteToken !== "string" ||
        q.timestamp !== c.timestamp ||
        !natural(q.quoteDecimals) ||
        q.quoteDecimals > 36 ||
        !Array.isArray(q.poolIds) ||
        q.poolIds.some((id: unknown) => !expected.includes(id as string))
      )
        fail("history-integrity");
      return {
        ...row,
        quoteToken: q.quoteToken,
        quoteDecimals: q.quoteDecimals,
        poolIds: q.poolIds,
      };
    }),
    prices: converted(c.prices),
    liquidity: liquidity(c.liquidity, expected),
  };
}
function converted(rows: Item[]): ConvertedCandle[] {
  if (!Array.isArray(rows) || rows.length !== 2) fail("history-integrity");
  return rows.map((c, i) => {
    if (
      c.currency !== ["ETH", "USD"][i] ||
      !["complete", "partial", "unavailable"].includes(c.status) ||
      c.method !== "execution-price-with-asof-fx" ||
      ![c.open, c.high, c.low, c.close, c.volume, c.vwap].every(price) ||
      !atoms(c.pricedBaseVolumeAtoms) ||
      !atoms(c.unpricedBaseVolumeAtoms) ||
      !natural(c.pricedTradeCount) ||
      !natural(c.unpricedTradeCount) ||
      !Array.isArray(c.observationBlocks) ||
      !c.observationBlocks.every(natural)
    )
      fail("history-integrity");
    return {
      currency: c.currency,
      status: c.status,
      method: c.method,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      vwap: c.vwap,
      pricedBaseVolumeAtoms: c.pricedBaseVolumeAtoms,
      unpricedBaseVolumeAtoms: c.unpricedBaseVolumeAtoms,
      pricedTradeCount: c.pricedTradeCount,
      unpricedTradeCount: c.unpricedTradeCount,
      observationBlocks: c.observationBlocks,
    };
  });
}
function liquidity(c: Item, expected: string[]): MarketLiquidity {
  if (
    !c ||
    c.method !== "pool-custody-balances-at-pool-spot" ||
    !["complete", "partial", "unavailable"].includes(c.status) ||
    !price(c.eth) ||
    !price(c.usd) ||
    !Array.isArray(c.pools) ||
    JSON.stringify(c.pools.map((p: Item) => p.poolId)) !==
      JSON.stringify(expected)
  )
    fail("history-integrity");
  return {
    method: c.method,
    status: c.status,
    eth: c.eth,
    usd: c.usd,
    pools: c.pools.map((p: Item) => {
      if (
        !price(p.eth) ||
        !price(p.usd) ||
        !(p.timestamp === null || natural(p.timestamp)) ||
        !(p.blockNumber === null || natural(p.blockNumber))
      )
        fail("history-integrity");
      return {
        poolId: p.poolId,
        blockNumber: p.blockNumber,
        timestamp: p.timestamp,
        eth: p.eth,
        usd: p.usd,
      };
    }),
  };
}

export function historyReader({
  db,
  table,
  scope,
  metadata,
  metadataRevision,
}: {
  db: DynamoDBDocumentClient;
  table: string;
  scope: Scope;
  metadata: TokenMetadata;
  metadataRevision: string;
}) {
  const policy = referencePolicy(scope);
  const snapshot = async (
    collector: boolean,
    signal: AbortSignal,
    marketView = false,
  ) => {
    const keys = [activeScopeKey, progressKey(scope.id)];
    if (collector || marketView)
      keys.push({ pk: `scope:${scope.id}`, sk: "cursor" });
    if (marketView)
      keys.push(
        referenceProgressKey(scope.id, "published"),
        referenceProgressKey(scope.id, "collected"),
      );
    const result = await db.send(
      new TransactGetCommand({
        TransactItems: keys.map((Key) => ({ Get: { TableName: table, Key } })),
      }),
      { abortSignal: signal },
    );
    return (result.Responses ?? []).map((r) => r.Item);
  };
  const marker = (state: (Item | undefined)[]) =>
    JSON.stringify([
      state[0]?.scopeId,
      state[3]?.startTimestamp,
      state[3]?.nextTimestamp,
      state[3]?.policyRevision,
      state[4]?.startTimestamp,
      state[4]?.policyRevision,
      ...[
        "nextBlock",
        "sourceRevision",
        "metadataRevision",
        "firstPublishedBucket",
        "coverageFromTimestamp",
        "publishedThroughTimestamp",
        "publishedAt",
      ].map((k) => state[1]?.[k]),
    ]);
  return async (request: HistoryRequest) => {
    const signal = AbortSignal.timeout(7000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = await snapshot(true, signal, request.view === "market"),
        [active, progress, collector] = before;
      if (!active || !progress?.sourceRevision) fail("history-not-ready");
      if (
        active.scopeId !== scope.id ||
        progress.metadataRevision !== metadataRevision
      )
        fail("history-version-mismatch");
      if (
        !collector ||
        !natural(collector.nextBlock) ||
        !natural(progress.nextBlock) ||
        progress.nextBlock > collector.nextBlock ||
        !revision(progress.sourceRevision) ||
        !natural(progress.firstPublishedBucket) ||
        progress.firstPublishedBucket % 300 ||
        !natural(progress.coverageFromTimestamp) ||
        !natural(progress.publishedThroughTimestamp) ||
        !natural(progress.publishedAt)
      )
        fail("history-integrity");
      const references =
        request.view === "market"
          ? referenceProgress(before[3], policy.revision)
          : undefined;
      const referenceCollection =
        request.view === "market"
          ? referenceProgress(before[4], policy.revision)
          : undefined;
      if (
        references &&
        (!referenceCollection ||
          references.startTimestamp !== referenceCollection.startTimestamp ||
          references.nextTimestamp > referenceCollection.nextTimestamp)
      )
        fail("history-integrity");
      const referenceRows =
        request.view === "market"
          ? await readReferences(
              db,
              table,
              scope.id,
              references,
              request.from,
              request.to,
              signal,
            )
          : new Map();
      const key =
        request.view === "market"
          ? marketKey(scope.id, request.from)
          : candleKey(scope.id, request.pool!, request.from);
      const rows: Item[] = [];
      let cursor: Record<string, any> | undefined;
      for (let page = 0; page < 2; page++) {
        const result = await db.send(
          new QueryCommand({
            TableName: table,
            ConsistentRead: true,
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
            ExpressionAttributeValues: {
              ":pk": key.pk,
              ":from": key.sk,
              ":to": String(request.to - 300).padStart(16, "0"),
            },
            Limit: 288 - rows.length,
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
          { abortSignal: signal },
        );
        rows.push(...(result.Items ?? []));
        cursor = result.LastEvaluatedKey;
        if (!cursor || rows.length >= 288) break;
      }
      const after = await snapshot(false, signal, request.view === "market");
      if (marker(before) !== marker(after)) continue;
      if (cursor || rows.length > 288) fail("history-read-limit");
      const map = new Map<number, Item>();
      for (const row of rows) {
        if (
          !natural(row.timestamp) ||
          row.timestamp % 300 ||
          row.timestamp < request.from ||
          row.timestamp >= request.to ||
          row.sk !== String(row.timestamp).padStart(16, "0") ||
          row.pk !== key.pk ||
          map.has(row.timestamp) ||
          !natural(row.throughBlock) ||
          row.throughBlock >= progress.nextBlock ||
          row.metadataRevision !== metadataRevision ||
          !revision(row.sourceRevision)
        )
          fail("history-integrity");
        map.set(row.timestamp, row);
      }
      const buckets = [];
      for (
        let timestamp = request.from;
        timestamp < request.to;
        timestamp += 300
      ) {
        const row = map.get(timestamp);
        if (row) {
          if (
            timestamp < progress.firstPublishedBucket ||
            timestamp >
              Math.floor(progress.publishedThroughTimestamp / 300) * 300
          )
            fail("history-integrity");
          if (request.view === "pool" && row.poolId !== request.pool)
            fail("history-integrity");
          buckets.push(
            request.view === "market" ? market(row, scope) : candle(row),
          );
        } else {
          if (
            timestamp >= progress.firstPublishedBucket &&
            timestamp <=
              Math.floor(progress.publishedThroughTimestamp / 300) * 300
          )
            fail("history-integrity");
          buckets.push({
            timestamp,
            coverage: "missing",
            reason:
              timestamp < progress.firstPublishedBucket
                ? "before-history-start"
                : "not-yet-published",
            open: null,
            high: null,
            low: null,
            close: null,
            baseVolumeAtoms: null,
            quoteVolumeAtoms: null,
            tradeCount: null,
          });
        }
      }
      const response = {
        schema: "fame-history-api-v1",
        ...request,
        chainId: 8453,
        scopeId: scope.id,
        semantics: {
          volume: "gross-pool-executions",
          decoderReview: metadata.decoderReview,
          priceDecimals: 18,
          rounding: "floor",
        },
        valuation: {
          version: VALUATION_VERSION,
          ethUsdFeed: ETH_USD_FEED,
          maxObservationAgeSeconds: MAX_OBSERVATION_AGE,
          routes: ROUTES,
          connectorPrice: "observed-pool-spot",
          liquidityMark: "each-pool-spot",
          sources: scope.registry.pools
            .filter((p) => Object.values(ROUTES).flat().includes(p.id))
            .map((p) => ({
              id: p.id,
              token0: p.token0,
              token1: p.token1,
              poolAddress: p.poolAddress,
              poolKey: p.poolKey,
              stateViewAddress: p.stateViewAddress,
            })),
        },
        pools: scope.pools.map((p) => ({
          id: p.id,
          address: p.address,
          token0: p.token0,
          token1: p.token1,
        })),
        decimals: metadata.decimals,
        progress: {
          sourceRevision: progress.sourceRevision,
          coverageFromTimestamp: progress.coverageFromTimestamp,
          publishedThroughTimestamp: progress.publishedThroughTimestamp,
          publishedThroughBlock: progress.nextBlock - 1,
          collectedThroughBlock: collector.nextBlock - 1,
          publishedAt: progress.publishedAt,
        },
        ...(request.view === "market"
          ? {
              referencePolicy: policy,
              referenceProgress: referenceCollection
                ? {
                    startTimestamp: referenceCollection.startTimestamp,
                    publishedThroughTimestamp: references
                      ? references.nextTimestamp - 1
                      : null,
                    revision: references?.nextTimestamp ?? null,
                  }
                : null,
            }
          : {}),
        buckets:
          request.view === "market"
            ? buckets.map((b) => ({
                ...b,
                reference: referenceAt(
                  b.timestamp,
                  references,
                  referenceRows,
                  referenceCollection?.startTimestamp,
                ),
              }))
            : buckets,
      };
      if (Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024)
        fail("history-read-limit");
      return response;
    }
    return fail("history-updating");
  };
}
