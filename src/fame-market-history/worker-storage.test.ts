import { jest } from "@jest/globals";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  TransactGetCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { awsAggregation } from "./worker-storage.ts";
import { fixtureRange } from "./worker-fixture.ts";

test("pending state uses an atomic read; missing work behind the collector fails", async () => {
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "us-west-1" }),
  );
  const send = jest
    .spyOn(db, "send")
    .mockResolvedValue({
      Responses: [{}, { Item: { nextBlock: 111 } }, {}],
    } as never);
  await expect(
    awsAggregation({ table: "t", bucket: "b", db }).pending("scope", 100),
  ).rejects.toThrow("Missing pending");
  expect(send.mock.calls[0][0]).toBeInstanceOf(TransactGetCommand);
});

test("a truncated or oversized archive stream cannot bypass content verification", async () => {
  const { manifest } = await fixtureRange(100, 110);
  const s3 = new S3Client({ region: "us-west-1" });
  const send = jest
    .spyOn(s3, "send")
    .mockResolvedValue({
      ContentLength: manifest.bytes,
      Body: Readable.from([Buffer.alloc(manifest.bytes + 1)]),
    } as never);
  await expect(
    awsAggregation({ table: "t", bucket: "b", s3 }).read(manifest),
  ).rejects.toThrow("exceeds");
  send.mockResolvedValue({
    ContentLength: manifest.bytes + 1,
    Body: Readable.from([]),
  } as never);
  await expect(
    awsAggregation({ table: "t", bucket: "b", s3 }).read(manifest),
  ).rejects.toThrow("size mismatch");
});

test("derived S3 publication verifies an existing object instead of overwriting it", async () => {
  const s3 = new S3Client({ region: "us-west-1" });
  const send = jest
    .spyOn(s3, "send")
    .mockRejectedValueOnce(
      Object.assign(Error("exists"), { name: "PreconditionFailed" }) as never,
    )
    .mockResolvedValueOnce({
      ContentLength: 2,
      ChecksumSHA256: "wrong",
    } as never);
  await expect(
    awsAggregation({ table: "t", bucket: "b", s3 }).upload(
      "derived/test",
      Buffer.from("ok"),
      "application/json",
    ),
  ).rejects.toThrow("verification failed");
  expect(send.mock.calls[0][0].input).toMatchObject({ IfNoneMatch: "*" });
});
