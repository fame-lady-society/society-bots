import { describe, expect, it, jest } from "@jest/globals";

import { runIndependentLanes } from "./lanes.ts";

describe("runIndependentLanes", () => {
  it("attempts every lane before surfacing a failure", async () => {
    const failure = new Error("wrapper failed");
    const wrapper = jest.fn(async () => {
      throw failure;
    });
    const profiles = jest.fn(async () => undefined);

    await expect(
      runIndependentLanes([
        { name: "wrapper", run: wrapper },
        { name: "profiles", run: profiles },
      ]),
    ).rejects.toMatchObject({
      message: "Scheduled lanes failed: wrapper",
      errors: [failure],
    });
    expect(wrapper).toHaveBeenCalledTimes(1);
    expect(profiles).toHaveBeenCalledTimes(1);
  });
});
