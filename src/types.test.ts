import { asNotificationType, isNotificationType } from "./types.ts";

describe("FAME notification types", () => {
  it("supports swaps but no longer accepts NFT mint or burn alerts", () => {
    expect(isNotificationType("fame-buy")).toBe(true);
    expect(isNotificationType("fame-sell")).toBe(true);
    expect(isNotificationType("fame-nft-mint")).toBe(false);
    expect(isNotificationType("fame-nft-burn")).toBe(false);
    expect(() => asNotificationType("fame-nft-mint")).toThrow("Invalid notification type");
    expect(() => asNotificationType("fame-nft-burn")).toThrow("Invalid notification type");
  });
});
