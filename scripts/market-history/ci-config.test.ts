import { historyRpcParameter } from "./ci-config.ts";

const path = "/society-bots/market-history/base-rpc";
test("CI reuses only the first configured indexer endpoint in a SecureString", () => {
  expect(
    historyRpcParameter(
      '["https://one.test/key","https://two.test/key"]',
      path,
    ),
  ).toEqual({
    Name: path,
    Type: "SecureString",
    Value: "https://one.test/key",
    Overwrite: true,
  });
});
test.each([
  undefined,
  "secret-not-json",
  "[]",
  "{}",
  '["http://unsafe.test/key"]',
  '["private-key"]',
  "[null]",
])("invalid RPC configuration fails without leaking its contents", (raw) => {
  expect(() => historyRpcParameter(raw, path)).toThrow(/^(Indexer RPC)/);
});
test("CI cannot overwrite an unrelated parameter", () => {
  expect(() =>
    historyRpcParameter('["https://one.test/key"]', "/unrelated"),
  ).toThrow("Unexpected history RPC parameter path");
});
