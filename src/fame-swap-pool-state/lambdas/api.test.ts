import { describe, expect, jest, test } from "@jest/globals";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type {
  FamePoolQuoteBatchHandler,
  FamePoolStateBatchHandler,
} from "./api.ts";

function eventFixture({
  body,
  headers = { authorization: "Bearer unit-token" },
  path = "/fame/pool-state",
}: {
  body?: string;
  headers?: Record<string, string | undefined>;
  path?: "/fame/pool-state" | "/fame/pool-quotes";
}): APIGatewayProxyEventV2 {
  const routeKey = `POST ${path}`;
  return {
    version: "2.0",
    routeKey,
    rawPath: path,
    rawQueryString: "",
    headers,
    requestContext: {
      accountId: "unit",
      apiId: "unit",
      domainName: "api.example",
      domainPrefix: "api",
      http: {
        method: "POST",
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "jest",
      },
      requestId: "unit",
      routeKey,
      stage: "$default",
      time: "18/May/2026:00:00:00 +0000",
      timeEpoch: 1_779_062_400_000,
    },
    body,
    isBase64Encoded: false,
  };
}

function structuredResponse(
  response: APIGatewayProxyResultV2,
): APIGatewayProxyStructuredResultV2 {
  if (
    typeof response !== "object" ||
    response === null ||
    !("statusCode" in response)
  ) {
    throw new Error("Expected structured API Gateway response.");
  }
  return response;
}

function jsonBody(response: APIGatewayProxyResultV2): Record<string, unknown> {
  const structured = structuredResponse(response);
  if (typeof structured.body !== "string") {
    throw new Error("Expected JSON API Gateway response.");
  }
  const parsed: unknown = JSON.parse(structured.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object response body.");
  }
  return parsed as Record<string, unknown>;
}

async function loadApiModule(): Promise<typeof import("./api.ts")> {
  jest.resetModules();
  process.env.FAME_POOL_STATE_TABLE_NAME = "PoolState";
  process.env.FAME_POOL_STATE_SERVICE_TOKEN = "unit-token";
  return import("./api.ts");
}

async function requestHandler(
  handler: FamePoolStateBatchHandler,
  event: APIGatewayProxyEventV2,
  quoteHandler?: FamePoolQuoteBatchHandler,
): Promise<APIGatewayProxyResultV2> {
  const { handleFamePoolStateApiEvent } = await loadApiModule();
  return handleFamePoolStateApiEvent({
    event,
    serviceToken: "unit-token",
    tableName: "PoolState",
    producerMaxFreshnessBlocks: 120,
    maxBatchSize: 64,
    handleBatchRequest: handler,
    ...(quoteHandler === undefined
      ? {}
      : { handleQuoteBatchRequest: quoteHandler }),
  });
}

describe("FAME pool-state API Lambda transport", () => {
  test("returns request failure for malformed JSON without calling DynamoDB", async () => {
    let called = false;
    const response = await requestHandler(
      async () => {
        called = true;
        throw new Error("should not call batch handler");
      },
      eventFixture({ body: "{" }),
    );

    expect(structuredResponse(response).statusCode).toBe(400);
    expect(jsonBody(response)).toMatchObject({
      error: "invalid-request",
      message: expect.stringContaining("expected valid JSON"),
    });
    expect(called).toBe(false);
  });

  test("returns request failure for structurally invalid payload", async () => {
    const { handleFamePoolStateApiEvent } = await loadApiModule();
    const response = await handleFamePoolStateApiEvent({
      event: eventFixture({
        body: JSON.stringify({
          currentBlock: 125,
          pools: "bad",
        }),
      }),
      serviceToken: "unit-token",
      tableName: "PoolState",
      producerMaxFreshnessBlocks: 120,
      maxBatchSize: 64,
    });

    expect(structuredResponse(response).statusCode).toBe(400);
    expect(jsonBody(response)).toMatchObject({
      error: "invalid-request",
      message: expect.stringContaining("$.pools"),
    });
  });

  test("returns unauthorized before batch handling", async () => {
    let called = false;
    const response = await requestHandler(
      async () => {
        called = true;
        throw new Error("should not call batch handler");
      },
      eventFixture({
        body: JSON.stringify({
          currentBlock: 125,
          pools: [],
        }),
        headers: {},
      }),
    );

    expect(structuredResponse(response).statusCode).toBe(401);
    expect(jsonBody(response)).toEqual({ error: "unauthorized" });
    expect(called).toBe(false);
  });

  test("dispatches pool quote requests to the compact quote handler", async () => {
    const successLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });
    let stateCalled = false;
    let capturedQuoteRequest: unknown;
    try {
      const response = await requestHandler(
        async () => {
          stateCalled = true;
          throw new Error("should not call state handler");
        },
        eventFixture({
          path: "/fame/pool-quotes",
          body: JSON.stringify({
            currentBlock: 125,
            quotes: [],
          }),
        }),
        async (options) => {
          capturedQuoteRequest = options.request;
          return {
            sourceRegistryId: "unit",
            currentBlock: 125,
            producerMaxFreshnessBlocks: 120,
            effectiveMaxFreshnessBlocks: 120,
            quotes: [
              {
                status: "unavailable",
                requested: {
                  poolId: "missing",
                  tokenIn: "0x0000000000000000000000000000000000000001",
                  tokenOut: "0x0000000000000000000000000000000000000002",
                  amountIn: "1",
                },
                reason: "missing-registry-entry",
              },
            ],
          };
        },
      );

      expect(structuredResponse(response).statusCode).toBe(200);
      expect(jsonBody(response)).toMatchObject({
        sourceRegistryId: "unit",
        quotes: [expect.objectContaining({ status: "unavailable" })],
      });
      expect(stateCalled).toBe(false);
      expect(capturedQuoteRequest).toEqual({
        currentBlock: 125,
        quotes: [],
      });
      expect(successLog).toHaveBeenCalledWith(
        expect.stringContaining('"routeKind":"pool-quotes"'),
      );
      expect(successLog).toHaveBeenCalledWith(
        expect.stringContaining('"missing-registry-entry":1'),
      );
    } finally {
      successLog.mockRestore();
    }
  });

  test("logs successful pool-state batches", async () => {
    const successLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });
    try {
      const response = await requestHandler(
        async () => ({
          sourceRegistryId: "unit",
          currentBlock: 125,
          producerMaxFreshnessBlocks: 120,
          effectiveMaxFreshnessBlocks: 120,
          pools: [
            {
              status: "unknown",
              requested: { poolId: "missing" },
              reason: "missing-registry-entry",
            },
          ],
        }),
        eventFixture({
          body: JSON.stringify({
            currentBlock: 125,
            pools: [],
          }),
        }),
      );

      expect(structuredResponse(response).statusCode).toBe(200);
      expect(successLog).toHaveBeenCalledWith(
        expect.stringContaining('"routeKind":"pool-state"'),
      );
      expect(successLog).toHaveBeenCalledWith(
        expect.stringContaining('"unknown":1'),
      );
    } finally {
      successLog.mockRestore();
    }
  });

  test("returns server failure for dependency errors", async () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });

    try {
      const response = await requestHandler(
        async () => {
          throw new Error("DynamoDB unavailable");
        },
        eventFixture({
          body: JSON.stringify({
            currentBlock: 125,
            pools: [],
          }),
        }),
      );

      expect(structuredResponse(response).statusCode).toBe(500);
      expect(jsonBody(response)).toEqual({ error: "internal-error" });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("fame-pool-state-api-error"),
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});
