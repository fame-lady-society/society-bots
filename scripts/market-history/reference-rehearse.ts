/** Called only by the loopback-only worker rehearsal; no production target. */
import assert from "node:assert/strict";
import {
  BatchWriteCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { S3Client } from "@aws-sdk/client-s3";
import { awsReferences } from "../../src/fame-market-history/reference-storage.ts";
import {
  referenceFixture,
  referenceHeader,
} from "../../src/fame-market-history/reference-fixture.ts";
import {
  referencePolicy,
  referenceKey,
  referenceProgressKey,
} from "../../src/fame-market-history/reference.ts";
import { deriveReference } from "../../src/fame-market-history/reference-rpc.ts";
import { publishReferences } from "../../src/fame-market-history/reference-worker.ts";
import { scope, epoch } from "../../src/fame-market-history/worker-fixture.ts";
export async function rehearseReferences(
  db: DynamoDBDocumentClient,
  s3: S3Client,
  table: string,
) {
  const store = awsReferences({
    scope,
    table,
    bucket: "local-objects",
    db,
    s3,
  });
  const initial = {
    startTimestamp: epoch,
    nextTimestamp: epoch,
    policyRevision: referencePolicy(scope).revision,
    anchor: referenceHeader(1),
  };
  const a = await store.cursor(initial),
    b = await store.cursor({
      ...initial,
      startTimestamp: epoch + 300,
      nextTimestamp: epoch + 300,
    });
  assert.deepEqual(a, b);
  const first = referenceFixture(epoch).evidence;
  const competitors = await Promise.allSettled([
    store.commit(a, first),
    store.commit(b, first),
  ]);
  assert.equal(competitors.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal((await store.progress("collected"))!.nextTimestamp, epoch + 300);
  const cursor = await store.cursor(initial);
  const lostDb = {
    send: async (command: unknown) => {
      const result = await db.send(command as never);
      if (command instanceof TransactWriteCommand)
        throw new Error("successful transaction response lost");
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const lossy = awsReferences({
    scope,
    table,
    bucket: "local-objects",
    db: lostDb,
    s3,
  });
  await assert.rejects(() =>
    lossy.commit(cursor, referenceFixture(epoch + 300).evidence),
  );
  assert.equal((await store.cursor(initial)).nextTimestamp, epoch + 600);
  // A failed publisher cannot partially expose prices or consume work.
  const before = await db.send(
    new GetCommand({ TableName: table, Key: referenceKey(scope.id, epoch) }),
  );
  assert.equal(before.Item, undefined);
  await assert.rejects(() =>
    publishReferences(scope, {
      ...store,
      upload: async () => {
        throw new Error("upload failed");
      },
    }),
  );
  assert.equal(await store.progress("published"), undefined);
  // Simulate an ambiguous successful publication, then resume from the transaction marker.
  await assert.rejects(() =>
    publishReferences(scope, {
      ...store,
      publish: async (...args) => {
        await store.publish(...args);
        throw new Error("response lost");
      },
    }),
  );
  assert.equal((await store.progress("published"))!.nextTimestamp, epoch + 300);
  assert.equal((await publishReferences(scope, store)).published, 1);
  assert.equal((await publishReferences(scope, store)).published, 0);
  // Replaying an old candidate must not replace the already published row.
  await assert.rejects(() =>
    store.publish(epoch, first, deriveReference(first, scope), {
      key: "incorrect",
      sha256: "incorrect",
      bytes: 1,
    }),
  );
  assert.equal((await store.progress("published"))!.nextTimestamp, epoch + 600);
  // Populate the same 288-bucket load fixture as execution history, with real public reference shapes.
  const rows = Array.from({ length: 288 }, (_, i) => {
    const e = referenceFixture(epoch + i * 300).evidence;
    return {
      ...referenceKey(scope.id, e.timestamp),
      timestamp: e.timestamp,
      ...deriveReference(e, scope),
    };
  });
  for (let i = 0; i < rows.length; i += 25) {
    const result = await db.send(
      new BatchWriteCommand({
        RequestItems: {
          [table]: rows
            .slice(i, i + 25)
            .map((Item) => ({ PutRequest: { Item } })),
        },
      }),
    );
    assert.equal(Object.keys(result.UnprocessedItems ?? {}).length, 0);
  }
  // The serving-only load fixture must retain publication <= collection.
  for (const stage of ["collected", "published"] as const)
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: referenceProgressKey(scope.id, stage),
        UpdateExpression: "SET nextTimestamp = :next",
        ExpressionAttributeValues: { ":next": epoch + 86400 },
      }),
    );
  console.log(
    JSON.stringify({
      event: "reference-transactions-verified",
      competingCollectors: true,
      lostCollectionResponse: true,
      lostPublicationResponse: true,
      stalePublisherRejected: true,
      parquetRebuild: true,
      loadBuckets: 288,
      awsWrites: false,
    }),
  );
}
