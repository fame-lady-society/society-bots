import { jest, afterEach } from "@jest/globals";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "./api-lambda.ts";
const originalTable = process.env.FAME_HISTORY_TABLE;
afterEach(() => {
  jest.restoreAllMocks();
  if (originalTable === undefined) delete process.env.FAME_HISTORY_TABLE;
  else process.env.FAME_HISTORY_TABLE = originalTable;
});
const event = (query: string, body?: string) =>
  ({
    rawQueryString: query,
    body,
    requestContext: { http: { method: "GET" } },
  }) as APIGatewayProxyEventV2;
test("malformed queries and request bodies never access storage", async () => {
  const send = jest
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockRejectedValue(new Error("must not read") as never);
  for (const request of [
    event("view=market&from=0&to=300&resolution=300&from=0"),
    event("view=market&from=0&to=300&resolution=300", "{}"),
    event("view=sampled-market&currency=USD&from=0&to=300&resolution=300"),
    event(
      "view=sampled-market&currency=ETH&currency=USDC&from=0&to=300&resolution=300",
    ),
  ])
    expect((await handler(request)).statusCode).toBe(400);
  expect(send).not.toHaveBeenCalled();
});
test("SDK failure messages never escape through HTTP or logs", async () => {
  process.env.FAME_HISTORY_TABLE = "test";
  jest
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockRejectedValue(new Error("secret provider detail") as never);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const response = await handler(
    event("view=market&from=0&to=300&resolution=300"),
  );
  expect(response).toMatchObject({
    statusCode: 503,
    headers: { "cache-control": "private, no-store" },
    body: JSON.stringify({ error: "history-unavailable" }),
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});

test("sampled view routes to published DynamoDB pages without changing the old market contract", async () => {
  const { scope, epoch } = await import("./worker-fixture.ts");
  const { sampledFixture } = await import("./sampled-fixture.ts");
  const { deriveSampledObservation } = await import("./sampled-rpc.ts");
  const { sampledMarketBucket } = await import("./sampled-market.ts");
  const { nextSampledPublication } = await import("./sampled-live.ts");
  const e = sampledFixture(),
    o = deriveSampledObservation(scope, e);
  const buckets = (["ETH", "USDC"] as const).map((c) =>
    sampledMarketBucket(scope, c, epoch, o, []),
  );
  process.env.FAME_HISTORY_TABLE = "test";
  const send = jest
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockImplementation(async (command: any) =>
      command.input.Key
        ? { Item: nextSampledPublication(null, e, buckets) }
        : ({
            Responses: {
              test: command.input.RequestItems.test.Keys.map((Key: any) => ({
                ...Key,
                body: JSON.stringify(buckets[1]),
              })),
            },
          } as never),
    );
  const r = await handler(
    event(
      `view=sampled-market&currency=USDC&resolution=300&from=${epoch}&to=${epoch + 300}`,
    ),
  );
  expect(r.statusCode).toBe(200);
  expect(JSON.parse(r.body)).toMatchObject({
    version: "fame-market-api-v2",
    currency: "USDC",
  });
  expect(send).toHaveBeenCalledTimes(2);
});

test("chart HTTP negotiates gzip, snapshots revalidate before page reads, and deltas remain explicit", async () => {
  const { gunzipSync } = await import("node:zlib");
  const { scope, epoch } = await import("./worker-fixture.ts");
  const { sampledFixture } = await import("./sampled-fixture.ts");
  const { sampledMarketBucket } = await import("./sampled-market.ts");
  const { deriveSampledObservation } = await import("./sampled-rpc.ts");
  const { nextSampledPublication } = await import("./sampled-live.ts");
  const e = sampledFixture(),
    o = deriveSampledObservation(scope, e);
  const rows = (["ETH", "USDC"] as const).map((c) =>
    sampledMarketBucket(scope, c, epoch, o, []),
  );
  const p = nextSampledPublication(null, e, rows);
  process.env.FAME_HISTORY_TABLE = "test";
  let pageReads = 0;
  jest
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockImplementation(async (command: any) => {
      if (command.input.Key) return { Item: p } as never;
      pageReads++;
      return {
        Responses: {
          test: command.input.RequestItems.test.Keys.map((Key: any) => ({
            ...Key,
            body: JSON.stringify(rows[1]),
          })),
        },
      } as never;
    });
  const q = `view=chart&currency=USDC&series=market&resolution=300&from=${epoch}&to=${epoch + 300}`;
  const request = { ...event(q), headers: { "accept-encoding": "gzip" } };
  const r = await handler(request);
  expect(r.statusCode).toBe(200);
  expect(r).toHaveProperty("isBase64Encoded", true);
  const body = JSON.parse(gunzipSync(Buffer.from(r.body, "base64")).toString());
  expect(body.mode).toBe("snapshot");
  expect(pageReads).toBe(1);
  const etag = (r.headers as Record<string, string>).etag;
  const cached = await handler({
    ...request,
    headers: { "if-none-match": etag },
  });
  expect(cached.statusCode).toBe(304);
  expect(cached.body).toBe("");
  expect(pageReads).toBe(1);
  const delta = await handler({
    ...event(q + `&cursor=${body.cursor}`),
    headers: { "if-none-match": etag },
  });
  expect(delta.statusCode).toBe(200);
  expect(JSON.parse(delta.body).upserts).toEqual([]);
  expect(pageReads).toBe(1);
  const identity = await handler({
    ...request,
    headers: { "accept-encoding": "gzip;q=0" },
  });
  expect(identity).not.toHaveProperty("isBase64Encoded");
});
