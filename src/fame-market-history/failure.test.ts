import { failureCode } from "./failure.ts";
test("failure labels cannot leak provider messages or credentials", () => {
  expect(
    failureCode(new Error("https://provider.example/private-api-key")),
  ).toBe("collection-failed");
  expect(
    failureCode(
      new Error("viem wrapped", {
        cause: new Error("Daily RPC allowance unavailable or exhausted"),
      }),
    ),
  ).toBe("daily-allowance-unavailable");
  expect(
    failureCode(
      new Error("Committed boundary hash changed; history repair required"),
    ),
  ).toBe("canonical-conflict");
});
