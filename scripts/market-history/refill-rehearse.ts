import assert from "node:assert/strict";
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { awsReferenceRefill } from "../../src/fame-market-history/reference-refill-storage.ts";
import { awsReferences } from "../../src/fame-market-history/reference-storage.ts";
import {
  referenceFixture,
  referenceHeader,
} from "../../src/fame-market-history/reference-fixture.ts";
import {
  referenceKey,
  referencePolicy,
  referenceProgressKey,
} from "../../src/fame-market-history/reference.ts";
import { scope, epoch } from "../../src/fame-market-history/worker-fixture.ts";
import { readReferences } from "../../src/fame-market-history/reference-api.ts";
export async function rehearseRefill(
  db: DynamoDBDocumentClient,
  s3: S3Client,
  table: string,
) {
  const localScope = { ...scope, id: "f".repeat(64) };
  const policyRevision = referencePolicy(localScope).revision;
  const live = {
    startTimestamp: epoch + 900,
    nextTimestamp: epoch + 900,
    policyRevision,
    anchor: referenceHeader(600),
  };
  const original = awsReferences({
    scope: localScope,
    db,
    s3,
    table,
    bucket: "local-objects",
  });
  await original.cursor(live);
  const store = awsReferenceRefill({
    scope: localScope,
    db,
    s3,
    table,
    bucket: "local-objects",
  });
  const initial = {
    targetFrom: epoch + 300,
    toTimestamp: epoch + 900,
    nextTimestamp: epoch + 900,
    policyRevision,
    upper: referenceHeader(600),
  };
  await store.initialize(initial);
  const evidence = (t: number) => ({
    ...referenceFixture(t).evidence,
    scopeId: localScope.id,
  });
  const competing = await Promise.allSettled([
    store.commit(initial, evidence(epoch + 600)),
    store.commit(initial, evidence(epoch + 600)),
  ]);
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.load()).nextTimestamp, epoch + 600);
  const lossyDb = {
    send: async (command: unknown) => {
      const result = await db.send(command as never);
      if (command instanceof TransactWriteCommand)
        throw Error("lost successful response");
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const lossy = awsReferenceRefill({
    scope: localScope,
    db: lossyDb,
    s3,
    table,
    bucket: "local-objects",
  });
  await assert.rejects(() =>
    lossy.commit(
      { ...initial, nextTimestamp: epoch + 600 },
      evidence(epoch + 300),
    ),
  );
  assert.equal((await store.load()).nextTimestamp, epoch + 300);
  await store.initialize(initial); // resume leaves completed frontier intact
  assert.equal((await store.load()).nextTimestamp, epoch + 300);
  const unchanged = (
    await db.send(
      new GetCommand({
        TableName: table,
        Key: referenceProgressKey(localScope.id, "collected"),
      }),
    )
  ).Item!;
  assert.equal(unchanged.startTimestamp, live.startTimestamp);
  assert.equal(unchanged.nextTimestamp, live.nextTimestamp);
  assert.equal(await original.progress("published"), undefined);
  const rows = await readReferences(
    db,
    table,
    localScope.id,
    { startTimestamp: epoch + 300, nextTimestamp: epoch + 900, policyRevision },
    epoch + 300,
    epoch + 900,
    AbortSignal.timeout(5000),
  );
  assert.equal(rows.size, 2);
  assert.equal(rows.get(epoch + 300)!.values.fameUsd.status, "available");
  await assert.rejects(() => store.commit(initial, evidence(epoch + 600)));
  const persisted = (
    await db.send(
      new GetCommand({
        TableName: table,
        Key: referenceKey(localScope.id, epoch + 300),
      }),
    )
  ).Item!;
  assert.ok(persisted.artifact.bytes > 0);
  console.log(
    JSON.stringify({
      event: "reference-refill-transactions-verified",
      competingRefills: true,
      lostResponseResume: true,
      liveCursorsUnchanged: true,
      parquetRoundtrip: true,
      availableReferences: rows.size,
    }),
  );
}
