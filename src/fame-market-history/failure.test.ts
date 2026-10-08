import { failureCode } from "./failure.ts";
test("failure labels cannot leak provider messages or credentials", () => {
  expect(
    failureCode(new Error("https://provider.example/private-api-key")),
  ).toBe("collection-failed");
  expect(
    failureCode(
      new Error("viem wrapped", {
        cause: new Error("Single block exceeds event capacity"),
      }),
    ),
  ).toBe("single-block-capacity");
  expect(
    failureCode(
      new Error("Committed boundary hash changed; history repair required"),
    ),
  ).toBe("canonical-conflict");
});

test("wrapped capacity failures have actionable fixed labels", async () => {
  const { RangeLimit, WorkLimit } = await import("./limits.ts");
  expect(
    failureCode(new WorkLimit("Single block exceeds event capacity")),
  ).toBe("single-block-capacity");
  expect(
    failureCode(
      new Error("provider wrapper", {
        cause: new RangeLimit("RPC response byte limit exceeded"),
      }),
    ),
  ).toBe("rpc-response-limit");
  expect(
    failureCode(
      new Error("provider wrapper", {
        cause: new WorkLimit("Total RPC response allowance exhausted"),
      }),
    ),
  ).toBe("work-limit");
});
