import { jest, afterEach } from "@jest/globals";
import {
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { historyStart, START_PARAMETER } from "./start-marker.ts";
import type { Header } from "../../src/fame-market-history/model.ts";
const block = (number = 100): Header => ({
  number,
  hash: `0x${"a".repeat(64)}`,
  parentHash: `0x${"b".repeat(64)}`,
  timestamp: 1700000100,
});
const error = (name: string) =>
  Object.assign(new Error("details must not trigger reset"), { name });
afterEach(() => {
  jest.restoreAllMocks();
});
function fixture() {
  const ssm = new SSMClient({ region: "us-west-1" });
  let saved: string | undefined;
  let loseResponse = false;
  const send = jest
    .spyOn(ssm, "send")
    .mockImplementation(async (command: unknown) => {
      if (command instanceof GetParameterCommand) {
        expect(command.input).toEqual({ Name: START_PARAMETER });
        if (saved === undefined) throw error("ParameterNotFound");
        return { Parameter: { Value: saved } };
      }
      if (!(command instanceof PutParameterCommand))
        throw new Error("Unexpected write");
      expect(command.input).toMatchObject({
        Name: START_PARAMETER,
        Type: "String",
        Overwrite: false,
      });
      if (saved !== undefined) throw error("ParameterAlreadyExists");
      saved = command.input.Value;
      if (loseResponse) throw error("TimeoutError");
      return {};
    });
  return {
    ssm,
    send,
    saved: () => saved,
    set: (value: string) => (saved = value),
    loseResponse: () => (loseResponse = true),
  };
}
test("first deployment marks finalized block, hash and time; updates never query a new head", async () => {
  const f = fixture();
  const finalized = jest.fn(async () => block());
  const first = await historyStart(f.ssm, finalized, () => 1700000200000);
  expect(first).toEqual({
    version: 1,
    chainId: 8453,
    block: block(),
    selectedAt: 1700000200000,
  });
  expect(JSON.parse(f.saved()!)).toEqual(first);
  const newer = jest.fn(async () => block(200));
  expect(await historyStart(f.ssm, newer)).toEqual(first);
  expect(finalized).toHaveBeenCalledTimes(1);
  expect(newer).not.toHaveBeenCalled();
  expect(
    f.send.mock.calls.filter(([c]) => c instanceof PutParameterCommand),
  ).toHaveLength(1);
});
test("two initializers converge on one durable start", async () => {
  const f = fixture();
  const result = await Promise.all([
    historyStart(
      f.ssm,
      async () => block(100),
      () => 1,
    ),
    historyStart(
      f.ssm,
      async () => block(200),
      () => 2,
    ),
  ]);
  expect(result[0]).toEqual(result[1]);
  expect(result[0]).toEqual(JSON.parse(f.saved()!));
});
test("lost write response cannot move the start on a retry", async () => {
  const f = fixture();
  f.loseResponse();
  await expect(historyStart(f.ssm, async () => block())).rejects.toThrow();
  const finalized = jest.fn(async () => block(200));
  expect((await historyStart(f.ssm, finalized)).block.number).toBe(100);
  expect(finalized).not.toHaveBeenCalled();
});
test.each(["AccessDeniedException", "ThrottlingException", "TimeoutError"])(
  "SSM read failure (%s) is not treated as first launch",
  async (name) => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => {
      throw error(name);
    });
    const finalized = jest.fn(async () => block());
    await expect(historyStart(f.ssm, finalized)).rejects.toHaveProperty(
      "name",
      name,
    );
    expect(finalized).not.toHaveBeenCalled();
    expect(f.saved()).toBeUndefined();
  },
);
test.each([
  "not-json",
  JSON.stringify({ version: 1, chainId: 1, block: block(), selectedAt: 1 }),
  JSON.stringify({
    version: 1,
    chainId: 8453,
    block: { ...block(), number: 1.5 },
    selectedAt: 1,
  }),
])("invalid saved marker fails instead of resetting (%s)", async (value) => {
  const f = fixture();
  f.set(value);
  const finalized = jest.fn(async () => block());
  await expect(historyStart(f.ssm, finalized)).rejects.toThrow();
  expect(finalized).not.toHaveBeenCalled();
  expect(f.saved()).toBe(value);
});
test("a failed finalized RPC read cannot mark a start", async () => {
  const f = fixture();
  await expect(
    historyStart(f.ssm, async () => {
      throw error("RpcError");
    }),
  ).rejects.toHaveProperty("name", "RpcError");
  expect(f.saved()).toBeUndefined();
});
