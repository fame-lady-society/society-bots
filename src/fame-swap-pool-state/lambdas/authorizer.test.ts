import { describe, expect, jest, test } from "@jest/globals";
import type {
  APIGatewayRequestAuthorizerEventV2,
  Callback,
  Context,
} from "aws-lambda";

function eventFixture(
  headers: Record<string, string | undefined>,
): APIGatewayRequestAuthorizerEventV2 {
  return {
    version: "2.0",
    type: "REQUEST",
    routeArn:
      "arn:aws:execute-api:us-west-1:123456789012:api/$default/POST/fame/pool-state",
    identitySource: [],
    routeKey: "POST /fame/pool-state",
    rawPath: "/fame/pool-state",
    rawQueryString: "",
    cookies: [],
    headers,
    requestContext: {
      accountId: "unit",
      apiId: "unit",
      domainName: "api.example",
      domainPrefix: "api",
      http: {
        method: "POST",
        path: "/fame/pool-state",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "jest",
      },
      requestId: "unit",
      routeKey: "POST /fame/pool-state",
      stage: "$default",
      time: "18/May/2026:00:00:00 +0000",
      timeEpoch: 1_779_062_400_000,
    },
  };
}

async function loadAuthorizerModule(): Promise<
  typeof import("./authorizer.ts")
> {
  jest.resetModules();
  process.env.FAME_POOL_STATE_SERVICE_TOKEN = "unit-token";
  return import("./authorizer.ts");
}

const context: Context = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "unit",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-west-1:123456789012:function:unit",
  memoryLimitInMB: "128",
  awsRequestId: "unit",
  logGroupName: "/aws/lambda/unit",
  logStreamName: "unit",
  getRemainingTimeInMillis: () => 1_000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined,
};

const callback: Callback = () => undefined;

describe("FAME pool-state API Gateway authorizer", () => {
  test("authorizes bearer tokens from the Authorization header", async () => {
    const { handler } = await loadAuthorizerModule();

    await expect(
      handler(
        eventFixture({ authorization: "Bearer unit-token" }),
        context,
        callback,
      ),
    ).resolves.toEqual({ isAuthorized: true });
    await expect(
      handler(
        eventFixture({ Authorization: "Bearer unit-token" }),
        context,
        callback,
      ),
    ).resolves.toEqual({ isAuthorized: true });
    await expect(
      handler(
        eventFixture({ "x-fame-pool-state-token": "unit-token" }),
        context,
        callback,
      ),
    ).resolves.toEqual({ isAuthorized: false });
  });

  test("rejects missing or incorrect tokens", async () => {
    const { handler } = await loadAuthorizerModule();

    await expect(handler(eventFixture({}), context, callback)).resolves.toEqual(
      { isAuthorized: false },
    );
    await expect(
      handler(
        eventFixture({ authorization: "Bearer wrong" }),
        context,
        callback,
      ),
    ).resolves.toEqual({ isAuthorized: false });
  });
});
