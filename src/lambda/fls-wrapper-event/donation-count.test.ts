import { describe, expect, it, jest } from "@jest/globals";

import { readTotalDonatedCount } from "./donation-count.ts";

const wrappedNftAddress = "0x6cf4328f1ea83b5d592474f9fcdc714faafd1574" as const;
const currentDonationVault =
  "0x0000fA3e509D629516Ae56dc6FDd31047300114D" as const;

describe("readTotalDonatedCount", () => {
  it("reads the wrapped NFT balance of the vault supplied by the donation event", async () => {
    const readContract = jest.fn(async () => 110n);

    await expect(
      readTotalDonatedCount({
        client: { readContract } as never,
        wrappedNftAddress,
        vaultAddress: currentDonationVault,
      }),
    ).resolves.toBe(110n);

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: wrappedNftAddress,
        functionName: "balanceOf",
        args: [currentDonationVault],
      }),
    );
  });
});
