import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS,
  FAME_LANDING_SNAPSHOT_CACHE_SECONDS,
  FAME_LANDING_SNAPSHOT_FUTURE_TOLERANCE_SECONDS,
  FAME_LANDING_SNAPSHOT_MAX_AGE_SECONDS,
  FAME_LANDING_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS,
  FAME_POOL_STATE_MAX_BATCH_SIZE,
  FAME_POOL_STATE_TABLE_NAME,
} from "../config.ts";
import {
  FamePoolStateRequestError,
  handleFamePoolStateBatchRequest,
  isFamePoolStateRequestError,
} from "../api.ts";
import type { FamePoolStateBatchResponse } from "../api.ts";
import {
  readFameLandingSnapshotResponse,
  type FameLandingSnapshotApiResult,
} from "../landing-snapshot-api.ts";
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
export type FameLandingSnapshotHandler = (options: {
  tableName: string;
  maxAgeSeconds?: number;
  cacheSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  futureToleranceSeconds?: number;
}) => Promise<FameLandingSnapshotApiResult>;

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
  headers: Record<string, string> = {},
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function requestPath(event: APIGatewayProxyEventV2): string {
  return event.rawPath || event.requestContext.http.path;
}

function isLandingSnapshotPath(event: APIGatewayProxyEventV2): boolean {
  return requestPath(event) === "/fame/landing-defi-snapshot";
}

function landingRequestHasVariation(event: APIGatewayProxyEventV2): boolean {
  return (
    event.requestContext.http.method !== "GET" ||
    event.rawQueryString.length > 0 ||
    event.body !== undefined ||
    (event.cookies?.length ?? 0) > 0 ||
    Object.keys(event.queryStringParameters ?? {}).length > 0
  );
}

async function handleLandingSnapshot(
  event: APIGatewayProxyEventV2,
  tableName: string,
  readLandingSnapshot: FameLandingSnapshotHandler,
): Promise<APIGatewayProxyResultV2> {
  if (landingRequestHasVariation(event)) {
    writePoolStateLog("warn", "fame-landing-snapshot-api", {
      status: "rejected",
      reason: "request-variation",
    });
    return jsonResponse(
      400,
      { error: "invalid-request" },
      {
        "cache-control": "no-store",
      },
    );
  }
  let result: FameLandingSnapshotApiResult;
  try {
    result = await readLandingSnapshot({
      tableName,
      maxAgeSeconds: FAME_LANDING_SNAPSHOT_MAX_AGE_SECONDS,
      cacheSeconds: FAME_LANDING_SNAPSHOT_CACHE_SECONDS,
      staleWhileRevalidateSeconds:
        FAME_LANDING_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS,
      futureToleranceSeconds: FAME_LANDING_SNAPSHOT_FUTURE_TOLERANCE_SECONDS,
    });
  } catch (error) {
    writePoolStateLog("error", "fame-landing-snapshot-api", {
      status: "error",
      errorClass:
        error instanceof Error &&
        /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(error.name)
          ? error.name
          : "UnknownError",
    });
    return jsonResponse(
      500,
      { error: "internal-error" },
      {
        "cache-control": "no-store",
      },
    );
  }
  if (result.status === "unavailable") {
    writePoolStateLog("warn", "fame-landing-snapshot-api", {
      status: "unavailable",
      reason: result.reason,
    });
    return jsonResponse(
      503,
      {
        error: "snapshot-unavailable",
        reason: result.reason,
      },
      { "cache-control": "no-store" },
    );
  }
  writePoolStateLog("info", "fame-landing-snapshot-api", {
    status: "success",
    snapshotId: result.snapshot.provenance.snapshotId,
    safeBlockNumber: result.snapshot.provenance.safeBlockNumber,
    ageSeconds: result.ageSeconds,
  });
  return jsonResponse(200, result.snapshot, {
    "cache-control": result.cacheControl,
    etag: `"${result.snapshot.provenance.snapshotId}"`,
    "x-fame-snapshot-id": result.snapshot.provenance.snapshotId,
    "x-fame-snapshot-schema": result.snapshot.schemaVersion,
  });
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

function routeKind(
  event: APIGatewayProxyEventV2,
): "pool-quotes" | "pool-state" {
  const path = requestPath(event);
  if (path === "/fame/pool-quotes") return "pool-quotes";
  if (path === "/fame/pool-state") return "pool-state";
  throw new FamePoolStateRequestError(
    `FAME pool-state request invalid at routeKind: expected /fame/pool-state or /fame/pool-quotes, received ${path}.`,
  );
}

export async function handleFamePoolStateApiEvent({
  event,
  serviceToken,
  tableName,
  producerMaxFreshnessBlocks,
  maxBatchSize,
  handleBatchRequest = handleFamePoolStateBatchRequest,
  handleQuoteBatchRequest = handleFamePoolQuoteBatchRequest,
  readLandingSnapshot = readFameLandingSnapshotResponse,
}: {
  event: APIGatewayProxyEventV2;
  serviceToken: string;
  tableName: string;
  producerMaxFreshnessBlocks: number;
  maxBatchSize: number;
  handleBatchRequest?: FamePoolStateBatchHandler;
  handleQuoteBatchRequest?: FamePoolQuoteBatchHandler;
  readLandingSnapshot?: FameLandingSnapshotHandler;
}): Promise<APIGatewayProxyResultV2> {
  if (isLandingSnapshotPath(event)) {
    return handleLandingSnapshot(event, tableName, readLandingSnapshot);
  }
  if (!poolStateRequestAuthorized(event.headers, serviceToken)) {
    return jsonResponse(401, {
      error: "unauthorized",
    });
  }

  try {
    const kind = routeKind(event);
    const parsedBody = parseJsonBody(event.body);
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
    serviceToken: isLandingSnapshotPath(event) ? "" : serviceToken(),
    tableName: FAME_POOL_STATE_TABLE_NAME,
    producerMaxFreshnessBlocks: FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS,
    maxBatchSize: FAME_POOL_STATE_MAX_BATCH_SIZE,
  });
}
