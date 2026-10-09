import { jest } from "@jest/globals";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { activeDataset, dataset } from "./dataset.ts";
import { scope, metadata } from "./worker-fixture.ts";
import { historyScope } from "./model.ts";
test("warm definition cache never caches the active pointer or prevents a scope switch", async () => {
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "us-west-1" }),
  );
  const prior = historyScope({
    ...scope.registry,
    pools: scope.registry.pools.filter(
      (p) => p.id !== "uniswap-v3-weth-fame-30bps",
    ),
  });
  let active = prior;
  const send = jest
    .spyOn(db, "send")
    .mockImplementation(
      async (c: any) =>
        ({
          Item:
            c.input.Key.sk === "active-scope"
              ? { scopeId: active.id }
              : dataset(active, metadata),
        }) as never,
    );
  expect((await activeDataset("test", db)).scope.id).toBe(prior.id);
  expect(send).toHaveBeenCalledTimes(2);
  expect((await activeDataset("test", db)).scope.id).toBe(prior.id);
  expect(send).toHaveBeenCalledTimes(3);
  active = scope;
  expect((await activeDataset("test", db)).scope.id).toBe(scope.id);
  expect(send).toHaveBeenCalledTimes(5);
  db.destroy();
});
test("active pointer cannot name a differently identified definition", async () => {
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: "us-west-1" }),
  );
  jest
    .spyOn(db, "send")
    .mockResolvedValueOnce({ Item: { scopeId: "a".repeat(64) } } as never)
    .mockResolvedValueOnce({ Item: dataset(scope, metadata) } as never);
  await expect(activeDataset("test", db)).rejects.toThrow(
    "definition mismatch",
  );
  db.destroy();
});
