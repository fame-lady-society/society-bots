import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  HistoryError,
  parseHistoryRequest,
  type historyReader,
} from "../../src/fame-market-history/api.ts";
import type { Scope } from "../../src/fame-market-history/model.ts";

/** Local verification adapter, bound to loopback by the caller. Not production auth. */
export function localHistoryServer(
  read: ReturnType<typeof historyReader>,
  scope: Scope,
  token: string,
) {
  if (token.length < 32)
    throw new Error("Local test token must have at least 32 characters");
  return createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const expected = Buffer.from(`Bearer ${token}`),
      actual = Buffer.from(request.headers.authorization ?? "");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/fame/history") {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      if (
        request.headers["content-length"] ||
        request.headers["transfer-encoding"]
      )
        throw new HistoryError(400, "invalid-request");
      const result = await read(
        parseHistoryRequest(url.search.slice(1), scope),
      );
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(error instanceof HistoryError ? error.status : 503);
      response.end(
        JSON.stringify({
          error:
            error instanceof HistoryError ? error.code : "history-unavailable",
        }),
      );
    }
  });
}
