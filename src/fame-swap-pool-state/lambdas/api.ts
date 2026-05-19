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

export type FamePoolStateBatchHandler = (
  options: Parameters<typeof handleFamePoolStateBatchRequest>[0],
) => Promise<FamePoolStateBatchResponse>;

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

function statusCounts(response: { pools: Array<{ status: string }> }) {
  const counts: Record<string, number> = {};
  for (const pool of response.pools) {
    counts[pool.status] = (counts[pool.status] ?? 0) + 1;
  }
  return counts;
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

export async function handleFamePoolStateApiEvent({
  event,
  serviceToken,
  tableName,
  producerMaxFreshnessBlocks,
  maxBatchSize,
  handleBatchRequest = handleFamePoolStateBatchRequest,
}: {
  event: APIGatewayProxyEventV2;
  serviceToken: string;
  tableName: string;
  producerMaxFreshnessBlocks: number;
  maxBatchSize: number;
  handleBatchRequest?: FamePoolStateBatchHandler;
}): Promise<APIGatewayProxyResultV2> {
  if (!poolStateRequestAuthorized(event.headers, serviceToken)) {
    return jsonResponse(401, {
      error: "unauthorized",
    });
  }

  try {
    const response = await handleBatchRequest({
      request: parseJsonBody(event.body),
      tableName,
      producerMaxFreshnessBlocks,
      maxBatchSize,
    });
    console.log(
      JSON.stringify({
        event: "fame-pool-state-api-batch",
        sourceRegistryId: response.sourceRegistryId,
        currentBlock: response.currentBlock,
        effectiveMaxFreshnessBlocks: response.effectiveMaxFreshnessBlocks,
        batchSize: response.pools.length,
        statusCounts: statusCounts(response),
      }),
    );
    return jsonResponse(200, response);
  } catch (error) {
    if (isFamePoolStateRequestError(error)) {
      return jsonResponse(400, {
        error: "invalid-request",
        message: error.message,
      });
    }

    console.error(
      JSON.stringify({
        event: "fame-pool-state-api-error",
        message: errorMessage(error),
      }),
    );
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
    producerMaxFreshnessBlocks:
      FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS,
    maxBatchSize: FAME_POOL_STATE_MAX_BATCH_SIZE,
  });
}
