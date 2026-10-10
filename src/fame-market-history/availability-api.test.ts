import { dataset, datasetKey } from "./dataset.ts";
import { metadata } from "./worker-fixture.ts";
import { jest, afterEach } from "@jest/globals";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { parseAvailabilityRequest } from "./availability-api.ts";
import { sampledReader } from "./sampled-reader.ts";
import { dayPublication, utcDay } from "./dated-publication.ts";
import { scope, epoch } from "./worker-fixture.ts";
import { sampledFixture } from "./sampled-fixture.ts";
import { deriveSampledObservation } from "./sampled-rpc.ts";
import { sampledMarketBucket } from "./sampled-market.ts";
import { nextSampledPublication } from "./sampled-live.ts";
import { handler } from "./api-lambda.ts";
const original = process.env.FAME_HISTORY_TABLE;
afterEach(() => {
  jest.restoreAllMocks();
  if (original === undefined) delete process.env.FAME_HISTORY_TABLE;
  else process.env.FAME_HISTORY_TABLE = original;
});
const publication = (t: number) => {
  const e = sampledFixture(t),
    o = deriveSampledObservation(scope, e);
  return nextSampledPublication(
    null,
    e,
    (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(scope, c, t, o, []),
    ),
  );
};
test("availability queries only one dated directory, crosses gaps, and stops at the exact earliest bucket", async () => {
  const old = publication(epoch),
    live = publication(epoch + 86400),
    day = dayPublication(old.policyRevision, utcDay(epoch), old.pages);
  const requests: any[] = [];
  const db = {
    send: async (c: any) => {
      requests.push(c.input);
      return c instanceof QueryCommand
        ? { Items: [{ sk: `day:${day.day}`, body: JSON.stringify(day) }] }
        : { Item: live };
    },
  } as unknown as DynamoDBDocumentClient;
  expect(
    await sampledReader(db, "table", old.policyRevision).availability(
      epoch + 600,
    ),
  ).toMatchObject({ earliestAvailableTimestamp: epoch, hasEarlier: true });
  expect(
    await sampledReader(db, "table", old.policyRevision).availability(epoch),
  ).toMatchObject({ hasEarlier: false });
  expect(
    await sampledReader(db, "table", old.policyRevision).availability(
      epoch - 300,
    ),
  ).toMatchObject({ hasEarlier: false });
  expect(
    requests
      .filter((r) => r.KeyConditionExpression)
      .every((r) => r.Limit === 1 && r.ConsistentRead && r.ScanIndexForward),
  ).toBe(true);
  expect(requests).toHaveLength(6);
});
test("without archived directories the live window supplies the boundary", async () => {
  const live = publication(epoch);
  const db = {
    send: async (c: any) =>
      c instanceof QueryCommand
        ? { Items: [] }
        : {
            Item:
              c.input.Key?.sk === "active-scope"
                ? { scopeId: scope.id }
                : c.input.Key?.pk === datasetKey(scope.id).pk
                  ? dataset(scope, metadata)
                  : live,
          },
  } as unknown as DynamoDBDocumentClient;
  expect(
    await sampledReader(db, "table", live.policyRevision).availability(),
  ).toEqual({
    version: "fame-history-availability-v1",
    policyRevision: live.policyRevision,
    earliestAvailableTimestamp: epoch,
    latestAvailableTimestamp: epoch,
    resolution: 300,
    maxWindowSeconds: 86400,
  });
});
test("endpoint validates navigation before storage and returns uncached boundary metadata", async () => {
  process.env.FAME_HISTORY_TABLE = "table";
  const live = publication(epoch);
  const send = jest
    .spyOn(DynamoDBDocumentClient.prototype, "send")
    .mockImplementation(async (c: any) =>
      c instanceof QueryCommand
        ? { Items: [] }
        : {
            Item:
              c.input.Key?.sk === "active-scope"
                ? { scopeId: scope.id }
                : c.input.Key?.pk === datasetKey(scope.id).pk
                  ? dataset(scope, metadata)
                  : live,
          },
    );
  for (const q of [
    "view=availability&before=1",
    "view=availability&before=300&before=600",
    "view=availability&currency=ETH",
  ]) {
    const r = await handler({
      rawQueryString: q,
      requestContext: { http: { method: "GET" } },
    } as any);
    expect(r.statusCode).toBe(400);
  }
  expect(send).not.toHaveBeenCalled();
  const r = await handler({
    rawQueryString: `view=availability&before=${epoch}`,
    requestContext: { http: { method: "GET" } },
  } as any);
  expect(r.statusCode).toBe(200);
  expect(r.headers["cache-control"]).toBe("private, no-store");
  expect(JSON.parse(r.body)).toMatchObject({
    earliestAvailableTimestamp: epoch,
    hasEarlier: false,
  });
});
test("parser rejects unsafe or malformed boundaries", () => {
  for (const x of ["-300", "1e3", "NaN", "9007199254741200", "", "0300"])
    expect(() =>
      parseAvailabilityRequest(`view=availability&before=${x}`),
    ).toThrow();
  expect(parseAvailabilityRequest("view=availability")).toBeUndefined();
});
