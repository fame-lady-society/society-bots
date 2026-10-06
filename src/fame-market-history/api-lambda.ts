import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HistoryError, historyReader, parseHistoryRequest } from "./api.ts";
import { famePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { historyScope } from "./model.ts";
import type { TokenMetadata } from "./decode.ts";
import { servingRevision } from "./revision.ts";

const scope = historyScope(famePoolStateRegistry);
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
    const request = parseHistoryRequest(event.rawQueryString, scope);
    const table = process.env.FAME_HISTORY_TABLE;
    if (!table) throw new Error("Missing history table");
    const body = await historyReader({
      db,
      table,
      scope,
      metadata,
      metadataRevision,
    })(request);
    return { statusCode: 200, headers, body: JSON.stringify(body) };
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
