/** Synthetic 288-bucket publication comparison. Never reads/writes a real dataset.
 * Default: DynamoDB Local. --aws-profile PROFILE creates/deletes a dedicated
 * FameHistoryCandidate-benchmark-* table and records actual returned capacity.
 * Raw capture, sampling and activity indexing are preseeded and excluded. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { awsSampled } from "../../src/fame-market-history/sampled-storage.ts";
import { fullScope } from "../../src/fame-market-history/full-scope.ts";
import { sampledFixture } from "../../src/fame-market-history/sampled-fixture.ts";
import { deriveSampledObservation } from "../../src/fame-market-history/sampled-rpc.ts";
import {
  sampledMarketBucket,
  sampledPolicy,
} from "../../src/fame-market-history/sampled-market.ts";
import {
  nextSampledPublication,
  type SampledPublication,
} from "../../src/fame-market-history/sampled-live.ts";
import { sampledKey } from "../../src/fame-market-history/keys.ts";
import { digest } from "../../src/fame-market-history/model.ts";
import { writeActivity } from "../../src/fame-market-history/activity-storage.ts";
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--aws-profile"))
  throw new Error("Use --aws-profile PROFILE or no arguments for local");
let config: ConstructorParameters<typeof DynamoDBClient>[0] = {
  region: "us-west-1",
  endpoint: "http://127.0.0.1:18001",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
};
if (args.length) {
  const aws = (a: string[]) =>
    JSON.parse(
      execFileSync(
        "aws",
        [
          ...a,
          "--profile",
          args[1],
          "--region",
          "us-west-1",
          "--output",
          "json",
        ],
        { encoding: "utf8" },
      ),
    );
  assert.equal(aws(["sts", "get-caller-identity"]).Account, "590183914614");
  const c = aws(["configure", "export-credentials", "--format", "process"]);
  config = {
    region: "us-west-1",
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    },
  };
}
if (process.env.AWS_ENDPOINT_URL || process.env.AWS_ENDPOINT_URL_DYNAMODB)
  throw new Error("Unexpected endpoint override");
const client = new DynamoDBClient({ ...config, maxAttempts: 10 }),
  db = DynamoDBDocumentClient.from(client);
const scope = fullScope(),
  revision = sampledPolicy(scope).revision;
// Cross a UTC day boundary as well as growing the rolling window to 288 entries.
const start = 1791849600 - 1800;
const entries = Array.from({ length: 288 }, (_, i) => {
  const evidence = sampledFixture(start + i * 300, scope);
  evidence.block.number = 50000000 + i * 150;
  evidence.after.number = evidence.block.number + 1;
  const o = deriveSampledObservation(scope, evidence);
  return {
    evidence,
    buckets: (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(scope, c, evidence.timestamp, o, []),
    ),
  };
});
const results = [];
for (const size of [1, 12]) {
  const table = `FameHistoryCandidate-benchmark-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
    }),
  );
  try {
    await waitUntilTableExists(
      { client, maxWaitTime: 60 },
      { TableName: table },
    );
    for (let offset = 0; offset < entries.length; offset += 16) {
      await Promise.all(
        entries.slice(offset, offset + 16).map(async (e) => {
          await db.send(
            new PutCommand({
              TableName: table,
              Item: {
                ...sampledKey(revision, `observation:${e.evidence.timestamp}`),
                sha256: digest(JSON.stringify(e.evidence)),
              },
            }),
          );
          await writeActivity(
            db,
            table,
            revision,
            nextSampledPublication(null, e.evidence, e.buckets).pages[0],
            [],
            "complete",
          );
        }),
      );
    }
    const store = awsSampled({ scope, table, bucket: "unused", db });
    const send = db.send.bind(db);
    let completeCapacityBreakdown = true;
    let writeUnits = 0,
      readUnits = 0,
      calls = 0;
    db.send = (async (command: any) => {
      command.input.ReturnConsumedCapacity = "TOTAL";
      const result: any = await send(command);
      const capacity = result.ConsumedCapacity
        ? Array.isArray(result.ConsumedCapacity)
          ? result.ConsumedCapacity
          : [result.ConsumedCapacity]
        : [];
      for (const c of capacity) {
        if (command instanceof TransactWriteCommand) {
          if (c.WriteCapacityUnits === undefined)
            completeCapacityBreakdown = false;
          writeUnits += c.WriteCapacityUnits ?? 0;
          readUnits += c.ReadCapacityUnits ?? 0;
        } else if (command instanceof PutCommand)
          writeUnits += c.CapacityUnits ?? 0;
        else readUnits += c.CapacityUnits ?? 0;
      }
      calls++;
      return result;
    }) as typeof db.send;
    // Real transaction fault probes on local only; AWS measurements stay clean.
    if (size === 12 && !args.length) {
      const measuredSend = db.send.bind(db);
      const part = entries.slice(0, 12);
      db.send = (async (command: any) => {
        if (command instanceof TransactWriteCommand)
          throw new Error("injected before CAS");
        return measuredSend(command);
      }) as typeof db.send;
      await assert.rejects(store.publishGroup!(null, part), /injected/);
      assert.equal(
        await store.publication(),
        null,
        "staging must not expose pages",
      );
      db.send = measuredSend;
      const corruptKey = sampledKey(
        revision,
        `observation:${part[0].evidence.timestamp}`,
      );
      await db.send(
        new PutCommand({
          TableName: table,
          Item: { ...corruptKey, sha256: "bad" },
        }),
      );
      await assert.rejects(store.publishGroup!(null, part));
      assert.equal(
        await store.publication(),
        null,
        "observation integrity guard must fail atomically",
      );
      await db.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...corruptKey,
            sha256: digest(JSON.stringify(part[0].evidence)),
          },
        }),
      );
      db.send = (async (command: any) => {
        const result = await measuredSend(command);
        if (command instanceof TransactWriteCommand)
          throw new Error("injected lost commit response");
        return result;
      }) as typeof db.send;
      await assert.rejects(store.publishGroup!(null, part), /lost commit/);
      db.send = measuredSend;
      assert.equal(
        (await store.publication())?.nextTimestamp,
        part.at(-1)!.evidence.timestamp + 300,
      );
      await assert.rejects(
        store.publishGroup!(null, part),
        "stale writer must not reset pointer",
      );
    }
    let prior: SampledPublication | null = null;
    for (let i = 0; i < entries.length; i += size) {
      const part = entries.slice(i, i + size);
      if (size === 12 && !args.length && i === 0) {
        // Already committed by the lost-response probe; resume from durable state.
      } else if (size === 1)
        await store.publish(prior, part[0].evidence, part[0].buckets);
      else await store.publishGroup!(prior, part);
      for (const e of part)
        prior = nextSampledPublication(prior, e.evidence, e.buckets);
      assert.deepEqual(await store.publication(), prior);
    }
    results.push({
      groupSize: size,
      buckets: 288,
      writeUnits: completeCapacityBreakdown ? writeUnits : null,
      readUnits: completeCapacityBreakdown ? readUnits : null,
      calls,
      generation: prior!.generation,
    });
    console.log(JSON.stringify({ measurement: results.at(-1) }));
    db.send = send;
  } finally {
    await client.send(new DeleteTableCommand({ TableName: table }));
  }
}
assert.equal(results[0].generation, results[1].generation);
console.log(
  JSON.stringify(
    {
      service: args.length
        ? "AWS DynamoDB"
        : "DynamoDB Local (not billing evidence)",
      scope:
        "publication only, synthetic eight-pool day; excludes preseeded raw/sample/activity writes",
      results,
    },
    null,
    2,
  ),
);
client.destroy();
