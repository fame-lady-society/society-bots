import { servingRevision } from "../../src/fame-market-history/revision.ts";
import { aggregateNext } from "../../src/fame-market-history/worker.ts";
import { awsAggregation } from "../../src/fame-market-history/worker-storage.ts";
/** Explicit, resumable scope admission. `prepare` writes a local plan only.
 * `stage --apply` writes a separate dataset; `activate --apply` is an operator
 * handoff AFTER deployment. Neither command merges or deploys code. */
import { readFile } from "node:fs/promises";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  HeadBucketCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { dataset } from "../../src/fame-market-history/dataset.ts";
import {
  validateExpansion,
  registerExpansion,
  activateExpansion,
  validateHandoff,
  expansionKey,
  getRow,
  rawCursor,
  type ExpansionJob,
} from "../../src/fame-market-history/dataset-transition.ts";
import {
  historyScope,
  integer,
  digest,
  type Manifest,
} from "../../src/fame-market-history/model.ts";
import { readArchive } from "../../src/fame-market-history/archive.ts";
import {
  activeScopeKey,
  rangeKey,
  progressKey,
} from "../../src/fame-market-history/keys.ts";
import { fameHistoryRegistry } from "../../src/fame-market-history/registry.ts";
import { sampledPolicy } from "../../src/fame-market-history/sampled-market.ts";
import { sampledReader as readSamples } from "../../src/fame-market-history/sampled-reader.ts";
import { sampledReader as rpcSamples } from "../../src/fame-market-history/sampled-rpc.ts";
import {
  collectSampled,
  publishSampled,
  type SampledPublication,
} from "../../src/fame-market-history/sampled-live.ts";
import {
  activityKey,
  activityChunkKey,
  validateActivityIndex,
} from "../../src/fame-market-history/activity-storage.ts";
import { awsSampled } from "../../src/fame-market-history/sampled-storage.ts";
import {
  awsArchive,
  cursorKey,
} from "../../src/fame-market-history/storage.ts";
import { expandRange } from "../../src/fame-market-history/scope-expansion.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { immutableFile } from "../../src/fame-market-history/local-artifacts.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
import type { TokenMetadata } from "../../src/fame-market-history/decode.ts";

const client = new DynamoDBClient({ maxAttempts: 2 });
const db = DynamoDBDocumentClient.from(client),
  s3 = new S3Client({ maxAttempts: 2 });
let metrics: unknown;
let phase = "configuration";
try {
  const [mode, file, apply, ...extra] = process.argv.slice(2);
  if (
    !["prepare", "stage", "verify", "activate"].includes(mode) ||
    !file ||
    extra.length ||
    (mode === "stage" || mode === "activate"
      ? apply !== "--apply"
      : apply !== undefined)
  )
    throw new Error(
      "Usage: expand-scope.ts prepare|verify plan.json OR stage|activate plan.json --apply",
    );
  const table = process.env.FAME_HISTORY_TABLE,
    bucket = process.env.FAME_HISTORY_BUCKET;
  if (!table || !bucket) throw new Error("Missing history table/bucket");
  const tableArn = (
    await client.send(new DescribeTableCommand({ TableName: table }))
  ).Table?.TableArn;
  if (!tableArn) throw new Error("Cannot verify table ARN");
  await s3.send(
    new HeadBucketCommand({
      Bucket: bucket,
      ExpectedBucketOwner: tableArn.split(":")[4],
    }),
  );
  const manifestAt = async (scopeId: string, block: number) => {
    const result = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :first AND :last",
        ExpressionAttributeValues: {
          ":pk": `scope:${scopeId}`,
          ":first": "range:",
          ":last": rangeKey(block),
        },
        ConsistentRead: true,
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    const manifest = result.Items?.[0] as Manifest | undefined;
    if (
      !manifest ||
      manifest.fromBlock > block ||
      manifest.toBlock < block ||
      manifest.scopeId !== scopeId
    )
      throw new Error("No source archive covers requested block");
    return manifest;
  };
  const download = async (m: Manifest) => {
    integer(m.bytes, "archive bytes", 1);
    if (m.bytes > 8 * 1024 * 1024) throw new Error("Archive too large");
    const r = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: m.key }),
    );
    if (!r.Body || r.ContentLength !== m.bytes)
      throw new Error("Archive size mismatch");
    let size = 0;
    const parts: Uint8Array[] = [];
    for await (const part of r.Body as AsyncIterable<Uint8Array>) {
      size += part.length;
      if (size > m.bytes) throw new Error("Oversized archive");
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    readArchive(m, bytes);
    return bytes;
  };
  phase = mode;
  if (mode === "prepare") {
    const active = await getRow(db, table, activeScopeKey);
    if (!active) throw new Error("No existing active scope");
    const cursor = rawCursor(
      await getRow(db, table, cursorKey(active.scopeId)),
    );
    const latest = await manifestAt(active.scopeId, cursor.nextBlock - 1);
    const source = readArchive(latest, await download(latest)).scope;
    const target = historyScope(fameHistoryRegistry);
    const metadata = JSON.parse(
      await readFile(
        new URL(
          "../../src/fame-market-history/token-metadata.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as TokenMetadata;
    const priorMetadata = {
      ...metadata,
      poolTokens: Object.fromEntries(
        Object.entries(metadata.poolTokens).filter(([id]) =>
          source.pools.some((p) => p.id === id),
        ),
      ),
    };
    const sourceProgress = await getRow(db, table, progressKey(source.id));
    if (
      sourceProgress?.metadataRevision !==
      servingRevision(source, priorMetadata)
    )
      throw new Error(
        "Source serving metadata changed; reviewed reconciliation required",
      );
    const publication = await readSamples(
      db,
      table,
      sampledPolicy(source).revision,
    ).publication();
    // One opening sample plus 288 display buckets. Retain the original raw start
    // so the live collector's configured immutable start remains valid at handoff.
    const first = await manifestAt(source.id, cursor.startBlock);
    const firstBatch = readArchive(first, await download(first));
    const sampleStart = publication.nextTimestamp - 289 * 300;
    const job: ExpansionJob = {
      version: "fame-scope-expansion-v1",
      tableArn,
      bucket,
      source: dataset(source, priorMetadata),
      target: dataset(target, metadata),
      startBlock: cursor.startBlock,
      sampleStart,
      anchor: firstBatch.headers[0],
    };
    const validated = validateExpansion(job);
    await immutableFile(file, Buffer.from(JSON.stringify(job, null, 2) + "\n"));
    console.log(
      JSON.stringify({
        event: "expansion-prepared",
        jobId: validated.jobId,
        file,
        sourcePools: source.pools.length,
        targetPools: target.pools.length,
        rawStart: job.startBlock,
        rawThrough: cursor.nextBlock - 1,
        sampleStart,
        awsWrites: false,
      }),
    );
  } else {
    const job = JSON.parse(await readFile(file, "utf8")) as ExpansionJob;
    const { source, target, added, jobId } = validateExpansion(job);
    if (job.tableArn !== tableArn || job.bucket !== bucket)
      throw new Error("Expansion resource mismatch");
    const active = await getRow(db, table, activeScopeKey);
    const registered = await getRow(db, table, expansionKey(target.scope.id));
    if (registered && registered.jobId !== jobId)
      throw new Error("Expansion job mismatch");
    if (
      active?.scopeId === target.scope.id &&
      registered?.status === "active"
    ) {
      console.log(JSON.stringify({ event: "expansion-already-active", jobId }));
    } else {
      if (active?.scopeId !== source.scope.id)
        throw new Error("Expansion source is no longer active");
      if (mode !== "stage" && !registered)
        throw new Error("Expansion has not been staged");
      const revision = sampledPolicy(target.scope).revision;
      const sampled = awsSampled({ table, bucket, db, s3, ...target });
      if (mode === "stage") {
        const url = process.env.FAME_HISTORY_RPC_URL;
        if (!url) throw new Error("Missing history RPC URL");
        phase = "registration";
        await registerExpansion(db, table, job);
        const deadline = Date.now() + 240000;
        const rpc = boundedTransport({
          url,
          maxRequests: 512,
          maxResponseBytes: 4 * 1024 * 1024,
          maxTotalResponseBytes: 32 * 1024 * 1024,
          deadline,
        });
        metrics = rpc.metrics;
        const chain = chainReader(added, rpc.transport, 5000, {
          remainingRequests: () => rpc.capacity.remainingRequests() - 2,
          canScan: () =>
            rpc.capacity.canScan() && rpc.capacity.remainingRequests() > 5,
        });
        const store = awsArchive({
          table,
          bucket,
          db,
          s3,
          staging: {
            sourceScopeId: source.scope.id,
            targetScopeId: target.scope.id,
          },
        });
        // A bounded run saves both lanes independently. Restart the same command
        // to continue; never reset to today's window or move the live cursor.
        const sourceCursor = rawCursor(
          await getRow(db, table, cursorKey(source.scope.id)),
        );
        phase = "raw-expansion";
        let rawRanges = 0;
        while (rawRanges < 12 && rpc.capacity.canScan()) {
          const cursor = await store.cursor(target.scope.id, job.startBlock);
          if (cursor.nextBlock >= sourceCursor.nextBlock) break;
          const manifest = await manifestAt(source.scope.id, cursor.nextBlock);
          const result = await expandRange({
            source: source.scope,
            target: target.scope,
            manifest,
            bytes: await download(manifest),
            chain,
            store,
            startBlock: job.startBlock,
            maxBlocks: 500,
            maxEvents: 10000,
          });
          rawRanges++;
          if (result.status !== "archived") break;
        }
        phase = "historical-sampling";
        if (rpc.capacity.canScan()) {
          if ((await chain.header(job.anchor.number)).hash !== job.anchor.hash)
            throw new Error("Expansion anchor changed");
          await sampled.cursor({
            startTimestamp: job.sampleStart,
            nextTimestamp: job.sampleStart,
            anchor: job.anchor,
            policyRevision: revision,
          });
          await collectSampled(
            target.scope,
            sampled,
            chain,
            rpcSamples(target.scope, rpc.transport),
            () =>
              rpc.capacity.canScan() && rpc.capacity.remainingRequests() > 32,
            12,
          );
        }
        phase = "parquet-aggregation";
        const aggregationStore = awsAggregation({
          table,
          bucket,
          db,
          s3,
          staging: {
            sourceScopeId: source.scope.id,
            targetScopeId: target.scope.id,
          },
        });
        let aggregatedRanges = 0;
        while (aggregatedRanges < 12 && Date.now() < deadline - 60000) {
          const result = await aggregateNext({
            ...target,
            startBlock: job.startBlock,
            store: aggregationStore,
          });
          if (result.status !== "published") break;
          aggregatedRanges++;
        }
        phase = "sampled-publication";
        const published = await publishSampled(
          target.scope,
          sampled,
          () => Date.now() < deadline - 30000,
          12,
        );
        console.log(
          JSON.stringify({
            event: "expansion-staged",
            jobId,
            rawRanges,
            aggregatedRanges,
            published,
            raw: await store.cursor(target.scope.id, job.startBlock),
            sampled: await sampled.collected(),
            metrics: rpc.metrics,
            activeScopeUnchanged:
              (await getRow(db, table, activeScopeKey))?.scopeId ===
              source.scope.id,
          }),
        );
      } else {
        phase = "handoff-verification";
        const reader = readSamples(db, table, revision);
        const targetPublication = await reader.publication();
        const sourcePublication = await readSamples(
          db,
          table,
          sampledPolicy(source.scope).revision,
        ).publication();
        const collected = await sampled.collected();
        if (!collected) throw new Error("Expanded samples are missing");
        const proof = {
          sourceCursor: rawCursor(
            await getRow(db, table, cursorKey(source.scope.id)),
          ),
          targetCursor: rawCursor(
            await getRow(db, table, cursorKey(target.scope.id)),
          ),
          sourcePublication,
          targetPublication,
          sampledNext: collected.nextTimestamp,
          aggregatedNext: integer(
            (await getRow(db, table, progressKey(target.scope.id)))?.nextBlock,
            "aggregation cursor",
            1,
          ),
        };
        validateHandoff(job, proof);
        // Bound each immutable page read; the generation remains pinned even if
        // an independent stager publishes during verification.
        const verifyDeadline = Date.now() + 240000;
        let chunkReads = 0,
          chunkBytes = 0;
        for (let i = 0; i < targetPublication.pages.length; i += 24) {
          if (Date.now() >= verifyDeadline)
            throw new Error("Expansion verification time allowance exceeded");
          const refs = targetPublication.pages.slice(i, i + 24);
          for (const currency of ["ETH", "USDC"] as const) {
            const targetPages = await readSamples(db, table, revision).pages(
              refs,
              currency,
            );
            const sourceRefs = sourcePublication.pages.filter((r) =>
              refs.some((t) => t.timestamp === r.timestamp),
            );
            const sourcePages = await readSamples(
              db,
              table,
              sampledPolicy(source.scope).revision,
            ).pages(sourceRefs, currency);
            for (const [timestamp, before] of sourcePages) {
              const after = targetPages.get(timestamp)!;
              for (const oldPool of before.series.filter(
                (p) => p.eventCoverage === "complete",
              )) {
                const nextPool = after.series.find(
                  (p) => p.poolId === oldPool.poolId,
                );
                if (
                  !nextPool ||
                  [
                    "eventCoverage",
                    "baseVolumeAtoms",
                    "quoteVolumeAtoms",
                    "tradeCount",
                  ].some(
                    (key) =>
                      oldPool[key as keyof typeof oldPool] !==
                      nextPool[key as keyof typeof nextPool],
                  )
                )
                  throw new Error(
                    "Expanded publication changed existing complete native activity",
                  );
              }
            }
          }
          for (const ref of refs) {
            const row = await getRow(db, table, activityKey(revision, ref));
            if (!row || typeof row.body !== "string")
              throw new Error("Expanded activity sidecar is missing");
            const index = validateActivityIndex(JSON.parse(row.body));
            if (index.timestamp !== ref.timestamp)
              throw new Error("Expanded activity timestamp mismatch");
            for (const chunk of index.chunks) {
              chunkBytes += chunk.bytes;
              if (
                ++chunkReads > 4096 ||
                chunkBytes > 32 * 1024 * 1024 ||
                Date.now() >= verifyDeadline
              )
                throw new Error(
                  "Expansion verification activity allowance exceeded",
                );
              const value = await getRow(
                db,
                table,
                activityChunkKey(revision, chunk.sha256),
              );
              if (
                typeof value?.body !== "string" ||
                Buffer.byteLength(value.body) !== chunk.bytes ||
                digest(value.body) !== chunk.sha256 ||
                JSON.parse(value.body).length !== chunk.count
              )
                throw new Error(
                  "Expanded activity chunk is missing or corrupt",
                );
            }
          }
        }
        if (mode === "activate") await activateExpansion(db, table, job, proof);
        console.log(
          JSON.stringify({
            event:
              mode === "activate"
                ? "expansion-activated"
                : "expansion-verified",
            jobId,
            buckets: targetPublication.pages.length,
            generation: targetPublication.generation,
            sourceScope: source.scope.id,
            targetScope: target.scope.id,
            awsWrites: mode === "activate",
          }),
        );
      }
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      event: "scope-expansion-failed",
      phase,
      code: failureCode(error),
      metrics,
      message:
        "No cursor reset or automatic handoff. Inspect the plan and committed progress before retrying.",
    }),
  );
  process.exitCode = 1;
} finally {
  client.destroy();
  s3.destroy();
}
