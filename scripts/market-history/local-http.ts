import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  historyResponse,
  type HistoryDataset,
} from "../../src/fame-market-history/analytics.ts";

/** Local verification adapter, bound to loopback by the caller. Not production auth. */
export function localHistoryServer(dataset: HistoryDataset, token: string) {
  if (token.length < 32)
    throw new Error("Local test token must have at least 32 characters");
  return createServer((request, response) => {
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
      for (const name of ["pool", "resolution", "from", "to"])
        if (!url.searchParams.has(name)) throw new Error("Missing parameter");
      const result = historyResponse(dataset, {
        pool: url.searchParams.get("pool")!,
        resolution: Number(url.searchParams.get("resolution")),
        from: Number(url.searchParams.get("from")),
        to: Number(url.searchParams.get("to")),
      });
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400);
      response.end(JSON.stringify({ error: "Invalid history request" }));
    }
  });
}
