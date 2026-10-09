import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import type { Scope } from "./model.ts";
import type { TokenMetadata } from "./decode.ts";
import { sampledKey } from "./keys.ts";
import { awsSampled } from "./sampled-storage.ts";
import { sampledMarketBucket, sampledPolicy } from "./sampled-market.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";

/** Rebuild bounded serving pages from retained evidence, never from fresh RPC.
 * Missing observations remain gaps; corruption and storage failures stop the run.
 * Each bucket commits independently and can be retried after interruption. */
export async function materializeHistory(options: {
  scope: Scope;
  metadata: TokenMetadata;
  db: DynamoDBDocumentClient;
  s3?: S3Client;
  table: string;
  bucket: string;
  from: number;
  to: number;
  apply: boolean;
  progress?: (row: { timestamp: number; status: string }) => void;
}) {
  const { scope, db, table, from, to, apply } = options;
  if (
    ![from, to].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n % 300 === 0,
    ) ||
    to <= from ||
    to - from > 86400
  )
    throw new Error("Expected aligned historical range of at most 24 hours");
  const revision = sampledPolicy(scope).revision;
  let store = awsSampled(options);
  const live = await store.publication();
  if (!live || to > live.startTimestamp)
    throw new Error("Range overlaps live publication");
  const rows: { timestamp: number; status: string }[] = [];
  for (let timestamp = from; timestamp < to; timestamp += 300) {
    // Keep archive caches bounded even for a full day.
    if ((timestamp - from) % (16 * 300) === 0) store = awsSampled(options);
    const manifest = await db.send(
      new GetCommand({
        TableName: table,
        Key: sampledKey(revision, `observation:${timestamp}`),
        ConsistentRead: true,
      }),
    );
    let status: string;
    if (!manifest.Item) status = "missing-observation";
    else {
      const evidence = await store.read(timestamp),
        native = await store.activity(evidence);
      if (!native) status = "archive-not-ready";
      else {
        const previous = await store.previous(timestamp);
        const observation = deriveSampledObservation(scope, evidence);
        const buckets = (["ETH", "USDC"] as const).map((currency) =>
          sampledMarketBucket(
            scope,
            currency,
            timestamp,
            observation,
            native,
            previous ? deriveSampledObservation(scope, previous) : null,
          ),
        );
        if (apply) await store.publishHistorical(evidence, buckets);
        status = apply ? "published" : "ready";
      }
    }
    const row = { timestamp, status };
    rows.push(row);
    options.progress?.(row);
  }
  return { revision, from, to, apply, rows, rpcCalls: 0, liveCursorWrites: 0 };
}
