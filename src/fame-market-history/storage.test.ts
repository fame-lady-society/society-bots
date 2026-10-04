import { jest } from "@jest/globals";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { awsArchive, commitInput } from "./storage.ts";
import { digest, type Manifest } from "./model.ts";

const h = `0x${"1".repeat(64)}` as const;
const manifest: Manifest = {
  schema: "fame-market-raw-v1",
  scopeId: "scope",
  fromBlock: 100,
  toBlock: 110,
  firstHash: h,
  lastHash: h,
  previousHash: h,
  eventCount: 0,
  key: "raw/test",
  sha256: "a".repeat(64),
  contentSha256: "c".repeat(64),
  bytes: 50,
  eventIdentityDigest: "b".repeat(64),
};
const db = () =>
  DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: "us-west-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    }),
  );
test("manifest, work record and cursor publish in one conditional transaction", () => {
  const input = commitInput("history", manifest, {
    startBlock: 1,
    nextBlock: 100,
    previousHash: h,
  });
  expect(input.TransactItems).toHaveLength(4);
  expect(input.TransactItems[0].Put).toMatchObject({
    ConditionExpression: "attribute_not_exists(pk) OR scopeId = :scope",
  });
  expect(input.TransactItems[1].Put).toMatchObject({
    ConditionExpression:
      "nextBlock = :next AND previousHash = :hash AND startBlock = :start",
    Item: { nextBlock: 111 },
  });
  expect(input.TransactItems[2].Put).toMatchObject({
    ConditionExpression: "attribute_not_exists(pk)",
    Item: { fromBlock: 100, toBlock: 110 },
  });
  expect(input.TransactItems[3].Put.Item).toMatchObject({
    status: "pending",
    manifestKey: "raw/test",
  });
  expect(
    commitInput("history", manifest, {
      startBlock: 100,
      nextBlock: 100,
      previousHash: null,
    }).TransactItems[1].Put.ConditionExpression,
  ).toBe("attribute_not_exists(pk)");
});

test("read cursor uses strongly consistent reads and never resets a malformed row", async () => {
  const client = db();
  const send = jest
    .spyOn(client, "send")
    .mockResolvedValueOnce({ Item: { scopeId: "scope" } } as never)
    .mockResolvedValueOnce({ Item: { nextBlock: "bad" } } as never);
  await expect(
    awsArchive({ table: "history", bucket: "archive", db: client }).cursor(
      "scope",
      100,
    ),
  ).rejects.toThrow();
  expect(send.mock.calls[0][0].input).toMatchObject({ ConsistentRead: true });
});

test("a changed pool scope cannot silently restart historical collection", async () => {
  const client = db();
  const send = jest
    .spyOn(client, "send")
    .mockResolvedValue({ Item: { scopeId: "old-scope" } } as never);
  await expect(
    awsArchive({ table: "history", bucket: "archive", db: client }).cursor(
      "new-scope",
      100,
    ),
  ).rejects.toThrow("scope changed");
  expect(send).toHaveBeenCalledTimes(1);
});

test.each([100, 99])(
  "a scan hint for block %i only applies at that cursor",
  async (nextBlock) => {
    const client = db();
    jest
      .spyOn(client, "send")
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({} as never)
      .mockResolvedValueOnce({ Item: { nextBlock, maxBlocks: 250 } } as never);
    const cursor = await awsArchive({
      table: "history",
      bucket: "archive",
      db: client,
    }).cursor("scope", 100);
    expect(cursor).toEqual({
      startBlock: 100,
      nextBlock: 100,
      previousHash: null,
      ...(nextBlock === 100 ? { maxBlocks: 250 } : {}),
    });
  },
);

test("hint write failures surface, except a competing narrower/newer hint", async () => {
  const client = db();
  const send = jest
    .spyOn(client, "send")
    .mockRejectedValueOnce(
      Object.assign(new Error("already smaller"), {
        name: "ConditionalCheckFailedException",
      }) as never,
    )
    .mockRejectedValueOnce(new Error("database unavailable") as never);
  const store = awsArchive({ table: "history", bucket: "archive", db: client });
  await expect(store.reduceRange("scope", 100, 250)).resolves.toBeUndefined();
  await expect(store.reduceRange("scope", 100, 250)).rejects.toThrow(
    "database unavailable",
  );
  expect(send.mock.calls[0][0].input).toMatchObject({
    Item: {
      pk: "scope:scope",
      sk: "scan-window",
      nextBlock: 100,
      maxBlocks: 250,
    },
  });
});

test("S3 checksum mismatch fails verification", async () => {
  const s3 = new S3Client({ region: "us-west-1" });
  const send = jest
    .spyOn(s3, "send")
    .mockResolvedValueOnce({} as never)
    .mockResolvedValueOnce({
      ContentLength: 2,
      ChecksumSHA256: "wrong",
    } as never);
  const bytes = Buffer.from("ok");
  await expect(
    awsArchive({ table: "history", bucket: "archive", s3 }).upload(
      "raw/test",
      bytes,
      digest(bytes),
    ),
  ).rejects.toThrow("verification");
  expect(send.mock.calls[0][0].input).toMatchObject({
    IfNoneMatch: "*",
    ChecksumSHA256: Buffer.from(digest(bytes), "hex").toString("base64"),
  });
});

test("existing content-addressed object is verified on a retry, never overwritten", async () => {
  const s3 = new S3Client({ region: "us-west-1" });
  const bytes = Buffer.from("ok");
  const conflict = new Error("exists");
  conflict.name = "PreconditionFailed";
  const send = jest
    .spyOn(s3, "send")
    .mockImplementationOnce(() => {
      throw conflict;
    })
    .mockResolvedValueOnce({
      ContentLength: bytes.length,
      ChecksumSHA256: Buffer.from(digest(bytes), "hex").toString("base64"),
    } as never);
  await awsArchive({ table: "history", bucket: "archive", s3 }).upload(
    "raw/test",
    bytes,
    digest(bytes),
  );
  expect(send.mock.calls).toHaveLength(2);
  expect(send.mock.calls[0][0].input).toMatchObject({ IfNoneMatch: "*" });
});
