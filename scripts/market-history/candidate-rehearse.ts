/** Real DynamoDB Local + DuckDB, deterministic chain and in-memory S3.
 * Verifies AWS adapters and API composition without AWS credentials or RPC. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { encodeAbiParameters, parseAbiParameters, toEventSelector } from "viem";
import {
  candidateStore,
  CANDIDATE_LEASE_MS,
} from "../../src/fame-market-history/candidate-storage.ts";
import {
  advanceCandidate,
  candidateSpec,
  candidateKey,
  prepareCandidate,
} from "../../src/fame-market-history/candidate.ts";
import {
  octoberScope,
  octoberMetadata,
} from "../../src/fame-market-history/october-scope.ts";
import {
  dataset,
  datasetKey,
  decodeDataset,
  closeHistory,
} from "../../src/fame-market-history/dataset.ts";
import { reusePreAdmissionSample } from "../../src/fame-market-history/admission-opening.ts";
import { collect } from "../../src/fame-market-history/collector.ts";
import { candidateRun } from "../../src/fame-market-history/candidate-run.ts";
import {
  fullScope,
  fullMetadata,
} from "../../src/fame-market-history/full-scope.ts";
import { sampledMarketBucket } from "../../src/fame-market-history/sampled-market.ts";
import { deriveSampledObservation } from "../../src/fame-market-history/sampled-rpc.ts";
import {
  publishSampled,
  nextSampledPublication,
} from "../../src/fame-market-history/sampled-live.ts";
import { launchScope } from "../../src/fame-market-history/local-backfill.ts";
import { awsArchive } from "../../src/fame-market-history/storage.ts";
import { cursorKey } from "../../src/fame-market-history/storage.ts";
import {
  progressKey,
  sampledKey,
  activeScopeKey,
} from "../../src/fame-market-history/keys.ts";
import { awsSampled } from "../../src/fame-market-history/sampled-storage.ts";
import { awsAggregation } from "../../src/fame-market-history/worker-storage.ts";
import { aggregateNext } from "../../src/fame-market-history/worker.ts";
import { sampledFixture } from "../../src/fame-market-history/sampled-fixture.ts";
import {
  digest,
  type Header,
  type RawLog,
} from "../../src/fame-market-history/model.ts";
import type { ChainReader } from "../../src/fame-market-history/collector.ts";
const endpoint = new URL(
  process.env.FAME_HISTORY_DYNAMODB_ENDPOINT ?? "http://127.0.0.1:18001",
);
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.username ||
  endpoint.password
)
  throw new Error("Loopback database required");
const client = new DynamoDBClient({
    endpoint: endpoint.href,
    region: "us-west-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  db = DynamoDBDocumentClient.from(client);
const s3 = new S3Client({
    region: "us-west-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  objects = new Map<string, Uint8Array>();
let loseUploadResponse = false;
s3.send = (async (
  command: PutObjectCommand | GetObjectCommand | HeadObjectCommand,
) => {
  const key = command.input.Key!;
  if (command instanceof PutObjectCommand) {
    assert.equal(command.input.IfNoneMatch, "*");
    if (objects.has(key))
      throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
    const b = command.input.Body as Uint8Array;
    assert.equal(
      command.input.ChecksumSHA256,
      Buffer.from(digest(b), "hex").toString("base64"),
    );
    objects.set(key, b);
    if (loseUploadResponse && key.startsWith("raw/")) {
      loseUploadResponse = false;
      throw new Error("Simulated lost upload response");
    }
    return {};
  }
  const b = objects.get(key)!;
  assert(b);
  return command instanceof HeadObjectCommand
    ? {
        ContentLength: b.length,
        ChecksumSHA256: Buffer.from(digest(b), "hex").toString("base64"),
      }
    : { ContentLength: b.length, Body: Readable.from([b]) };
}) as typeof s3.send;
const table = `candidate-proof-${randomUUID()}`,
  scope = launchScope(),
  spec = candidateSpec();
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
  const h = (number: number): Header => ({
    number,
    timestamp: spec.from + 29 + (number - spec.startBlock) * 2,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    parentHash: `0x${(number - 1).toString(16).padStart(64, "0")}`,
  });
  const pool = scope.pools.find((p) => p.venueFamily === "UniswapV2")!,
    block = spec.startBlock + 2;
  const logs: RawLog[] = [
    {
      address: pool.address,
      blockNumber: block,
      blockHash: h(block).hash,
      transactionHash: h(1).hash,
      transactionIndex: 0,
      logIndex: 0,
      removed: false,
      topics: [toEventSelector("Sync(uint112,uint112)")],
      data: encodeAbiParameters(parseAbiParameters("uint112,uint112"), [
        10n ** 18n,
        10n ** 18n,
      ]),
    },
    {
      address: pool.address,
      blockNumber: block,
      blockHash: h(block).hash,
      transactionHash: h(1).hash,
      transactionIndex: 0,
      logIndex: 1,
      removed: false,
      topics: [
        toEventSelector(
          "Swap(address,uint256,uint256,uint256,uint256,address)",
        ),
        `0x${"0".repeat(64)}`,
        `0x${"0".repeat(64)}`,
      ],
      data: encodeAbiParameters(
        parseAbiParameters("uint256,uint256,uint256,uint256"),
        [10n ** 16n, 0n, 0n, 10n ** 16n],
      ),
    },
  ];
  const chain: ChainReader = {
    header: async (n) => h(n),
    finalized: async () => h(spec.startBlock + 30 * 43200 + 100),
    logs: async (from, to) => ({
      logs: logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
      throughBlock: to,
    }),
  };
  const bounds = await prepareCandidate(chain),
    metadata = JSON.parse(
      await readFile(
        new URL(
          "../../src/fame-market-history/token-metadata.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  metadata.blockNumber = bounds.launch.number;
  metadata.blockHash = bounds.launch.hash;
  let now = Date.now();
  const store = candidateStore(db, table, () => now),
    zero = { requests: 0, responseBytes: 0, methods: {} };
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint.href;
  process.env.AWS_REGION = "us-west-1";
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  process.env.FAME_CANDIDATE_TABLE = table;
  process.env.FAME_CANDIDATE_BUCKET = "local";
  process.env.FAME_HISTORY_RPC_PARAMETER = "/not-used-in-idle-proof";
  const { handler: candidateHandler } = await import(
    "../../src/fame-market-history/candidate-lambda.ts"
  );
  assert.deepEqual(
    await candidateHandler({}, { getRemainingTimeInMillis: () => 300000 }),
    { phase: "idle" },
  );
  const august = candidateStore(db, table, () => now, "august-30d-v1");
  const september = candidateStore(db, table, () => now, "september-30d-v1");
  await assert.rejects(august.control("start"), /must be complete/);
  await assert.rejects(september.control("start"), /must be complete/);
  assert.equal(await store.acquire("idle"), null);
  await store.control("start");
  await store.control("start");
  assert(await store.acquire("first"));
  assert.equal(await store.acquire("second"), null);
  await store.initialize("first", bounds, metadata);
  await store.control("pause");
  assert.equal(await store.canContinue("first"), false);
  await store.finish("first", { phase: "paused" }, zero);
  assert.equal(await store.acquire("paused"), null);
  await store.control("start");
  assert.equal(await store.acquire("still-paused"), null);
  await store.control("resume");
  assert(await store.acquire("crashed"));
  now += CANDIDATE_LEASE_MS + 1;
  assert(await store.acquire("replacement"));
  await assert.rejects(store.finish("crashed", { phase: "complete" }, zero));
  await store.finish("replacement", { phase: "yielded" }, zero);
  assert(await store.acquire("upload-fault"));
  loseUploadResponse = true;
  await assert.rejects(
    advanceCandidate({
      bounds,
      chain,
      archive: awsArchive({ table, bucket: "local", db, s3 }),
      sampled: awsSampled({ scope, table, bucket: "local", metadata, db, s3 }),
      sample: async () => {
        throw new Error("Unexpected sample");
      },
      aggregate: async () => {
        throw new Error("Unexpected aggregate");
      },
      aggregationNext: store.aggregationNext,
      canContinue: async () => true,
      maxSteps: 1,
    }),
    /Simulated lost upload response/,
  );
  assert.equal(((await store.status()) as any).rawNextBlock, spec.startBlock);
  await store.finish("upload-fault", { phase: "failed", code: "test" }, zero);
  let invocations = 0,
    samples = 0;
  while (
    ((await store.status()) as any).publishedNextTimestamp <
    spec.from + 86400 + 300
  ) {
    const owner = `run-${++invocations}`;
    assert(invocations < 12);
    assert(await store.acquire(owner));
    const archive = awsArchive({ table, bucket: "local", db, s3 }),
      sampled = awsSampled({ scope, table, bucket: "local", metadata, db, s3 }),
      aggregation = awsAggregation({ table, bucket: "local", db, s3 });
    const result = await advanceCandidate({
      bounds,
      chain,
      archive,
      sampled,
      sample: async (t, b, a) => {
        samples++;
        return { ...sampledFixture(t, scope), block: b, after: a };
      },
      aggregate: () =>
        aggregateNext({
          scope,
          startBlock: spec.startBlock,
          metadata,
          store: aggregation,
        }),
      aggregationNext: store.aggregationNext,
      canContinue: () => store.canContinue(owner),
      maxSteps: 128,
    });
    await store.finish(owner, result, zero);
  }
  const status = (await store.status()) as any;
  assert.equal(status.job.completed, false);
  assert.equal(samples, (status.sampleNextTimestamp - spec.from) / 300);
  assert([...objects.keys()].some((k) => k.endsWith("events.parquet")));
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint.href;
  process.env.AWS_REGION = "us-west-1";
  process.env.AWS_ACCESS_KEY_ID = "local";
  process.env.AWS_SECRET_ACCESS_KEY = "local";
  process.env.FAME_HISTORY_TABLE = table;
  const { handler } = await import(
    "../../src/fame-market-history/api-lambda.ts"
  );
  const call = async (q: URLSearchParams) => {
    const r = await handler({
      rawQueryString: q.toString(),
      requestContext: { http: { method: "GET" } },
    } as any);
    assert.equal(r.statusCode, 200, r.body);
    return JSON.parse(r.body);
  };
  for (const currency of ["ETH", "USDC"]) {
    const q = new URLSearchParams({
      view: "chart",
      series: "market",
      currency,
      resolution: "300",
      from: String(spec.from),
      to: String(spec.from + 86400),
    });
    const chart = await call(q);
    assert.equal(chart.upserts.length, 288);
    assert.equal(
      chart.upserts.reduce((n: number, b: any) => n + (b.tradeCount ?? 0), 0),
      1,
    );
    assert(
      chart.upserts.every((b: any) => b.publicationStatus === "published"),
    );
    q.set("cursor", chart.cursor);
    assert.deepEqual((await call(q)).upserts, []);
    q.delete("cursor");
    q.delete("series");
    q.set("view", "activity");
    let rows: any[] = [];
    let pages = 0;
    do {
      const a = await call(q);
      rows.push(...a.rows);
      assert(++pages < 100);
      if (!a.nextCursor) break;
      q.set("cursor", a.nextCursor);
    } while (true);
    assert.equal(rows.length, 1);
  }
  const availability = await call(
    new URLSearchParams({ view: "availability", before: String(spec.from) }),
  );
  assert.equal(availability.earliestAvailableTimestamp, spec.from);
  assert.equal(availability.hasEarlier, false);
  // Real storage boundary proof: keep all retained rows and objects untouched,
  // collect only two new buckets, and serve one chart across both definitions.
  const snapshot = async () => {
    const rows = new Map<string, any>();
    let last: Record<string, any> | undefined;
    do {
      const page = await db.send(
        new ScanCommand({
          TableName: table,
          ConsistentRead: true,
          ...(last ? { ExclusiveStartKey: last } : {}),
        }),
      );
      for (const row of page.Items ?? []) rows.set(`${row.pk}|${row.sk}`, row);
      last = page.LastEvaluatedKey;
    } while (last);
    return rows;
  };
  const retainedRows = await snapshot(),
    retainedObjects = new Map([...objects].map(([k, v]) => [k, digest(v)]));
  const boundary = status.publishedNextTimestamp,
    target = octoberScope(),
    targetMetadata = octoberMetadata(metadata);
  const sourceSamples = awsSampled({
    scope,
    table,
    bucket: "local",
    metadata,
    db,
    s3,
  });
  const opening = await sourceSamples.read(boundary - 300);
  const history = closeHistory(
    decodeDataset(dataset(scope, metadata)),
    boundary,
  );
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...datasetKey(target.id),
        ...dataset(target, targetMetadata, history),
      },
    }),
  );
  const targetSamples = awsSampled({
    scope: target,
    table,
    bucket: "local",
    metadata: targetMetadata,
    db,
    s3,
  });
  let targetCursor = await targetSamples.cursor({
    startTimestamp: boundary,
    nextTimestamp: boundary,
    anchor: opening.block,
    policyRevision: candidateSpec("october-30d-v1").policyRevision,
  });
  const mapped = reusePreAdmissionSample(scope, target, opening);
  loseUploadResponse = true;
  await assert.rejects(
    targetSamples.seedOpening(mapped),
    /Simulated lost upload response/,
  );
  await targetSamples.seedOpening(mapped);
  await targetSamples.seedOpening(mapped);
  assert.equal((await targetSamples.collected())?.nextTimestamp, boundary);
  assert.equal(await targetSamples.publication(), null);
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: activeScopeKey,
      UpdateExpression: "SET scopeId = :s",
      ExpressionAttributeValues: { ":s": target.id },
    }),
  );
  const seamQuery = new URLSearchParams({
    view: "chart",
    resolution: "300",
    currency: "ETH",
    from: String(boundary - 600),
    to: String(boundary + 600),
  });
  const emptySeam = await call(seamQuery);
  assert.deepEqual(
    emptySeam.upserts.map((b: any) => b.publicationStatus),
    ["published", "published", "not-yet-published", "not-yet-published"],
  );
  const captureStart = opening.block.number,
    endBlock = captureStart + 301;
  // Put a swap in the first block of the new interval, already present in the
  // predecessor's edge capture. It must appear exactly once in the logical view.
  logs.push(
    ...logs.slice(0, 2).map((l) => ({
      ...l,
      blockNumber: opening.after.number,
      blockHash: opening.after.hash,
      transactionHash: h(2).hash,
    })),
  );
  const targetArchive = awsArchive({ table, bucket: "local", db, s3 });
  assert.equal(
    (
      await collect({
        scope: target,
        chain,
        store: targetArchive,
        startBlock: captureStart,
        endBlock,
        maxBlocks: 2000,
        maxEvents: 5000,
      })
    ).status,
    "archived",
  );
  assert.equal(
    (
      await aggregateNext({
        scope: target,
        startBlock: captureStart,
        metadata: targetMetadata,
        store: awsAggregation({ table, bucket: "local", db, s3 }),
      })
    ).status,
    "published",
  );
  for (let t = boundary; t < boundary + 600; t += 300) {
    const b = h(captureStart + (t - boundary) / 2 + 150),
      a = h(b.number + 1);
    await targetSamples.commit(targetCursor, {
      ...sampledFixture(t, target),
      block: b,
      after: a,
    });
    targetCursor = { ...targetCursor, nextTimestamp: t + 300, anchor: b };
  }
  assert.equal(
    (await publishSampled(target, targetSamples, () => true, 2)).published,
    2,
  );
  for (const currency of ["ETH", "USDC"]) {
    seamQuery.set("currency", currency);
    seamQuery.delete("cursor");
    const seam = await call(seamQuery);
    assert.equal(
      seam.upserts.reduce((n: number, b: any) => n + (b.tradeCount ?? 0), 0),
      1,
    );
    assert(seam.upserts.every((b: any) => b.publicationStatus === "published"));
    seamQuery.set("cursor", seam.cursor);
    assert.deepEqual((await call(seamQuery)).upserts, []);
    const old = await call(
      new URLSearchParams({
        view: "chart",
        resolution: "300",
        currency,
        from: String(spec.from),
        to: String(spec.from + 86400),
      }),
    );
    assert.equal(old.upserts.length, 288);
    assert.equal(old.upserts[0].tradeCount, 1);
    const tx = await call(
      new URLSearchParams({
        view: "activity",
        resolution: "300",
        currency,
        from: String(spec.from),
        to: String(spec.from + 300),
      }),
    );
    assert.equal(tx.rows.length, 1);
  }
  seamQuery.set("currency", "ETH");
  seamQuery.set("cursor", emptySeam.cursor);
  assert.equal((await call(seamQuery)).upserts.length, 2);
  const afterRows = await snapshot();
  for (const [k, row] of retainedRows)
    if (row.sk !== "active-scope")
      assert.deepEqual(afterRows.get(k), row, `Old row changed: ${k}`);
  for (const [k, sha] of retainedObjects)
    assert.equal(digest(objects.get(k)!), sha, `Old object changed: ${k}`);
  // Remove only this synthetic target fixture before testing the real October
  // activation transaction below. No remote table or object is ever used.
  for (const [k, row] of afterRows)
    if (!retainedRows.has(k))
      await db.send(
        new DeleteCommand({
          TableName: table,
          Key: { pk: row.pk, sk: row.sk },
        }),
      );
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: activeScopeKey,
      UpdateExpression: "SET scopeId = :s",
      ExpressionAttributeValues: { ":s": scope.id },
    }),
  );
  await store.control("pause");
  assert.equal(await store.acquire("after-pause"), null);
  assert.deepEqual(
    await candidateHandler({}, { getRemainingTimeInMillis: () => 300000 }),
    { phase: "idle" },
  );
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: candidateKey,
      UpdateExpression: "SET specHash = :bad",
      ExpressionAttributeValues: { ":bad": "changed" },
    }),
  );
  await assert.rejects(store.acquire("wrong-spec"), /specification changed/);
  const retainedLaunchPublication = (
    await db.send(
      new GetCommand({
        TableName: table,
        Key: sampledKey(spec.policyRevision, "published"),
      }),
    )
  ).Item;
  // Transaction-only continuation fixture: move the durable frontiers to the
  // completed boundary. This does NOT claim the intervening month was replayed.
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: candidateKey,
      UpdateExpression: "SET specHash = :hash, completed = :done",
      ExpressionAttributeValues: {
        ":hash": status.job.specHash,
        ":done": true,
      },
    }),
  );
  await assert.rejects(august.control("start")); // completion bit alone is insufficient
  const set = async (
    Key: Record<string, string>,
    field: string,
    value: number,
  ) =>
    db.send(
      new UpdateCommand({
        TableName: table,
        Key,
        UpdateExpression: `SET ${field} = :value`,
        ExpressionAttributeValues: { ":value": value },
      }),
    );
  await set(cursorKey(spec.scopeId), "nextBlock", bounds.end.number + 1);
  await set(progressKey(spec.scopeId), "nextBlock", bounds.end.number + 1);
  await set(
    sampledKey(spec.policyRevision, "collected"),
    "nextTimestamp",
    spec.to,
  );
  await assert.rejects(august.control("start")); // publication must also be caught up
  await set(
    sampledKey(spec.policyRevision, "published"),
    "nextTimestamp",
    spec.to,
  );
  const completedJob = await store.read();
  assert.deepEqual(
    await candidateHandler({}, { getRemainingTimeInMillis: () => 300000 }),
    { phase: "idle" },
  );
  assert.equal(await august.read(), undefined); // deployment never auto-starts a successor
  await august.control("start");
  await august.control("start"); // lost-response retry / duplicate control
  assert(await august.acquire("august-owner"));
  assert.equal(await august.acquire("duplicate-owner"), null);
  await assert.rejects(september.control("start"), /must be complete/);
  chain.finalized = async () => h(spec.startBlock + 90 * 43200 + 100);
  const augustBounds = await prepareCandidate(chain, "august-30d-v1");
  const activeBefore = await db.send(
    new GetCommand({ TableName: table, Key: activeScopeKey }),
  );
  await august.initialize("august-owner", augustBounds, metadata);
  assert.deepEqual(
    (await db.send(new GetCommand({ TableName: table, Key: activeScopeKey })))
      .Item,
    activeBefore.Item,
  );
  await august.control("pause");
  await august.control("start");
  assert.equal(await august.canContinue("august-owner"), false);
  await august.finish("august-owner", { phase: "yielded" }, zero);
  assert.deepEqual(
    await candidateHandler({}, { getRemainingTimeInMillis: () => 300000 }),
    { phase: "idle" },
  );
  await august.control("resume");
  assert(await august.acquire("august-crash"));
  now += CANDIDATE_LEASE_MS + 1;
  assert(await august.acquire("august-recovery"));
  await assert.rejects(
    august.finish("august-crash", { phase: "complete" }, zero),
  );
  await august.finish("august-recovery", { phase: "yielded" }, zero);
  assert.deepEqual(await store.read(), completedJob); // predecessor is never rewritten
  assert(await august.acquire("august-completion"));
  await set(cursorKey(spec.scopeId), "nextBlock", augustBounds.end.number + 1);
  await set(
    progressKey(spec.scopeId),
    "nextBlock",
    augustBounds.end.number + 1,
  );
  await set(
    sampledKey(spec.policyRevision, "collected"),
    "nextTimestamp",
    candidateSpec("august-30d-v1").to,
  );
  await set(
    sampledKey(spec.policyRevision, "published"),
    "nextTimestamp",
    candidateSpec("august-30d-v1").to,
  );
  await august.finish("august-completion", { phase: "complete" }, zero);
  assert.deepEqual(
    await candidateHandler({}, { getRemainingTimeInMillis: () => 300000 }),
    { phase: "idle" },
  );
  assert.equal(await september.read(), undefined);
  await september.control("start");
  await september.control("pause");
  assert.deepEqual(
    await candidateHandler({}, { getRemainingTimeInMillis: () => 300000 }),
    { phase: "idle" },
  );
  assert.equal((await september.read())?.predecessor, "august-30d-v1");
  // Guarded October activation uses a completed predecessor fixture; this does
  // not claim that the intervening 90 days were collected in this local test.
  await september.control("resume");
  assert(await september.acquire("sep-proof"));
  chain.finalized = async () => h(spec.startBlock + 120 * 43200 + 100);
  const sepBounds = await prepareCandidate(chain, "september-30d-v1");
  await september.initialize("sep-proof", sepBounds, metadata);
  for (const k of [cursorKey(scope.id), progressKey(scope.id)])
    await set(k, "nextBlock", sepBounds.end.number + 1);
  for (const kind of ["collected", "published"])
    await set(
      sampledKey(spec.policyRevision, kind),
      "nextTimestamp",
      candidateSpec("october-30d-v1").from,
    );
  await september.finish("sep-proof", { phase: "complete" }, zero);
  const completedSeptember = await september.read();
  const october = candidateStore(db, table, () => now, "october-30d-v1");
  await october.control("start");
  assert(await october.acquire("oct-proof"));
  const octBounds = await prepareCandidate(chain, "october-30d-v1");
  await october.initialize("oct-proof", octBounds, targetMetadata);
  await assert.rejects(
    october.activateAdmission("oct-proof"),
    /opening observation/,
  );
  const octStart = candidateSpec("october-30d-v1").from;
  const newSamples = awsSampled({
    scope: target,
    table,
    bucket: "local",
    metadata: targetMetadata,
    db,
    s3,
  });
  await newSamples.cursor({
    startTimestamp: octStart,
    nextTimestamp: octStart,
    anchor: octBounds.captureStart!,
    policyRevision: candidateSpec("october-30d-v1").policyRevision,
  });
  await newSamples.seedOpening(
    reusePreAdmissionSample(scope, target, {
      ...sampledFixture(octStart - 300, scope),
      block: octBounds.captureStart!,
      after: sepBounds.end,
    }),
  );
  await october.control("pause");
  await assert.rejects(october.activateAdmission("oct-proof"));
  await october.control("resume");
  await assert.rejects(october.activateAdmission("wrong-owner"));
  await october.activateAdmission("oct-proof");
  assert.deepEqual(await september.read(), completedSeptember);
  assert.equal(
    (await db.send(new GetCommand({ TableName: table, Key: activeScopeKey })))
      .Item?.scopeId,
    target.id,
  );
  assert.equal(
    ((await october.status()) as any).rawNextBlock,
    octBounds.captureStart!.number,
  );
  // Exercise the real October coordinator after activation: no July replay.
  const next = await advanceCandidate({
    chunk: "october-30d-v1",
    bounds: octBounds,
    chain,
    archive: awsArchive({ table, bucket: "local", db, s3 }),
    sampled: newSamples,
    sample: async (t, b, a) => ({
      ...sampledFixture(t, target),
      block: b,
      after: a,
    }),
    aggregate: () =>
      aggregateNext({
        scope: target,
        startBlock: octBounds.captureStart!.number,
        metadata: targetMetadata,
        store: awsAggregation({ table, bucket: "local", db, s3 }),
      }),
    aggregationNext: october.aggregationNext,
    canContinue: async () => true,
    maxSteps: 6,
  });
  assert.equal(next.phase, "yielded");
  assert((await newSamples.publication())!.nextTimestamp > octStart);
  await october.finish("oct-proof", next, zero);
  const november = candidateStore(db, table, () => now, "catchup-4-1733788800");
  await assert.rejects(november.control("start"), /must be complete/);
  assert(await october.acquire("oct-complete"));
  // Seed only the month-end fixture, not an invented claim of a full local month.
  // Retain a real adjacent archive and opening observation so November executes
  // the actual raw -> Parquet -> sample -> publication adapters across the seam.
  const lastFrom = octBounds.end.number - 1999;
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: cursorKey(target.id),
      UpdateExpression: "SET nextBlock = :n, previousHash = :h",
      ExpressionAttributeValues: { ":n": lastFrom, ":h": h(lastFrom - 1).hash },
    }),
  );
  await collect({
    scope: target,
    chain,
    store: awsArchive({ table, bucket: "local", db, s3 }),
    startBlock: octBounds.captureStart!.number,
    endBlock: octBounds.end.number,
    maxBlocks: 2000,
    maxEvents: 5000,
  });
  await set(progressKey(target.id), "nextBlock", octBounds.end.number + 1);
  const novStart = candidateSpec("catchup-4-1733788800").from;
  const anchor = h(octBounds.endBefore.number - 150);
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: sampledKey(
        candidateSpec("october-30d-v1").policyRevision,
        "collected",
      ),
      UpdateExpression: "SET nextTimestamp = :n, anchor = :a",
      ExpressionAttributeValues: { ":n": novStart - 300, ":a": anchor },
    }),
  );
  const finalEvidence = {
    ...sampledFixture(novStart - 300, target),
    block: octBounds.endBefore,
    after: octBounds.end,
  };
  await newSamples.commit((await newSamples.collected())!, finalEvidence);
  const finalBuckets = (["ETH", "USDC"] as const).map((c) =>
    sampledMarketBucket(
      target,
      c,
      novStart - 300,
      deriveSampledObservation(target, finalEvidence),
      [],
    ),
  );
  const finalPublication = nextSampledPublication(
    null,
    finalEvidence,
    finalBuckets,
  );
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...sampledKey(finalEvidence.policyRevision, "published"),
        ...finalPublication,
      },
    }),
  );
  await october.finish("oct-complete", { phase: "complete" }, zero);
  const completedOctober = await october.read();
  const activeAndDefinition = async () =>
    Promise.all(
      [activeScopeKey, datasetKey(target.id)].map(
        async (Key) =>
          (await db.send(new GetCommand({ TableName: table, Key }))).Item,
      ),
    );
  const beforeNovember = await activeAndDefinition();
  const run = candidateRun(db, table, () => Date.parse("2024-12-11T12:00:00Z"));
  await run.control("start");
  const frozen = await run.read();
  await candidateRun(db, table, () =>
    Date.parse("2025-01-01T00:00:00Z"),
  ).control("start");
  assert.deepEqual(await run.read(), frozen);
  await run.control("pause");
  assert.equal(await run.select(), undefined);
  await assert.rejects(november.control("start"), /continuation requires/);
  await run.control("resume");

  assert.equal(await november.read(), undefined);
  assert.equal(await run.select(), "catchup-4-1733788800");
  await november.control("start");
  assert(await november.acquire("nov-proof"));
  chain.finalized = async () => h(spec.startBlock + 150 * 43200 + 100);
  const novBounds = await prepareCandidate(chain, "catchup-4-1733788800");
  assert.deepEqual(novBounds.captureStart, octBounds.endBefore);
  await assert.rejects(
    november.initialize(
      "nov-proof",
      {
        ...novBounds,
        captureStart: { ...novBounds.captureStart!, hash: h(1).hash },
      },
      targetMetadata,
    ),
    /boundary does not match/,
  );
  const full = fullScope(),
    fullMeta = fullMetadata(targetMetadata);
  await november.initialize("nov-proof", novBounds, fullMeta);
  const fullSamples = awsSampled({
    scope: full,
    metadata: fullMeta,
    table,
    bucket: "local",
    db,
    s3,
  });
  await fullSamples.cursor({
    startTimestamp: novStart,
    nextTimestamp: novStart,
    policyRevision: candidateSpec("catchup-4-1733788800").policyRevision,
    anchor: novBounds.captureStart!,
  });
  await fullSamples.seedOpening(
    reusePreAdmissionSample(target, full, finalEvidence),
  );
  await november.activateAdmission("nov-proof");
  const fullDefinition = (
    await db.send(
      new GetCommand({ TableName: table, Key: datasetKey(full.id) }),
    )
  ).Item;
  assert.equal(decodeDataset(fullDefinition!).history.length, 2);
  const oldDefinition = (await activeAndDefinition())[1];
  assert.deepEqual(oldDefinition, beforeNovember[1]);
  await november.control("pause");
  assert.equal(await november.canContinue("nov-proof"), false);
  await november.control("resume");
  const novResult = await advanceCandidate({
    chunk: "catchup-4-1733788800",
    bounds: novBounds,
    chain,
    archive: awsArchive({ table, bucket: "local", db, s3 }),
    sampled: fullSamples,
    sample: async (t, b, a) => ({
      ...sampledFixture(t, full),
      block: b,
      after: a,
    }),
    aggregate: () =>
      aggregateNext({
        scope: full,
        startBlock: novBounds.captureStart!.number,
        metadata: fullMeta,
        store: awsAggregation({ table, bucket: "local", db, s3 }),
      }),
    aggregationNext: november.aggregationNext,
    canContinue: () => november.canContinue("nov-proof"),
    maxSteps: 6,
  });
  assert.equal(novResult.phase, "yielded");
  assert((await fullSamples.publication())!.nextTimestamp > novStart);
  assert.equal((await fullSamples.collected())!.startTimestamp, novStart);
  assert.equal(
    (
      await awsArchive({ table, bucket: "local", db, s3 }).cursor(
        full.id,
        novBounds.captureStart!.number,
      )
    ).startBlock,
    novBounds.captureStart!.number,
  );

  assert.deepEqual(await october.read(), completedOctober);
  await november.finish("nov-proof", novResult, zero);
  // Undo the transaction fixture's synthetic launch horizon before reader checks;
  // its generation was intentionally not regenerated while seeding checkpoints.
  await db.send(
    new PutCommand({ TableName: table, Item: retainedLaunchPublication! }),
  );
  for (const currency of ["ETH", "USDC"]) {
    for (const from of [spec.from, octStart, novStart]) {
      const q = new URLSearchParams({
        view: "chart",
        series: "market",
        currency,
        resolution: "300",
        from: String(from),
        to: String(from + 300),
      });
      const chart = await call(q);
      assert.equal(chart.upserts.length, 1);
      assert.equal(chart.upserts[0].publicationStatus, "published");
    }
  }
  // Seed aligned completion to test automatic successor admission and final cutoff.
  assert(await november.acquire("nov-complete"));
  for (const key of [cursorKey(full.id), progressKey(full.id)])
    await set(key, "nextBlock", novBounds.end.number + 1);
  for (const kind of ["collected", "published"] as const)
    await set(
      sampledKey(candidateSpec("catchup-4-1733788800").policyRevision, kind),
      "nextTimestamp",
      1733788800,
    );
  await november.finish("nov-complete", { phase: "complete" }, zero);
  await run.control("pause");
  assert.equal(await run.select(), undefined);
  await run.control("resume");
  const lastChunk = "catchup-5-1733875200" as const;
  assert.equal(await run.select(), lastChunk);
  const last = candidateStore(db, table, () => now, lastChunk);
  assert.equal(
    candidateSpec(lastChunk).to - candidateSpec(lastChunk).from,
    86400,
  );
  assert(await last.acquire("last-proof"));
  chain.finalized = async () => h(spec.startBlock + 160 * 43200);
  const lastBounds = await prepareCandidate(chain, lastChunk);
  assert.deepEqual(lastBounds.captureStart, novBounds.captureStart);
  await last.initialize("last-proof", lastBounds, fullMeta);
  await run.control("pause");
  assert.equal(await last.canContinue("last-proof"), false);
  await run.control("resume");
  assert.equal(await last.canContinue("last-proof"), true);
  assert.deepEqual(
    (
      await db.send(
        new GetCommand({ TableName: table, Key: datasetKey(full.id) }),
      )
    ).Item,
    fullDefinition,
  );
  await last.finish("last-proof", { phase: "complete" }, zero);
  assert.equal(await run.select(), undefined);
  assert.equal((await run.read())!.to, 1733875200);
  console.log(
    JSON.stringify({
      proof: "candidate-pipeline",
      retainedHistoryUnchanged: true,
      datedMembershipBoundary: true,
      octoberStartsAtBoundary: true,
      fullRunAdmissionAndFrozenCutoff: true,
      invocations,
      samples,
      oldDayBuckets: 288,
      activityRows: 1,
      currencies: ["ETH", "USDC"],
      frozenSpecGuard: true,
      continuationTransactions: true,
      lostUploadResponse: true,
      leaseRecovery: true,
      pauseResume: true,
      parquet: true,
      availability,
      awsWrites: 0,
      rpcCalls: 0,
    }),
  );
} finally {
  await client.send(new DeleteTableCommand({ TableName: table }));
  client.destroy();
  s3.destroy();
}
