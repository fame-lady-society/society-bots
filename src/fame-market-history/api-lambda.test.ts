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
    .mockResolvedValueOnce({
      Responses: [{ Item: nextSampledPublication(null, e, buckets) }],
    } as never)
    .mockResolvedValueOnce({
      Responses: [{ Item: { body: JSON.stringify(buckets[1]) } }],
    } as never);
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
