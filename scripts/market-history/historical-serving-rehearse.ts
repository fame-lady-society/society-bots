/** Read-only AWS archives -> disposable DynamoDB Local -> actual API handler over HTTP.
 * No RPC, remote writes, or live cursor updates. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import { sampledPolicy } from "../../src/fame-market-history/sampled-market.ts";
import { sampledKey } from "../../src/fame-market-history/keys.ts";
import { materializeHistory } from "../../src/fame-market-history/materialize-history.ts";
const [directory] = process.argv.slice(2);
const sourceTable = process.env.FAME_HISTORY_TABLE,
  bucket = process.env.FAME_HISTORY_BUCKET;
if (!directory || process.argv.length !== 3 || !sourceTable || !bucket)
  throw new Error("Expected output directory and storage environment");
const endpoint = new URL(
  process.env.FAME_HISTORY_DYNAMODB_ENDPOINT ?? "http://127.0.0.1:18001",
);
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1")
  throw new Error("Rehearsal target must be loopback DynamoDB Local");
const source = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 2 }),
);
const s3 = new S3Client({ maxAttempts: 2 });
const client = new DynamoDBClient({
  endpoint: endpoint.href,
  region: "us-west-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const local = DynamoDBDocumentClient.from(client),
  table = `historical-${randomUUID()}`;
const scope = historyScope(famePoolStateRegistry),
  revision = sampledPolicy(scope).revision;
const metadata = JSON.parse(
  await readFile(
    new URL(
      "../../src/fame-market-history/token-metadata.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const from = Number(process.env.FAME_HISTORY_FROM),
  to = Number(process.env.FAME_HISTORY_TO);
let sourceReads = 0;
const db = {
  send: async (command: any) => {
    if (command instanceof QueryCommand) {
      sourceReads++;
      return source.send(
        new QueryCommand({ ...command.input, TableName: sourceTable }),
      );
    }
    if (
      command instanceof GetCommand &&
      command.input.Key?.sk?.startsWith("observation:")
    ) {
      const cached = await local.send(command);
      if (cached.Item) return cached;
      sourceReads++;
      const result = await source.send(
        new GetCommand({ ...command.input, TableName: sourceTable }),
      );
      if (result.Item)
        await local.send(
          new PutCommand({ TableName: table, Item: result.Item }),
        );
      return result;
    }
    return local.send(command);
  },
} as unknown as DynamoDBDocumentClient;
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
let server: ReturnType<typeof createServer> | undefined;
try {
  const live = await source.send(
    new GetCommand({
      TableName: sourceTable,
      Key: sampledKey(revision, "published"),
      ConsistentRead: true,
    }),
  );
  assert(live.Item);
  await local.send(new PutCommand({ TableName: table, Item: live.Item }));
  const receipt = await materializeHistory({
    scope,
    metadata,
    db,
    s3,
    table,
    bucket,
    from,
    to,
    apply: true,
    progress: (row) => console.log(JSON.stringify(row)),
  });
  assert(
    receipt.rows.some((r) => r.status === "published"),
    "No retained buckets recovered",
  );
  // Handler uses the ordinary SDK, directed to this local database only.
  process.env.AWS_ENDPOINT_URL_DYNAMODB = endpoint.href;
  process.env.FAME_HISTORY_TABLE = table;
  const { handler } = await import(
    "../../src/fame-market-history/api-lambda.ts"
  );
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const result = await handler({
      rawQueryString: url.search.slice(1),
      headers: req.headers,
      requestContext: { http: { method: req.method } },
    } as any);
    res.writeHead(result.statusCode, result.headers);
    res.end(
      result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/fame/history`;
  const results = [];
  for (const currency of ["ETH", "USDC"]) {
    const query = new URLSearchParams({
      view: "chart",
      resolution: "300",
      currency,
      series: "market",
      from: String(from),
      to: String(to),
    });
    const response = await fetch(`${url}?${query}`);
    assert.equal(
      response.status,
      200,
      response.status === 200 ? "" : await response.text(),
    );
    const chart = (await response.json()) as any;
    assert.equal(chart.upserts.length, (to - from) / 300);
    const published = chart.upserts.filter(
      (b: any) => b.publicationStatus === "published",
    );
    assert.equal(
      published.length,
      receipt.rows.filter((r) => r.status === "published").length,
    );
    assert(published.some((b: any) => b.price !== null));
    const cached = await fetch(`${url}?${query}`, {
      headers: { "if-none-match": response.headers.get("etag")! },
    });
    assert.equal(cached.status, 304);
    query.set("cursor", chart.cursor);
    const delta = (await (await fetch(`${url}?${query}`)).json()) as any;
    assert.deepEqual(delta.upserts, []);
    const activityQuery = new URLSearchParams({
      view: "activity",
      resolution: "300",
      currency,
      from: String(from),
      to: String(to),
      limit: "100",
    });
    const events: any[] = [];
    let calls = 0;
    do {
      const r = await fetch(`${url}?${activityQuery}`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as any;
      events.push(...body.rows);
      calls++;
      if (!body.nextCursor) break;
      assert(calls < 100, "Pagination failed to terminate");
      activityQuery.set("cursor", body.nextCursor);
    } while (true);
    assert.equal(
      new Set(events.map((e) => e.id)).size,
      events.length,
      "Duplicate activity rows",
    );
    assert.equal(
      events.filter((e) => e.type === "buy" || e.type === "sell").length,
      published.reduce((sum: number, b: any) => sum + (b.tradeCount ?? 0), 0),
      "Chart trade count differs from transaction list",
    );
    const filter = new URLSearchParams({
      view: "activity",
      resolution: "300",
      currency,
      from: String(from),
      to: String(to),
      type: "buy",
      min: "0",
      limit: "100",
    });
    const filtered: any[] = [];
    let filterCalls = 0;
    do {
      const r = await fetch(`${url}?${filter}`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as any;
      filtered.push(...body.rows);
      if (!body.nextCursor) break;
      assert(++filterCalls < 100);
      filter.set("cursor", body.nextCursor);
    } while (true);
    assert.deepEqual(
      filtered.map((e) => e.id),
      events
        .filter((e) => e.type === "buy" && e.size !== null)
        .map((e) => e.id),
    );
    results.push({
      currency,
      buckets: published.length,
      candles: published.filter((b: any) => b.candle !== null).length,
      events: events.length,
      pages: calls,
      gzip: response.headers.get("content-encoding"),
      cacheStatus: cached.status,
      delta: delta.upserts.length,
    });
  }
  assert.deepEqual(
    (
      await local.send(
        new GetCommand({
          TableName: table,
          Key: sampledKey(revision, "published"),
        }),
      )
    ).Item,
    live.Item,
    "Live pointer changed",
  );
  const output = { ...receipt, sourceReads, results, productionWrites: 0 };
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "historical-serving-rehearsal.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify({ ...output, rows: receipt.rows.length }));
} finally {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((e) => (e ? reject(e) : resolve())),
    );
  await client.send(new DeleteTableCommand({ TableName: table }));
}
