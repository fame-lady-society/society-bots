import { rehearseSampled } from "./sampled-production-rehearse.ts";
import { rehearseRefill } from "./refill-rehearse.ts";
import {
  publicReference,
  referencePolicy,
} from "../../src/fame-market-history/reference.ts";
import { rehearseReferences } from "./reference-rehearse.ts";
/** Real DynamoDB Local transactions + real DuckDB; S3 is an in-memory object
 * adapter. This is not an AWS/IAM rehearsal and cannot target a remote database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { localHistoryServer } from "./local-http.ts";
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
  BatchWriteCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { awsAggregation } from "../../src/fame-market-history/worker-storage.ts";
import { historyReader } from "../../src/fame-market-history/api.ts";
import { servingRevision } from "../../src/fame-market-history/revision.ts";
import {
  candleKey,
  progressKey,
  rangeKey,
  marketKey,
} from "../../src/fame-market-history/keys.ts";
import {
  aggregateNext,
  LEASE_MS,
  type Publication,
} from "../../src/fame-market-history/worker.ts";
import {
  awsArchive,
  commitInput,
  cursorKey,
} from "../../src/fame-market-history/storage.ts";
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
    await fixtureRange(100, 107, 106, 2n, 0, true),
    await fixtureRange(108, 114, 109, 3n, 0, true),
  ];
  const archive = awsArchive({ table, bucket: "local-objects", db, s3 });
  await archive.reduceRange(scope.id, 100, 250);
  await archive.reduceRange(scope.id, 100, 125);
  await archive.reduceRange(scope.id, 100, 250); // Cannot undo a smaller hint.
  await archive.reduceRange(scope.id, 99, 1); // Cannot overwrite a later hint.
  assert.deepEqual(await archive.cursor(scope.id, 100), {
    startBlock: 100,
    nextBlock: 100,
    previousHash: null,
    maxBlocks: 125,
  });
  assert.equal(
    (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: cursorKey(scope.id),
          ConsistentRead: true,
        }),
      )
    ).Item,
    undefined,
  );
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
  assert.equal((await archive.cursor(scope.id, 100)).maxBlocks, undefined);
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
  const read = historyReader({
    db,
    table,
    scope,
    metadata,
    metadataRevision: servingRevision(scope, metadata),
  });
  const response = await read({
    view: "market",
    from: epoch,
    to: epoch + 900,
    resolution: 300,
  });
  assert.equal(response.buckets.length, 3);
  assert.equal(response.buckets[1].tradeCount, 2);
  assert.equal(response.buckets[1].coverage, "complete");
  assert.equal(
    (response.buckets[1] as { prices: { volume: string }[] }).prices[1].volume,
    "5.000000000000000000",
  );
  const poolResponse = await read({
    view: "pool",
    pool: pool.id,
    from: epoch,
    to: epoch + 900,
    resolution: 300,
  });
  assert.equal(poolResponse.buckets[1].tradeCount, 2);
  const token = randomUUID();
  const server = localHistoryServer(read, scope, token);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/fame/history?view=market&from=${epoch}&to=${epoch + 900}&resolution=300`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { Authorization: `Bearer ${token}` };
    const result = await fetch(url, { headers });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), response);
    assert.equal(
      (await fetch(`${url}&from=${epoch}`, { headers })).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          url.replace(`to=${epoch + 900}`, `to=${epoch + 300 * 289}`),
          { headers },
        )
      ).status,
      400,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
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
  // Activity publication needs the native archive to reach the final bucket boundary.
  const closing = await fixtureRange(115, 115);
  objects.set(closing.manifest.key, closing.bytes);
  await db.send(
    new TransactWriteCommand(
      commitInput(table, closing.manifest, {
        startBlock: 100,
        nextBlock: 115,
        previousHash: ranges.at(-1)!.manifest.lastHash,
      }),
    ),
  );
  await rehearseSampled(db, s3, table);
  await rehearseReferences(db, s3, table);
  await rehearseRefill(db, s3, table);
  // Exercise the full advertised range against real DynamoDB pagination. The
  // market shape comes from the worker; timestamps repeat it solely as a load fixture.
  const market = await get(marketKey(scope.id, epoch + 300));
  assert.ok(market);
  const dense = Array.from({ length: 288 }, (_, i) => {
    const timestamp = epoch + i * 300;
    return {
      ...market,
      ...marketKey(scope.id, timestamp),
      timestamp,
      pools: market.pools.map((p: Record<string, unknown>) => ({
        ...p,
        timestamp,
      })),
      quotes: market.quotes.map((q: Record<string, unknown>) => ({
        ...q,
        timestamp,
      })),
    };
  });
  for (let i = 0; i < dense.length; i += 25) {
    const batch = await db.send(
      new BatchWriteCommand({
        RequestItems: {
          [table]: dense
            .slice(i, i + 25)
            .map((Item) => ({ PutRequest: { Item } })),
        },
      }),
    );
    assert.equal(Object.keys(batch.UnprocessedItems ?? {}).length, 0);
  }
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: progressKey(scope.id),
      UpdateExpression: "SET publishedThroughTimestamp = :time",
      ExpressionAttributeValues: { ":time": epoch + 288 * 300 - 1 },
    }),
  );
  let queryPages = 0;
  const counted = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof QueryCommand) queryPages++;
      return db.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const full = await historyReader({
    db: counted,
    table,
    scope,
    metadata,
    metadataRevision: servingRevision(scope, metadata),
  })({ view: "market", from: epoch, to: epoch + 288 * 300, resolution: 300 });
  assert.equal(full.buckets.length, 288);
  assert.ok(queryPages <= 4);
  assert.ok(
    full.buckets.every(
      (b) =>
        "reference" in b &&
        publicReference(b.reference, referencePolicy(scope).revision).values
          .fameEth.status === "available",
    ),
  );
  console.log(
    JSON.stringify({
      event: "market-api-full-range-verified",
      buckets: 288,
      queryPages,
      responseBytes: Buffer.byteLength(JSON.stringify(full)),
      httpContractVerified: true,
    }),
  );
  console.log(
    JSON.stringify({
      event: "worker-local-transactions-verified",
      ranges: 2,
      trades: 2,
      checkpoint: 115,
      crashRecovery: true,
      staleOwnerRejected: true,
      lostResponseSafe: true,
      scanWindowRecovery: true,
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
