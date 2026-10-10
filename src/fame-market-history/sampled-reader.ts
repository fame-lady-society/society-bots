import {
  utcDay,
  validateDay,
  validateSources,
  type ReadPublication,
  type WindowSource,
  type WindowPublication,
} from "./dated-publication.ts";
import {
  BatchGetCommand,
  QueryCommand,
  GetCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { HistoryError } from "./api.ts";
import { digest } from "./model.ts";
import { sampledKey, sampledPageKey } from "./keys.ts";
import {
  validateSampledPublication,
  type SampledPublication,
  type SampledPageRef,
  type SampledBucket,
} from "./sampled-live.ts";
import type { Currency } from "./sampled-market.ts";

/** One request budget, including SDK retries and backoff. Immutable pages pin the snapshot. */
export function sampledReader(
  db: DynamoDBDocumentClient,
  table: string,
  revision: string,
  now = Date.now,
) {
  const deadline = now() + 6500;
  const signal = () => {
    const remaining = deadline - now();
    if (remaining <= 0)
      throw new HistoryError(503, "history-read-budget-exceeded");
    return AbortSignal.timeout(remaining);
  };
  const get = async (sk: string) =>
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: sampledKey(revision, sk),
          ConsistentRead: true,
        }),
        { abortSignal: signal() },
      )
    ).Item;
  const publication = async () => {
    const item = await get("published");
    if (!item) throw new HistoryError(503, "sampled-history-not-ready");
    const { pk: _, sk: __, ...p } = item;
    return validateSampledPublication(p as SampledPublication, revision);
  };
  const window = async (
    from: number,
    to: number,
    sources?: WindowSource[],
  ): Promise<ReadPublication> => {
    if (
      ![from, to].every(
        (n) => Number.isSafeInteger(n) && n >= 0 && n % 300 === 0,
      ) ||
      to <= from ||
      to - from > 86400
    )
      throw new Error("Invalid history window");
    const dayKeys = [...new Set([utcDay(from), utcDay(to - 1)])].map(
      (d) => `day:${d}`,
    );
    if (sources) {
      validateSources(sources);
      if (
        JSON.stringify(sources.map((s) => s.key)) !==
        JSON.stringify([
          ...dayKeys,
          ...(sources.some((s) => s.key === "published") ? ["published"] : []),
        ])
      )
        throw new HistoryError(400, "invalid-query");
    }
    const liveRow = sources ? null : await get("published");
    if (!sources && !liveRow)
      throw new HistoryError(503, "sampled-history-not-ready");
    const live = liveRow
      ? validateSampledPublication(liveRow as SampledPublication, revision)
      : null;
    if (live && from >= live.startTimestamp) return live;
    let horizon = live?.nextTimestamp ?? to;
    const selected: WindowSource[] = [];
    const refs = new Map<number, SampledPageRef>();
    const keys = sources?.map((s) => s.key) ?? [
      ...dayKeys,
      ...(live && to > live.startTimestamp ? ["published"] : []),
    ];
    for (const key of keys) {
      const pinned = sources?.find((s) => s.key === key);
      if (pinned?.generation === null) {
        selected.push(pinned);
        continue;
      }
      let current: ReadPublication | ReturnType<typeof validateDay> | null;
      if (key === "published") {
        const row = live ?? (await get(key));
        current = row
          ? validateSampledPublication(row as SampledPublication, revision)
          : null;
      } else {
        const row = await get(key);
        current = row
          ? validateDay(JSON.parse(row.body), revision, Number(key.slice(4)))
          : null;
      }
      if (pinned && current?.generation !== pinned.generation) {
        const row = await get(
          `${key === "published" ? "manifest" : "day-manifest"}:${pinned.generation}`,
        );
        if (
          !row ||
          !Number.isSafeInteger(row.expiresAt) ||
          row.expiresAt <= Math.floor(now() / 1000)
        )
          throw new HistoryError(409, "cursor-reset-required");
        current =
          key === "published"
            ? validateSampledPublication(JSON.parse(row.body), revision)
            : validateDay(JSON.parse(row.body), revision, Number(key.slice(4)));
        if (current.generation !== pinned.generation)
          throw new Error("Historical manifest identity mismatch");
      }
      if (key === "published" && current && "nextTimestamp" in current)
        horizon = current.nextTimestamp;
      selected.push({ key, generation: current?.generation ?? null });
      for (const ref of current?.pages ?? [])
        if (ref.timestamp >= from && ref.timestamp < to)
          refs.set(ref.timestamp, ref);
    }
    const pages = [...refs.values()].sort((a, b) => a.timestamp - b.timestamp);
    const body = {
      version: "fame-history-window-v1" as const,
      policyRevision: revision,
      startTimestamp: from,
      nextTimestamp: Math.min(to, horizon),
      pages,
    };
    return {
      ...body,
      generation: digest(JSON.stringify({ ...body, from, to })),
      sources: selected,
    } satisfies WindowPublication;
  };
  const pages = async (refs: SampledPageRef[], currency: Currency) => {
    if (refs.length > 288) throw new Error("Too many sampled pages");
    const result = new Map<number, SampledBucket>();
    let bytes = 0;
    const parts = Array.from({ length: Math.ceil(refs.length / 100) }, (_, i) =>
      refs.slice(i * 100, i * 100 + 100),
    );
    await Promise.all(
      parts.map(async (part) => {
        let keys = part.map((r) =>
          sampledPageKey(revision, currency, r.timestamp, r[currency]),
        );
        const expected = new Map(
          keys.map((k, i) => [JSON.stringify([k.pk, k.sk]), part[i]]),
        );
        for (let attempt = 0; keys.length; attempt++) {
          const response = await db.send(
            new BatchGetCommand({
              RequestItems: { [table]: { Keys: keys, ConsistentRead: true } },
            }),
            { abortSignal: signal() },
          );
          for (const row of response.Responses?.[table] ?? []) {
            const ref = expected.get(JSON.stringify([row.pk, row.sk]));
            if (!ref || result.has(ref.timestamp))
              throw new Error("Unexpected sampled page");
            if (
              typeof row.body !== "string" ||
              digest(row.body) !== ref[currency]
            )
              throw new Error("Sampled page checksum mismatch");
            bytes += Buffer.byteLength(row.body);
            if (bytes > 2 * 1024 * 1024)
              throw new Error("Sampled response too large");
            const bucket = JSON.parse(row.body) as SampledBucket;
            if (
              bucket.currency !== currency ||
              bucket.timestamp !== ref.timestamp ||
              bucket.policyRevision !== revision ||
              bucket.version !== "fame-market-api-v2"
            )
              throw new Error("Sampled page identity mismatch");
            result.set(ref.timestamp, bucket);
          }
          const pending = response.UnprocessedKeys?.[table]?.Keys ?? [];
          keys = pending.map((k) => {
            const ref = expected.get(JSON.stringify([k.pk, k.sk]));
            if (!ref || result.has(ref.timestamp))
              throw new Error("Invalid unprocessed sampled key");
            return sampledPageKey(
              revision,
              currency,
              ref.timestamp,
              ref[currency],
            );
          });
          if (keys.length) {
            if (attempt >= 3)
              throw new HistoryError(503, "history-read-budget-exceeded");
            signal();
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.floor((25 + Math.random() * 25) * 2 ** attempt),
              ),
            );
          }
        }
        if (part.some((r) => !result.has(r.timestamp)))
          throw new Error("Missing sampled page");
      }),
    );
    return result;
  };
  const availability = async (before?: number) => {
    const live = await publication();
    const result = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": sampledKey(revision, "").pk,
          ":prefix": "day:",
        },
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: 1,
      }),
      { abortSignal: signal() },
    );
    const row = result.Items?.[0];
    let earliest = live.startTimestamp;
    if (row) {
      if (typeof row.sk !== "string" || !/^day:[0-9]{10}$/.test(row.sk))
        throw new Error("Invalid dated availability key");
      const day = validateDay(
        JSON.parse(row.body),
        revision,
        Number(row.sk.slice(4)),
      );
      earliest = Math.min(earliest, day.pages[0].timestamp);
    }
    return {
      version: "fame-history-availability-v1",
      policyRevision: revision,
      earliestAvailableTimestamp: earliest,
      latestAvailableTimestamp: live.nextTimestamp - 300,
      resolution: 300,
      maxWindowSeconds: 86400,
      ...(before !== undefined
        ? { before, hasEarlier: earliest < before }
        : {}),
    };
  };
  return { get, publication, window, pages, availability };
}
