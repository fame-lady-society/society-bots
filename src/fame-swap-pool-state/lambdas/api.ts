import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS,
  FAME_POOL_STATE_MAX_BATCH_SIZE,
  FAME_POOL_STATE_TABLE_NAME,
} from "../config.ts";
import {
  FamePoolStateRequestError,
  handleFamePoolStateBatchRequest,
  isFamePoolStateRequestError,
} from "../api.ts";
import type { FamePoolStateBatchResponse } from "../api.ts";
import { poolStateRequestAuthorized } from "../auth.ts";
import {
  handleFamePoolQuoteBatchRequest,
  type FamePoolQuoteBatchResponse,
} from "../cl-quote.ts";
import {
  logPoolQuoteApiBatch,
  logPoolStateApiBatch,
  writePoolStateLog,
} from "./logging.ts";

export type FamePoolStateBatchHandler = (
  options: Parameters<typeof handleFamePoolStateBatchRequest>[0],
) => Promise<FamePoolStateBatchResponse>;
export type FamePoolQuoteBatchHandler = (
  options: Parameters<typeof handleFamePoolQuoteBatchRequest>[0],
) => Promise<FamePoolQuoteBatchResponse>;

function serviceToken(): string {
  const token = process.env.FAME_POOL_STATE_SERVICE_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error("FAME_POOL_STATE_SERVICE_TOKEN is not defined");
  }
  return token;
}

function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function parseJsonBody(body: string | undefined): unknown {
  try {
    return JSON.parse(body ?? "{}") as unknown;
  } catch (error) {
    throw new FamePoolStateRequestError(
      "FAME pool-state request invalid at $: expected valid JSON.",
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function routeKind(event: APIGatewayProxyEventV2): "pool-quotes" | "pool-state" {
  const path = event.rawPath || event.requestContext.http.path;
  return path === "/fame/pool-quotes" ? "pool-quotes" : "pool-state";
}

export async function handleFamePoolStateApiEvent({
  event,
  serviceToken,
  tableName,
  producerMaxFreshnessBlocks,
  maxBatchSize,
  handleBatchRequest = handleFamePoolStateBatchRequest,
  handleQuoteBatchRequest = handleFamePoolQuoteBatchRequest,
}: {
  event: APIGatewayProxyEventV2;
  serviceToken: string;
  tableName: string;
  producerMaxFreshnessBlocks: number;
  maxBatchSize: number;
  handleBatchRequest?: FamePoolStateBatchHandler;
  handleQuoteBatchRequest?: FamePoolQuoteBatchHandler;
}): Promise<APIGatewayProxyResultV2> {
  if (!poolStateRequestAuthorized(event.headers, serviceToken)) {
    return jsonResponse(401, {
      error: "unauthorized",
    });
  }

  try {
    const parsedBody = parseJsonBody(event.body);
    const kind = routeKind(event);
    if (kind === "pool-quotes") {
      const response = await handleQuoteBatchRequest({
        request: parsedBody,
        tableName,
        producerMaxFreshnessBlocks,
        maxBatchSize,
      });
      logPoolQuoteApiBatch(response);
      return jsonResponse(200, response);
    }
    const response = await handleBatchRequest({
      request: parsedBody,
      tableName,
      producerMaxFreshnessBlocks,
      maxBatchSize,
    });
    logPoolStateApiBatch(response);
    return jsonResponse(200, response);
  } catch (error) {
    if (isFamePoolStateRequestError(error)) {
      writePoolStateLog("warn", "fame-pool-state-api-error", {
        errorType: "invalid-request",
        message: error.message,
      });
      return jsonResponse(400, {
        error: "invalid-request",
        message: error.message,
      });
    }

    writePoolStateLog("error", "fame-pool-state-api-error", {
      errorType: "dependency",
      message: errorMessage(error),
    });
    return jsonResponse(500, {
      error: "internal-error",
    });
  }
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleFamePoolStateApiEvent({
    event,
    serviceToken: serviceToken(),
    tableName: FAME_POOL_STATE_TABLE_NAME,
    producerMaxFreshnessBlocks: FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS,
    maxBatchSize: FAME_POOL_STATE_MAX_BATCH_SIZE,
  });
}
