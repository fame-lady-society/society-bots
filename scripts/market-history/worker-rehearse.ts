/** Real DynamoDB Local transactions + real DuckDB; S3 is an in-memory object
 * adapter. This is not an AWS/IAM rehearsal and cannot target a remote database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
  awsAggregation,
  candleKey,
  progressKey,
  rangeKey,
} from "../../src/fame-market-history/worker-storage.ts";
import {
  aggregateNext,
  LEASE_MS,
  type Publication,
} from "../../src/fame-market-history/worker.ts";
import { commitInput } from "../../src/fame-market-history/storage.ts";
import {
  scope,
  pool,
  epoch,
  metadata,
  fixtureRange,
} from "../../src/fame-market-history/worker-fixture.ts";
import { digest } from "../../src/fame-market-history/model.ts";

const endpoint = new URL(
  process.env.FAME_HISTORY_DYNAMODB_ENDPOINT ?? "http://127.0.0.1:18001",
);
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.username ||
  endpoint.password
)
  throw Error("Rehearsal requires a loopback DynamoDB Local endpoint");
const client = new DynamoDBClient({
  endpoint: endpoint.href,
  region: "us-west-1",
  maxAttempts: 1,
  credentials: { accessKeyId: "localproof", secretAccessKey: "localproof" },
});
const db = DynamoDBDocumentClient.from(client);
const s3 = new S3Client({
  region: "us-west-1",
  credentials: { accessKeyId: "localproof", secretAccessKey: "localproof" },
});
const objects = new Map<string, Uint8Array>();
s3.send = (async (
  command: GetObjectCommand | PutObjectCommand | HeadObjectCommand,
) => {
  const key = command.input.Key!;
  if (command instanceof PutObjectCommand) {
    assert.equal(command.input.IfNoneMatch, "*");
    if (objects.has(key))
      throw Object.assign(Error("exists"), { name: "PreconditionFailed" });
    const bytes = command.input.Body as Uint8Array;
    assert.equal(
      command.input.ChecksumSHA256,
      Buffer.from(digest(bytes), "hex").toString("base64"),
    );
    objects.set(key, bytes);
    return {};
  }
  const bytes = objects.get(key);
  assert.ok(bytes);
  if (command instanceof HeadObjectCommand)
    return {
      ContentLength: bytes.length,
      ChecksumSHA256: Buffer.from(digest(bytes), "hex").toString("base64"),
    };
  assert.ok(command instanceof GetObjectCommand);
  return { ContentLength: bytes.length, Body: Readable.from([bytes]) };
}) as typeof s3.send;
const table = `history-proof-${randomUUID()}`;
let created = false;
try {
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
  created = true;
  await waitUntilTableExists(
    { client, maxWaitTime: 10, minDelay: 1, maxDelay: 1 },
    { TableName: table },
  );
  const ranges = [
    await fixtureRange(100, 107, 106),
    await fixtureRange(108, 114, 109, 3n),
  ];
  for (let i = 0; i < ranges.length; i++) {
    const { manifest, bytes } = ranges[i];
    objects.set(manifest.key, bytes);
    await db.send(
      new TransactWriteCommand(
        commitInput(table, manifest, {
          startBlock: 100,
          nextBlock: manifest.fromBlock,
          previousHash: i === 0 ? null : ranges[i - 1].manifest.lastHash,
        }),
      ),
    );
  }
  const store = awsAggregation({ table, bucket: "local-objects", db, s3 });
  let clock = 1000;
  const run = (adapter = store) =>
    aggregateNext({
      scope,
      startBlock: 100,
      metadata,
      store: adapter,
      now: () => clock,
    });
  const get = async (Key: { pk: string; sk: string }) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  let proposal!: Publication;
  await assert.rejects(
    run({
      ...store,
      publish: async (p) => {
        proposal = p;
        throw Error("injected crash");
      },
    }),
    /injected crash/,
  );
  assert.equal((await get(progressKey(scope.id)))?.nextBlock, 100);
  assert.equal(await get(candleKey(scope.id, pool.id, epoch + 300)), undefined);
  assert.equal(
    (await get({ pk: `work:${scope.id}`, sk: rangeKey(100) }))?.status,
    "pending",
  );
  assert.deepEqual(await run(), { status: "busy" });
  clock += LEASE_MS + 1;
  assert.ok(
    await store.acquire(
      scope.id,
      100,
      proposal.metadataRevision,
      "new-owner",
      clock,
    ),
  );
  await assert.rejects(store.publish({ ...proposal, now: clock }), {
    name: "TransactionCanceledException",
  });
  assert.equal(await get(candleKey(scope.id, pool.id, epoch + 300)), undefined);
  await store.release(scope.id, "new-owner");
  assert.equal((await run()).status, "published");
  await assert.rejects(
    run({
      ...store,
      publish: async (p) => {
        await store.publish(p);
        throw Error("lost response");
      },
    }),
    /lost response/,
  );
  assert.equal((await run()).status, "caught-up");
  const candle = await get(candleKey(scope.id, pool.id, epoch + 300));
  assert.equal(candle?.tradeCount, 2);
  assert.equal(candle.coverage, "complete");
  assert.equal(candle.baseVolumeAtoms, "2000000000000000000");
  assert.equal((await get(progressKey(scope.id)))?.nextBlock, 115);
  for (const { manifest } of ranges) {
    assert.equal(
      (await get({ pk: `work:${scope.id}`, sk: rangeKey(manifest.fromBlock) }))
        ?.status,
      "done",
    );
    const partition = await get({
      pk: `partitions:${scope.id}`,
      sk: rangeKey(manifest.fromBlock),
    });
    assert.ok(partition);
    const evidence = partition.artifacts.find((a: { key: string }) =>
      a.key.endsWith("evidence.json"),
    );
    const content = JSON.parse(
      Buffer.from(objects.get(evidence.key)!).toString(),
    );
    assert.equal(content.eventCount, 1);
    assert.equal(content.ranges.length, 1);
    assert.equal(content.ranges[0].fromBlock, manifest.fromBlock);
  }
  console.log(
    JSON.stringify({
      event: "worker-local-transactions-verified",
      ranges: 2,
      trades: 2,
      checkpoint: 115,
      crashRecovery: true,
      staleOwnerRejected: true,
      lostResponseSafe: true,
      parquetPartitionsOverlap: false,
      storage: "DynamoDB Local + simulated S3",
      awsWrites: false,
    }),
  );
} finally {
  if (created) await client.send(new DeleteTableCommand({ TableName: table }));
  client.destroy();
  s3.destroy();
}
