/** Real local transactions for scope registration, staging and handoff races.
 * Uses a separate disposable table; no AWS or live RPC calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  dataset,
  activeDataset,
  datasetKey,
} from "../../src/fame-market-history/dataset.ts";
import {
  validateExpansion,
  registerExpansion,
  activateExpansion,
  getRow,
  expansionKey,
  type ExpansionJob,
  type HandoffProof,
} from "../../src/fame-market-history/dataset-transition.ts";
import {
  scope as target,
  metadata,
  epoch,
} from "../../src/fame-market-history/worker-fixture.ts";
import { sampledHeader } from "../../src/fame-market-history/sampled-fixture.ts";
import {
  historyScope,
  digest,
  type Manifest,
} from "../../src/fame-market-history/model.ts";
import {
  activeScopeKey,
  sampledKey,
  progressKey,
} from "../../src/fame-market-history/keys.ts";
import {
  awsArchive,
  cursorKey,
  commitInput,
} from "../../src/fame-market-history/storage.ts";
import { collect } from "../../src/fame-market-history/collector.ts";
import { sampledPolicy } from "../../src/fame-market-history/sampled-market.ts";
import type { SampledPublication } from "../../src/fame-market-history/sampled-live.ts";
import { aggregateNext } from "../../src/fame-market-history/worker.ts";
import { awsAggregation } from "../../src/fame-market-history/worker-storage.ts";

export async function rehearseTransition(
  client: DynamoDBClient,
  db: DynamoDBDocumentClient,
  s3: S3Client,
) {
  const table = `history-transition-${randomUUID()}`;
  const source = historyScope({
    ...target.registry,
    pools: target.registry.pools.filter(
      (p) => p.id !== "uniswap-v3-weth-fame-30bps",
    ),
  });
  const job: ExpansionJob = {
    version: "fame-scope-expansion-v1",
    tableArn: `arn:aws:dynamodb:us-west-1:590183914614:table/${table}`,
    bucket: "local-objects",
    source: dataset(source, metadata),
    target: dataset(target, metadata),
    startBlock: 100,
    sampleStart: epoch,
    anchor: sampledHeader(100),
  };
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
  try {
    const oldStore = awsArchive({ table, bucket: job.bucket, db, s3 });
    const chain = {
      finalized: async () => sampledHeader(105),
      header: async (n: number) => sampledHeader(n),
      logs: async (_: number, to: number) => ({ logs: [], throughBlock: to }),
    };
    await collect({
      chain,
      store: oldStore,
      scope: source,
      startBlock: 100,
      maxBlocks: 6,
      maxEvents: 100,
    });
    await aggregateNext({
      scope: source,
      metadata,
      startBlock: 100,
      store: awsAggregation({ table, bucket: job.bucket, db, s3 }),
    });
    const attempts = await Promise.allSettled([
      registerExpansion(db, table, job),
      registerExpansion(db, table, job),
    ]);
    assert.ok(attempts.some((a) => a.status === "fulfilled"));
    await registerExpansion(db, table, job); // Lost registration response resumes.
    assert.equal((await activeDataset(table, db)).scope.id, source.id);
    assert.equal(await getRow(db, table, cursorKey(target.id)), undefined);
    await assert.rejects(
      registerExpansion(db, table, { ...job, sampleStart: epoch + 300 }),
      /another expansion/,
    );
    // Simulate the deployed old collector's Put replacing the active pointer.
    await db.send(
      new PutCommand({
        TableName: table,
        Item: { ...activeScopeKey, scopeId: source.id },
      }),
    );
    assert.equal((await activeDataset(table, db)).scope.id, source.id);
    const staged = awsArchive({
      table,
      bucket: job.bucket,
      db,
      s3,
      staging: { sourceScopeId: source.id, targetScopeId: target.id },
    });
    await collect({
      chain,
      store: staged,
      scope: target,
      startBlock: 100,
      maxBlocks: 6,
      maxEvents: 100,
    });
    assert.equal((await activeDataset(table, db)).scope.id, source.id);
    assert.equal(
      (await getRow(db, table, cursorKey(source.id)))?.nextBlock,
      106,
    );
    await assert.rejects(
      awsArchive({ table, bucket: job.bucket, db, s3 }).cursor(target.id, 100),
      /scope changed/,
    );
    const result = await aggregateNext({
      scope: target,
      metadata,
      startBlock: 100,
      store: awsAggregation({
        table,
        bucket: job.bucket,
        db,
        s3,
        staging: { sourceScopeId: source.id, targetScopeId: target.id },
      }),
    });
    assert.equal(result.status, "published");
    assert.equal(
      (await getRow(db, table, progressKey(target.id)))?.nextBlock,
      106,
    );
    // Publication bodies here exercise conditional handoff, not chart math.
    // The full 288-page + HTTP pipeline is exercised by rehearseSampled.
    const publication = (scope: typeof target): SampledPublication => {
      const body = {
        version: "fame-sampled-publication-v1" as const,
        policyRevision: sampledPolicy(scope).revision,
        startTimestamp: epoch,
        nextTimestamp: epoch + 288 * 300,
        pages: Array.from({ length: 288 }, (_, i) => ({
          timestamp: epoch + i * 300,
          ETH: "a".repeat(64),
          USDC: "b".repeat(64),
        })),
      };
      return { ...body, generation: digest(JSON.stringify(body)) };
    };
    const proof: HandoffProof = {
      sourceCursor: {
        startBlock: 100,
        nextBlock: 106,
        previousHash: sampledHeader(105).hash,
      },
      targetCursor: {
        startBlock: 100,
        nextBlock: 106,
        previousHash: sampledHeader(105).hash,
      },
      sourcePublication: publication(source),
      targetPublication: publication(target),
      sampledNext: epoch + 288 * 300,
      aggregatedNext: 106,
    };
    for (const [scope, p] of [
      [source, proof.sourcePublication],
      [target, proof.targetPublication],
    ] as const)
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...sampledKey(sampledPolicy(scope).revision, "published"),
            ...p,
          },
        }),
      );
    await db.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...sampledKey(sampledPolicy(target).revision, "collected"),
          nextTimestamp: proof.sampledNext,
        },
      }),
    );
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: cursorKey(source.id),
        UpdateExpression: "SET nextBlock = :n",
        ExpressionAttributeValues: { ":n": 107 },
      }),
    );
    await assert.rejects(activateExpansion(db, table, job, proof), {
      name: "TransactionCanceledException",
    });
    assert.equal((await activeDataset(table, db)).scope.id, source.id);
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: cursorKey(source.id),
        UpdateExpression: "SET nextBlock = :n",
        ExpressionAttributeValues: { ":n": 106 },
      }),
    );
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: sampledKey(sampledPolicy(target).revision, "published"),
        UpdateExpression: "SET generation = :g",
        ExpressionAttributeValues: { ":g": "changed" },
      }),
    );
    await assert.rejects(activateExpansion(db, table, job, proof), {
      name: "TransactionCanceledException",
    });
    await db.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...sampledKey(sampledPolicy(target).revision, "published"),
          ...proof.targetPublication,
        },
      }),
    );
    await activateExpansion(db, table, job, proof);
    assert.equal((await activeDataset(table, db)).scope.id, target.id);
    assert.equal(
      (await getRow(db, table, expansionKey(target.id)))?.status,
      "active",
    );
    assert.equal(
      (await getRow(db, table, datasetKey(source.id)))?.definitionHash,
      job.source.definitionHash,
    );
    await assert.rejects(oldStore.cursor(source.id, 100), /scope changed/);
    await assert.rejects(staged.cursor(target.id, 100), /scope changed/);
    // Stale commits also fail even if their old cursor read preceded activation.
    const fake = { scopeId: source.id } as Manifest;
    await assert.rejects(
      db.send(
        new TransactWriteCommand(
          commitInput(
            table,
            {
              ...fake,
              fromBlock: 106,
              toBlock: 107,
              lastHash: sampledHeader(107).hash,
              key: "fake",
            } as Manifest,
            proof.sourceCursor,
          ),
        ),
      ),
    );
    assert.equal((await activeDataset(table, db)).scope.id, target.id);
    console.log(
      JSON.stringify({
        event: "scope-transition-local-proof",
        jobId: validateExpansion(job).jobId,
        sourcePools: 5,
        targetPools: 6,
        registrationRetry: true,
        activeSourcePreservedDuringStaging: true,
        staleCursorRejected: true,
        staleGenerationRejected: true,
        rawAndParquetPrepared: true,
        retainedSourceDefinition: true,
        storage: "DynamoDB Local + simulated S3",
        awsWrites: false,
      }),
    );
  } finally {
    await client.send(new DeleteTableCommand({ TableName: table }));
  }
}
