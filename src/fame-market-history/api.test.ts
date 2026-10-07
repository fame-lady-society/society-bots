import { referenceFixture } from "./reference-fixture.ts";
import { deriveReference } from "./reference-rpc.ts";
import { referenceKey, referencePolicy } from "./reference.ts";
import { jest } from "@jest/globals";
import {
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { historyReader, parseHistoryRequest } from "./api.ts";
import { scope, metadata, epoch, pool } from "./worker-fixture.ts";
import { candleKey } from "./keys.ts";
const rev = "a".repeat(64);
const request = {
  view: "pool" as const,
  pool: pool.id,
  from: epoch,
  to: epoch + 900,
  resolution: 300 as const,
};
const progress = {
  nextBlock: 110,
  metadataRevision: rev,
  sourceRevision: rev,
  firstPublishedBucket: epoch,
  coverageFromTimestamp: epoch + 1,
  publishedThroughTimestamp: epoch + 599,
  publishedAt: 1000,
};
const row = (timestamp: number) => ({
  ...candleKey(scope.id, pool.id, timestamp),
  poolId: pool.id,
  timestamp,
  open: null,
  high: null,
  low: null,
  close: null,
  baseVolumeAtoms: "0",
  quoteVolumeAtoms: "0",
  tradeCount: 0,
  rejectedEvents: 0,
  coverage: "partial",
  throughBlock: 109,
  metadataRevision: rev,
  sourceRevision: rev,
  privateArtifact: "secret",
});
const snapshot = (p = progress) => ({
  Responses: [
    { Item: { scopeId: scope.id } },
    { Item: p },
    { Item: { nextBlock: 111 } },
  ],
});
function fixture(outputs: unknown[]) {
  const send = jest.fn<(...args: unknown[]) => Promise<unknown>>();
  for (const value of outputs) send.mockResolvedValueOnce(value);
  return {
    send,
    read: historyReader({
      db: { send } as unknown as DynamoDBDocumentClient,
      table: "history",
      scope,
      metadata,
      metadataRevision: rev,
    }),
  };
}
test.each([
  "view=market&from=0&to=300&resolution=300&from=0",
  "view=market&pool=x&from=0&to=300&resolution=300",
  "view=pool&pool=unknown&from=0&to=300&resolution=300",
  "view=market&from=1&to=300&resolution=300",
  "view=market&from=0&to=86700&resolution=300",
  "view=market&from=0&to=300&resolution=3600",
  "view=market&from=0&to=300&resolution=300&extra=1",
  "view=market&from=0e0&to=300&resolution=300",
])("rejects invalid query %s", (q) => {
  expect(() => parseHistoryRequest(q, scope)).toThrow("invalid-query");
});
test("allows the inclusive current bucket and rejects future buckets", () => {
  expect(
    parseHistoryRequest(
      `view=market&from=${epoch}&to=${epoch + 300}&resolution=300`,
      scope,
      epoch * 1000,
    ),
  ).toMatchObject({ view: "market" });
  expect(() =>
    parseHistoryRequest(
      `view=market&from=${epoch}&to=${epoch + 600}&resolution=300`,
      scope,
      epoch * 1000,
    ),
  ).toThrow();
});
test("bounds one partition query, hides storage fields, distinguishes not published from zero trades", async () => {
  const f = fixture([
    snapshot(),
    { Items: [row(epoch), row(epoch + 300)] },
    snapshot(),
  ]);
  const out = await f.read(request);
  expect(out.buckets[0]).toMatchObject({ tradeCount: 0, open: null });
  expect(out.buckets[2]).toMatchObject({
    coverage: "missing",
    tradeCount: null,
    reason: "not-yet-published",
  });
  expect(JSON.stringify(out)).not.toContain("secret");
  const query = f.send.mock.calls[1][0] as QueryCommand;
  expect(query.input).toMatchObject({
    ConsistentRead: true,
    Limit: 288,
    ExpressionAttributeValues: {
      ":pk": candleKey(scope.id, pool.id, epoch).pk,
    },
  });
});
test("follows a second DynamoDB page", async () => {
  const f = fixture([
    snapshot(),
    { Items: [row(epoch)], LastEvaluatedKey: { pk: "p", sk: "s" } },
    { Items: [row(epoch + 300)] },
    snapshot(),
  ]);
  expect((await f.read(request)).buckets).toHaveLength(3);
});
test("an internal hole is corruption, never synthesized as missing", async () => {
  const f = fixture([snapshot(), { Items: [row(epoch)] }, snapshot()]);
  await expect(f.read(request)).rejects.toThrow("history-integrity");
});
test("retries when publication changes before validating temporarily newer rows", async () => {
  const next = { ...progress, nextBlock: 111, sourceRevision: "b".repeat(64) };
  const f = fixture([
    snapshot(),
    { Items: [{ ...row(epoch), throughBlock: 110 }] },
    snapshot(next),
    snapshot(next),
    { Items: [{ ...row(epoch), throughBlock: 110 }, row(epoch + 300)] },
    snapshot(next),
  ]);
  expect((await f.read(request)).progress.publishedThroughBlock).toBe(110);
});
test("lease changes do not invalidate the read", async () => {
  const f = fixture([
    snapshot(),
    { Items: [row(epoch), row(epoch + 300)] },
    snapshot({
      ...progress,
      owner: "worker",
      leaseUntil: 99,
    } as typeof progress),
  ]);
  await expect(f.read(request)).resolves.toBeDefined();
});
test("repeated publication changes stop after two attempts", async () => {
  const next = { ...progress, nextBlock: 111 };
  const f = fixture([
    snapshot(),
    { Items: [] },
    snapshot(next),
    snapshot(next),
    { Items: [] },
    snapshot({ ...next, nextBlock: 112 }),
  ]);
  await expect(f.read(request)).rejects.toThrow("history-updating");
  expect(f.send).toHaveBeenCalledTimes(6);
});
test("never serves a row beyond captured publication or wrong metadata", async () => {
  for (const bad of [
    { ...row(epoch), throughBlock: 110 },
    { ...row(epoch), metadataRevision: "b".repeat(64) },
  ]) {
    const f = fixture([
      snapshot(),
      { Items: [bad, row(epoch + 300)] },
      snapshot(),
    ]);
    await expect(f.read(request)).rejects.toThrow("history-integrity");
  }
});

test("market readers retry when only reference publication advances", async () => {
  const t = epoch + 900;
  const a = referenceFixture(t),
    b = referenceFixture(t + 300);
  const refRow = (f: typeof a) => ({
    ...referenceKey(scope.id, f.evidence.timestamp),
    timestamp: f.evidence.timestamp,
    ...deriveReference(f.evidence, f.scope),
  });
  const state = (nextTimestamp: number) => ({
    Responses: [
      ...snapshot().Responses,
      {
        Item: {
          startTimestamp: t,
          nextTimestamp,
          policyRevision: referencePolicy(scope).revision,
        },
      },
      {
        Item: {
          startTimestamp: t,
          nextTimestamp: t + 600,
          policyRevision: referencePolicy(scope).revision,
        },
      },
    ],
  });
  const f = fixture([
    state(t + 300),
    { Items: [refRow(a)] },
    { Items: [] },
    state(t + 600),
    state(t + 600),
    { Items: [refRow(a), refRow(b)] },
    { Items: [] },
    state(t + 600),
  ]);
  const out = await f.read({
    view: "market",
    from: t,
    to: t + 600,
    resolution: 300,
  });
  expect(f.send).toHaveBeenCalledTimes(8);
  expect(out).toMatchObject({ referenceProgress: { revision: t + 600 } });
  expect(out.buckets).toHaveLength(2);
  for (const bucket of out.buckets)
    expect(bucket).toMatchObject({
      coverage: "missing",
      reference: { values: { fameUsd: { status: "available" } } },
    });
});

test("saved activation distinguishes pending buckets before first publication", async () => {
  const t = epoch + 1200;
  const state = {
    Responses: [
      ...snapshot().Responses,
      {},
      {
        Item: {
          startTimestamp: t,
          nextTimestamp: t + 300,
          policyRevision: referencePolicy(scope).revision,
        },
      },
    ],
  };
  const f = fixture([state, { Items: [] }, state]);
  const out = await f.read({
    view: "market",
    from: t - 300,
    to: t + 600,
    resolution: 300,
  });
  expect(out).toMatchObject({
    referenceProgress: {
      startTimestamp: t,
      publishedThroughTimestamp: null,
      revision: null,
    },
  });
  expect(out.buckets[0]).toMatchObject({
    reference: { values: { fameUsd: { reason: "before-reference-start" } } },
  });
  for (const bucket of out.buckets.slice(1))
    expect(bucket).toMatchObject({
      reference: { values: { fameUsd: { reason: "not-yet-published" } } },
    });
  expect(f.send).toHaveBeenCalledTimes(3);
});

test("read retries when activation appears during a request", async () => {
  const t = epoch + 900;
  const before = { Responses: [...snapshot().Responses, {}, {}] };
  const after = {
    Responses: [
      ...snapshot().Responses,
      {},
      {
        Item: {
          startTimestamp: t,
          nextTimestamp: t,
          policyRevision: referencePolicy(scope).revision,
        },
      },
    ],
  };
  const f = fixture([
    before,
    { Items: [] },
    after,
    after,
    { Items: [] },
    after,
  ]);
  const out = await f.read({
    view: "market",
    from: t,
    to: t + 300,
    resolution: 300,
  });
  expect(f.send).toHaveBeenCalledTimes(6);
  expect(out.buckets[0]).toMatchObject({
    reference: { values: { fameUsd: { reason: "not-yet-published" } } },
  });
});

test("serves a backward refill before activation without changing execution buckets", async () => {
  const t = epoch + 900;
  const policyRevision = referencePolicy(scope).revision;
  const state = {
    Responses: [
      ...snapshot().Responses,
      {},
      {
        Item: {
          startTimestamp: t + 600,
          nextTimestamp: t + 600,
          policyRevision,
        },
      },
      {
        Item: {
          targetFrom: t,
          nextTimestamp: t + 300,
          toTimestamp: t + 600,
          policyRevision,
        },
      },
    ],
  };
  const evidence = referenceFixture(t + 300).evidence;
  const f = fixture([
    state,
    {
      Items: [
        {
          ...referenceKey(scope.id, t + 300),
          timestamp: t + 300,
          ...deriveReference(evidence, scope),
        },
      ],
    },
    { Items: [] },
    state,
  ]);
  const out = await f.read({
    view: "market",
    from: t,
    to: t + 900,
    resolution: 300,
  });
  expect(out.referenceProgress).toMatchObject({
    startTimestamp: t + 300,
    publishedThroughTimestamp: t + 599,
  });
  expect(out.buckets[0]).toMatchObject({
    reference: { values: { fameUsd: { reason: "before-reference-start" } } },
  });
  expect(out.buckets[1]).toMatchObject({
    open: null,
    tradeCount: null,
    reference: {
      values: {
        fameUsd: { status: "available" },
        fameEth: { status: "available" },
      },
    },
  });
  expect(out.buckets[2]).toMatchObject({
    reference: { values: { fameUsd: { reason: "not-yet-published" } } },
  });
});

test("a concurrent backward refill forces a consistent snapshot retry", async () => {
  const t = epoch + 900,
    policyRevision = referencePolicy(scope).revision;
  const state = (nextTimestamp: number) => ({
    Responses: [
      ...snapshot().Responses,
      {},
      {
        Item: {
          startTimestamp: t + 600,
          nextTimestamp: t + 600,
          policyRevision,
        },
      },
      {
        Item: {
          targetFrom: t,
          nextTimestamp,
          toTimestamp: t + 600,
          policyRevision,
        },
      },
    ],
  });
  const ref = (timestamp: number) => ({
    ...referenceKey(scope.id, timestamp),
    timestamp,
    ...deriveReference(referenceFixture(timestamp).evidence, scope),
  });
  const f = fixture([
    state(t + 300),
    { Items: [ref(t + 300)] },
    { Items: [] },
    state(t),
    state(t),
    { Items: [ref(t), ref(t + 300)] },
    { Items: [] },
    state(t),
  ]);
  const out = await f.read({
    view: "market",
    from: t,
    to: t + 600,
    resolution: 300,
  });
  expect(f.send).toHaveBeenCalledTimes(8);
  expect(out.referenceProgress?.startTimestamp).toBe(t);
  expect(out.buckets).toHaveLength(2);
});
