import { runInNewContext } from "node:vm";
import {
  FAME_LANDING_SNAPSHOT_VIEWER_REQUEST_CODE,
  ZERO_TTL_ERROR_STATUSES,
} from "../lib/distribution.js";

function viewerRequest(event: unknown): unknown {
  return runInNewContext(
    `${FAME_LANDING_SNAPSHOT_VIEWER_REQUEST_CODE}; handler(event)`,
    { event },
  );
}

describe("FAME landing snapshot viewer request", () => {
  test("defines zero cache retention for public and infrastructure errors", () => {
    expect(ZERO_TTL_ERROR_STATUSES).toEqual([
      400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504,
    ]);
  });

  test("passes the fixed path request without cache-key variation", () => {
    const request = {
      method: "GET",
      uri: "/fame/landing-defi-snapshot",
      querystring: {},
      cookies: {},
    };

    expect(viewerRequest({ request })).toEqual(request);
  });

  test.each([
    ["query", { querystring: { amount: { value: "1" } }, cookies: {} }],
    ["cookie", { querystring: {}, cookies: { session: { value: "x" } } }],
  ])(
    "rejects %s variation before a cached response can be served",
    (_, input) => {
      expect(
        viewerRequest({
          request: {
            method: "GET",
            uri: "/fame/landing-defi-snapshot",
            ...input,
          },
        }),
      ).toEqual({
        statusCode: 400,
        statusDescription: "Bad Request",
        headers: {
          "cache-control": { value: "no-store" },
          "content-type": { value: "application/json" },
        },
        body: '{"error":"invalid-request"}',
      });
    },
  );
});
