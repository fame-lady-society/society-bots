import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { candidateStore } from "./candidate-storage.ts";
import {
  advanceCandidate,
  prepareCandidate,
  candidateSpec,
  type CandidateBounds,
} from "./candidate.ts";
import { launchScope } from "./local-backfill.ts";
import { boundedTransport, chainReader, type RpcMetrics } from "./rpc.ts";
import { awsArchive } from "./storage.ts";
import { awsSampled } from "./sampled-storage.ts";
import { sampledReader } from "./sampled-rpc.ts";
import { awsAggregation } from "./worker-storage.ts";
import { aggregateNext } from "./worker.ts";
import type { TokenMetadata } from "./decode.ts";
import { activeDataset } from "./dataset.ts";
import { failureCode } from "./failure.ts";

export async function handler(
  _event: unknown,
  context: { getRemainingTimeInMillis(): number },
) {
  const table = process.env.FAME_CANDIDATE_TABLE,
    bucket = process.env.FAME_CANDIDATE_BUCKET,
    parameter = process.env.FAME_HISTORY_RPC_PARAMETER;
  if (!table || !bucket || !parameter)
    throw new Error("Missing candidate configuration");
  const db = DynamoDBDocumentClient.from(
      new DynamoDBClient({ maxAttempts: 2 }),
    ),
    s3 = new S3Client({ maxAttempts: 2 });
  const store = candidateStore(db, table),
    owner = randomUUID(),
    job = await store.acquire(owner);
  if (!job) return { phase: "idle" }; // No SSM or RPC access before explicit start, after pause/completion, or while leased.
  let metrics: RpcMetrics = { requests: 0, responseBytes: 0, methods: {} };
  let result: Record<string, unknown> = { phase: "failed" };
  try {
    const secret = await new SSMClient({ maxAttempts: 2 }).send(
      new GetParameterCommand({ Name: parameter, WithDecryption: true }),
    );
    if (!secret.Parameter?.Value) throw new Error("Missing RPC secret");
    let lastRequest = 0;
    const rpc = boundedTransport({
      url: secret.Parameter.Value,
      maxRequests: 2000,
      maxResponseBytes: 8 * 1024 * 1024,
      maxTotalResponseBytes: 64 * 1024 * 1024,
      deadline:
        Date.now() +
        Math.min(240_000, context.getRemainingTimeInMillis() - 30000),
      fetcher: async (input, init) => {
        const delay = 100 - (Date.now() - lastRequest);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        lastRequest = Date.now();
        return fetch(input, init);
      },
    });
    metrics = rpc.metrics;
    const scope = launchScope(),
      chain = chainReader(scope, rpc.transport, 5000, rpc.capacity);
    const bounds: CandidateBounds =
      job.bounds ?? (await prepareCandidate(chain));
    if (!job.bounds) {
      const metadata: TokenMetadata = JSON.parse(
        await readFile(
          new URL("./token-metadata.json", import.meta.url),
          "utf8",
        ),
      );
      metadata.blockNumber = bounds.launch.number;
      metadata.blockHash = bounds.launch.hash;
      await store.initialize(owner, bounds, metadata);
    }
    const selected = await activeDataset(table, db);
    if (selected.scope.id !== scope.id)
      throw new Error("Candidate active scope changed");
    const metadata = selected.metadata;
    const canWork = () => context.getRemainingTimeInMillis() > 40000;
    const archive = awsArchive({ table, bucket, db, s3 });
    const sampled = awsSampled({
      scope,
      table,
      bucket,
      metadata,
      db,
      s3,
      canContinue: canWork,
    });
    const aggregation = awsAggregation({ table, bucket, db, s3 });
    result = await advanceCandidate({
      bounds,
      chain,
      archive,
      sampled,
      sample: sampledReader(scope, rpc.transport),
      aggregationNext: store.aggregationNext,
      aggregate: () =>
        aggregateNext({
          scope,
          startBlock: candidateSpec().startBlock,
          metadata,
          store: aggregation,
        }),
      canContinue: async () =>
        canWork() &&
        rpc.capacity.remainingRequests() > 8 &&
        (await store.canContinue(owner)),
    });
  } catch (e) {
    const code = failureCode(e);
    result = { phase: code === "work-limit" ? "yielded" : "failed", code };
  } finally {
    // Counters are observed usage, not a spending gate or provider billing units.
    console.log(
      JSON.stringify({
        event: "candidate-backfill",
        runId: owner,
        ...result,
        metrics,
      }),
    );
    await store.finish(owner, result, metrics);
  }
  if (result.phase === "failed")
    throw new Error(
      "Candidate backfill failed; checkpoints retained; inspect fixed-code logs",
    );
  return { ...result, metrics };
}
