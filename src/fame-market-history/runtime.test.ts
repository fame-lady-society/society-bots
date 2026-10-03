import { configuration } from "./runtime.ts";

const env = {
  FAME_HISTORY_RPC_URL: "https://example.test",
  FAME_HISTORY_POOL_STATE_TABLE: "existing-pools",
  FAME_HISTORY_START_BLOCK: "100",
};
test("read-only rehearsal works before history resources exist", () => {
  expect(configuration(env, true)).toMatchObject({
    table: "",
    bucket: "",
    startBlock: 100,
  });
});
test("production requires real storage and an explicit daily allowance", () => {
  expect(() => configuration(env)).toThrow("FAME_HISTORY_TABLE");
  expect(() =>
    configuration({
      ...env,
      FAME_HISTORY_TABLE: "history",
      FAME_HISTORY_BUCKET: "archive",
    }),
  ).toThrow("FAME_HISTORY_DAILY_REQUESTS");
});
test("invalid bounds fail before any work", () => {
  expect(() =>
    configuration({ ...env, FAME_HISTORY_MAX_REQUESTS: "0" }, true),
  ).toThrow("MAX_REQUESTS");
  expect(() =>
    configuration({ ...env, FAME_HISTORY_START_BLOCK: "NaN" }, true),
  ).toThrow("START_BLOCK");
});
