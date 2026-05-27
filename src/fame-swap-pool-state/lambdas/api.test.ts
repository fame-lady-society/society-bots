import { describe, expect, jest, test } from "@jest/globals";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { Address, Hex } from "viem";
import type { FamePoolStateBatchResponse } from "../api.ts";
import type {
  FamePoolQuoteBatchHandler,
  FamePoolStateBatchHandler,
} from "./api.ts";

const ADDRESS_A = "0x0000000000000000000000000000000000000001" as Address;
const ADDRESS_B = "0x0000000000000000000000000000000000000002" as Address;
const HEX_32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

function eventFixture({
  body,
  headers = { authorization: "Bearer unit-token" },
  path = "/fame/pool-state",
}: {
  body?: string;
  headers?: Record<string, string | undefined>;
  path?: string;
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

function parseLogLine(line: unknown): Record<string, unknown> {
  if (typeof line !== "string") throw new Error("Expected a log string.");
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object log line.");
  }
  return parsed as Record<string, unknown>;
}

function freshReserveBatchResponse(): FamePoolStateBatchResponse {
  return {
    sourceRegistryId: "registry",
    currentBlock: 125,
    producerMaxFreshnessBlocks: 120,
    effectiveMaxFreshnessBlocks: 120,
    pools: [
      {
        status: "fresh",
        poolId: "constant-product-pool",
        chainId: 8453,
        poolAddress: ADDRESS_A,
        token0: ADDRESS_A,
        token1: ADDRESS_B,
        reserve0: "100",
        reserve1: "200",
        k: "20000",
        observedThroughBlock: 124,
        lastReserveChangeBlock: 123,
        source: "getReserves",
        quoteModel: "constant-product-reserves",
        maxFreshnessBlocks: 120,
      },
    ],
  };
}

function freshReplayBatchResponse(): FamePoolStateBatchResponse {
  return {
    sourceRegistryId: "registry",
    currentBlock: 125,
    producerMaxFreshnessBlocks: 120,
    effectiveMaxFreshnessBlocks: 120,
    pools: [
      {
        status: "fresh",
        stateKind: "cl-replay-v1",
        poolId: "slipstream-usdc-weth-100",
        chainId: 8453,
        poolAddress: ADDRESS_A,
        token0: ADDRESS_A,
        token1: ADDRESS_B,
        venueFamily: "Slipstream",
        tickSpacing: 1,
        sqrtPriceX96: "100",
        tick: 1,
        liquidity: "1000",
        fee: "100",
        feeSource: "pool-fee",
        observedThroughBlock: 124,
        blockHash: HEX_32,
        parentHash: HEX_32,
        snapshotId: "cl-replay-v1:slipstream-usdc-weth-100:124",
        stateHash: HEX_32,
        source: "slipstream-pool-state",
        sourceRegistryId: "registry",
        maxFreshnessBlocks: 120,
        bitmapWordCount: 2,
        initializedTickCount: 3,
        bitmapChunkCount: 1,
        tickChunkCount: 1,
        minWordPosition: -1,
        maxWordPosition: 1,
        minTick: -100,
        maxTick: 100,
        bitmapWords: [
          {
            wordPosition: 0,
            bitmap: HEX_32,
          },
        ],
        initializedTicks: [
          {
            tick: -100,
            liquidityGross: "1",
            liquidityNet: "1",
          },
        ],
      },
    ],
  };
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
    const warnLog = jest.spyOn(console, "warn").mockImplementation(() => {
      return undefined;
    });
    let called = false;

    try {
      const response = await requestHandler(
        async () => {
          called = true;
          throw new Error("should not call batch handler");
        },
        eventFixture({ body: '{"secret":"do-not-log"' }),
      );

      expect(structuredResponse(response).statusCode).toBe(400);
      expect(jsonBody(response)).toMatchObject({
        error: "invalid-request",
        message: expect.stringContaining("expected valid JSON"),
      });
      expect(called).toBe(false);
      expect(warnLog).toHaveBeenCalledTimes(1);
      const entry = parseLogLine(warnLog.mock.calls[0]?.[0]);
      expect(entry).toMatchObject({
        level: "warn",
        event: "fame-pool-state-api-error",
        errorType: "invalid-request",
      });
      expect(warnLog.mock.calls[0]?.[0]).not.toContain("do-not-log");
    } finally {
      warnLog.mockRestore();
    }
  });

  test("returns request failure for structurally invalid payload", async () => {
    const { handleFamePoolStateApiEvent } = await loadApiModule();
    const warnLog = jest.spyOn(console, "warn").mockImplementation(() => {
      return undefined;
    });

    try {
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
    } finally {
      warnLog.mockRestore();
    }
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

  test("rejects unknown routes without dispatching to pool-state handling", async () => {
    const warnLog = jest.spyOn(console, "warn").mockImplementation(() => {
      return undefined;
    });
    let stateCalled = false;
    let quoteCalled = false;

    try {
      const response = await requestHandler(
        async () => {
          stateCalled = true;
          throw new Error("should not call state handler");
        },
        eventFixture({
          path: "/fame/not-a-route",
          body: JSON.stringify({
            currentBlock: 125,
            pools: [],
          }),
        }),
        async () => {
          quoteCalled = true;
          throw new Error("should not call quote handler");
        },
      );

      expect(structuredResponse(response).statusCode).toBe(400);
      expect(jsonBody(response)).toMatchObject({
        error: "invalid-request",
        message: expect.stringContaining("/fame/not-a-route"),
      });
      expect(stateCalled).toBe(false);
      expect(quoteCalled).toBe(false);
      expect(warnLog).toHaveBeenCalledTimes(1);
      expect(parseLogLine(warnLog.mock.calls[0]?.[0])).toMatchObject({
        level: "warn",
        event: "fame-pool-state-api-error",
        errorType: "invalid-request",
        message: expect.stringContaining("routeKind"),
      });
    } finally {
      warnLog.mockRestore();
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
      expect(errorLog).toHaveBeenCalledTimes(1);
      const entry = parseLogLine(errorLog.mock.calls[0]?.[0]);
      expect(entry).toMatchObject({
        level: "error",
        event: "fame-pool-state-api-error",
        errorType: "dependency",
        message: "DynamoDB unavailable",
      });
      expect(errorLog.mock.calls[0]?.[0]).not.toContain("currentBlock");
    } finally {
      errorLog.mockRestore();
    }
  });

  test("does not log ordinary all-fresh non-replay success batches", async () => {
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      const response = await requestHandler(
        async () => freshReserveBatchResponse(),
        eventFixture({
          body: JSON.stringify({
            currentBlock: 125,
            pools: [{ poolId: "constant-product-pool" }],
          }),
        }),
      );

      expect(structuredResponse(response).statusCode).toBe(200);
      expect(infoLog).not.toHaveBeenCalled();
    } finally {
      infoLog.mockRestore();
    }
  });

  test("logs compact replay success batches without raw tick payloads", async () => {
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      const response = await requestHandler(
        async () => freshReplayBatchResponse(),
        eventFixture({
          body: JSON.stringify({
            currentBlock: 125,
            stateSurfaces: ["cl-replay-v1"],
            pools: [{ poolId: "slipstream-usdc-weth-100" }],
          }),
        }),
      );

      expect(structuredResponse(response).statusCode).toBe(200);
      expect(infoLog).toHaveBeenCalledTimes(1);
      const line = infoLog.mock.calls[0]?.[0];
      expect(line).not.toContain("bitmapWords");
      expect(line).not.toContain("initializedTicks");
      expect(parseLogLine(line)).toMatchObject({
        level: "info",
        event: "fame-pool-state-api-batch",
        clReplay: {
          returned: 1,
          fresh: 1,
          bitmapWordCount: 2,
          initializedTickCount: 3,
        },
      });
    } finally {
      infoLog.mockRestore();
    }
  });
});
