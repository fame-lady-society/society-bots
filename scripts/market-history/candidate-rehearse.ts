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
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
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
import { launchScope } from "../../src/fame-market-history/local-backfill.ts";
import { awsArchive } from "../../src/fame-market-history/storage.ts";
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
  console.log(
    JSON.stringify({
      proof: "candidate-pipeline",
      invocations,
      samples,
      oldDayBuckets: 288,
      activityRows: 1,
      currencies: ["ETH", "USDC"],
      frozenSpecGuard: true,
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
