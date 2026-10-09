import { parseActivityRequest, readActivity } from "./activity-api.ts";
import { digest } from "./model.ts";
import { sampledPolicy } from "./sampled-market.ts";
import { sampledReader } from "./sampled-reader.ts";
import { gzipSync } from "node:zlib";
import { parseChartRequest, readChart } from "./chart-api.ts";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HistoryError, historyReader, parseHistoryRequest } from "./api.ts";
import { fameHistoryRegistry } from "./registry.ts";
import { historyScope } from "./model.ts";
import type { TokenMetadata } from "./decode.ts";
import { servingRevision } from "./revision.ts";

import { parseSampledRequest, readSampledMarket } from "./sampled-api.ts";

const scope = historyScope(fameHistoryRegistry);
const metadata: TokenMetadata = JSON.parse(
  readFileSync(new URL("./token-metadata.json", import.meta.url), "utf8"),
);
const metadataRevision = servingRevision(scope, metadata);
const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 1500 },
  }),
);
export async function handler(event: APIGatewayProxyEventV2) {
  const headers = {
    "content-type": "application/json",
    "cache-control": "private, no-store",
  };
  try {
    if (event.requestContext.http.method !== "GET" || event.body)
      throw new HistoryError(400, "invalid-request");
    const activity =
      new URLSearchParams(event.rawQueryString).get("view") === "activity";
    const activityRequest = activity
      ? parseActivityRequest(event.rawQueryString, scope)
      : null;
    const chart =
      new URLSearchParams(event.rawQueryString).get("view") === "chart";
    const chartRequest = chart
      ? parseChartRequest(event.rawQueryString, scope)
      : null;
    const sampled =
      new URLSearchParams(event.rawQueryString).get("view") ===
      "sampled-market";
    const sampledRequest = sampled
      ? parseSampledRequest(event.rawQueryString)
      : null;
    const request =
      sampled || chart || activity
        ? null
        : parseHistoryRequest(event.rawQueryString, scope);
    const table = process.env.FAME_HISTORY_TABLE;
    if (!table) throw new Error("Missing history table");
    const publication = chart
      ? await sampledReader(
          db,
          table,
          sampledPolicy(scope).revision,
        ).publication()
      : undefined;
    const etag =
      chart && !chartRequest!.cursor
        ? `W/"${digest(JSON.stringify([publication!.generation, chartRequest!.currency, chartRequest!.series, chartRequest!.from, chartRequest!.to]))}"`
        : undefined;
    const chartHeaders = {
      ...headers,
      ...(etag ? { etag } : {}),
      vary: "Accept-Encoding",
    };
    if (
      etag &&
      event.headers?.["if-none-match"]
        ?.split(",")
        .map((v) => v.trim())
        .includes(etag)
    )
      return { statusCode: 304, headers: chartHeaders, body: "" };
    const body = activity
      ? await readActivity(db, table, scope, activityRequest!)
      : chart
        ? await readChart(
            db,
            table,
            scope,
            chartRequest!,
            Date.now,
            publication,
          )
        : sampled
          ? await readSampledMarket(db, table, scope, sampledRequest!)
          : await historyReader({
              db,
              table,
              scope,
              metadata,
              metadataRevision,
            })(request!);
    const json = JSON.stringify(body);
    // API Gateway HTTP API decodes this binary envelope for the client.
    const gzip = (event.headers?.["accept-encoding"] ?? "")
      .split(",")
      .some((part) => {
        const [coding, ...params] = part.trim().split(";");
        const q = params.find((p) => p.trim().startsWith("q="));
        return coding === "gzip" && (!q || Number(q.trim().slice(2)) > 0);
      });
    if ((chart || activity) && gzip)
      return {
        statusCode: 200,
        headers: { ...chartHeaders, "content-encoding": "gzip" },
        body: gzipSync(json).toString("base64"),
        isBase64Encoded: true,
      };
    return {
      statusCode: 200,
      headers: chart || activity ? chartHeaders : headers,
      body: json,
    };
  } catch (error) {
    const known = error instanceof HistoryError;
    const code = known ? error.code : "history-unavailable";
    if (!known || error.status >= 500)
      console.error(JSON.stringify({ event: "history-read-failed", code }));
    return {
      statusCode: known ? error.status : 503,
      headers,
      body: JSON.stringify({ error: code }),
    };
  }
}
