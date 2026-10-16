import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { candidateStore } from "./candidate-storage.ts";
import {
  advanceCandidate,
  prepareCandidate,
  candidateSpec,
  candidateAdmission,
  candidatePrevious,
  fullCandidate,
  candidateScope,
  type CandidateBounds,
} from "./candidate.ts";
import { candidateRun } from "./candidate-run.ts";
import { fullMetadata } from "./full-scope.ts";
import { boundedTransport, chainReader, type RpcMetrics } from "./rpc.ts";
import { awsArchive } from "./storage.ts";
import { awsSampled } from "./sampled-storage.ts";
import { sampledReader } from "./sampled-rpc.ts";
import { awsAggregation } from "./worker-storage.ts";
import { aggregateNext } from "./worker.ts";
import type { TokenMetadata } from "./decode.ts";
import { octoberMetadata } from "./october-scope.ts";
import { reusePreAdmissionSample } from "./admission-opening.ts";
import { activeDataset, decodeDataset, datasetKey } from "./dataset.ts";
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
  const owner = randomUUID();
  const chunk = await candidateRun(db, table).select();
  if (!chunk) return { phase: "idle" };
  const store = candidateStore(db, table, Date.now, chunk),
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
      retryTimeout: true,
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
    const scope = candidateScope(chunk),
      chain = chainReader(scope, rpc.transport, 5000, rpc.capacity);
    const bounds: CandidateBounds =
      job.bounds ?? (await prepareCandidate(chain, chunk));
    if (!job.bounds) {
      let metadata: TokenMetadata =
        chunk === "launch-30d-v1"
          ? JSON.parse(
              await readFile(
                new URL("./token-metadata.json", import.meta.url),
                "utf8",
              ),
            )
          : (await activeDataset(table, db)).metadata;
      if (chunk === "launch-30d-v1") {
        metadata.blockNumber = bounds.launch.number;
        metadata.blockHash = bounds.launch.hash;
      }
      if (candidateAdmission(chunk))
        metadata = fullCandidate(chunk)
          ? fullMetadata(metadata)
          : octoberMetadata(metadata);
      await store.initialize(owner, bounds, metadata);
    }
    const selected = await activeDataset(table, db);
    const staging =
      candidateAdmission(chunk) &&
      selected.scope.id === candidateSpec(candidatePrevious(chunk)!).scopeId
        ? { sourceScopeId: selected.scope.id, targetScopeId: scope.id }
        : undefined;
    if (selected.scope.id !== scope.id && !staging)
      throw new Error("Candidate active scope changed");
    const metadata = staging
      ? decodeDataset(
          (
            await db.send(
              new GetCommand({
                TableName: table,
                Key: datasetKey(scope.id),
                ConsistentRead: true,
              }),
            )
          ).Item!,
        ).metadata
      : selected.metadata;
    const canWork = () => context.getRemainingTimeInMillis() > 40000;
    const canContinue = async () =>
      canWork() &&
      rpc.capacity.remainingRequests() > 8 &&
      (await store.canContinue(owner));
    const archive = awsArchive({ table, bucket, db, s3, staging });
    const sampled = awsSampled({
      scope,
      table,
      bucket,
      metadata,
      db,
      s3,
      canContinue: canWork,
    });
    const aggregation = awsAggregation({ table, bucket, db, s3, staging });
    const aggregate = () =>
      aggregateNext({
        scope,
        startBlock: bounds.captureStart?.number ?? candidateSpec().startBlock,
        metadata,
        store: aggregation,
      });
    if (staging) {
      const previous = await candidateStore(
        db,
        table,
        Date.now,
        candidatePrevious(chunk)!,
      ).read();
      if (!previous?.completed || !previous.bounds)
        throw new Error("Incomplete staging source");
      if (
        !bounds.captureStart ||
        bounds.captureStart.hash !== previous.bounds.endBefore.hash
      )
        throw new Error("Admission source boundary changed");
      const sourceSamples = awsSampled({
        scope: selected.scope,
        metadata: selected.metadata,
        table,
        bucket,
        db,
        s3,
        canContinue: canWork,
      });
      const opening = await sourceSamples.read(candidateSpec(chunk).from - 300);
      const mapped = reusePreAdmissionSample(selected.scope, scope, opening);
      await sampled.cursor({
        startTimestamp: candidateSpec(chunk).from,
        nextTimestamp: candidateSpec(chunk).from,
        policyRevision: candidateSpec(chunk).policyRevision,
        anchor: bounds.captureStart,
      });
      await sampled.seedOpening(mapped);
      if (!(await canContinue())) result = { phase: "yielded" };
      else {
        await store.activateAdmission(owner);
        result = { phase: "candidate-activated" };
      }
    } else {
      result = await advanceCandidate({
        chunk,
        bounds,
        chain,
        archive,
        sampled,
        sample: sampledReader(scope, rpc.transport),
        aggregationNext: store.aggregationNext,
        aggregate,
        canContinue,
      });
    }
  } catch (e) {
    const code = failureCode(e);
    result = { phase: code === "work-limit" ? "yielded" : "failed", code };
  } finally {
    // Counters are observed usage, not a spending gate or provider billing units.
    console.log(
      JSON.stringify({
        event: "candidate-backfill",
        runId: owner,
        chunk,
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
