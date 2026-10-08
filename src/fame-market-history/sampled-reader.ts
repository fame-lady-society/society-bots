import {
  BatchGetCommand,
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
  return { get, publication, pages };
}
