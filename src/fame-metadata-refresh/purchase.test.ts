import { encodeEventTopics, encodeAbiParameters, parseAbiParameters } from "viem";
import { BASE_FAME_NFT_ADDRESS, BASE_UNIVERSAL_MARKETPLACE_ADDRESS } from "@/constants.ts";
import { artworkPurchasedEvent, ERC721TransferEventAbi } from "@/events.ts";
import { projectPurchaseNotification, purchaseEmbed } from "./purchase.ts";
import fixture from "./_fixtures/base-failing-marketplace-receipt.json";

describe("marketplace purchase projection", () => {
  it("recognizes a direct FAME purchase only from the canonical marketplace receipt event", () => {
    const buyer = "0x0000000000000000000000000000000000000001" as const;
    const recipient = "0x0000000000000000000000000000000000000002" as const;
    const topics = encodeEventTopics({ abi: [artworkPurchasedEvent], eventName: "ArtworkPurchased", args: { buyer, recipient, shellId: 42n } });
    const transferTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, to: recipient, tokenId: 42n } });
    const data = encodeAbiParameters(parseAbiParameters("uint8 path, uint256 sourceId, bytes32 artwork, uint256 unitAmount, uint256 grossPremiumAmount, uint256 inventoryBefore, uint256 inventoryAfter"), [0, 0n, `0x${"00".repeat(32)}`, 10n, 2n, 3n, 4n]);
    expect(projectPurchaseNotification({ transactionHash: `0x${"11".repeat(32)}`, logs: [{ address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, topics, data }, { address: BASE_FAME_NFT_ADDRESS, topics: transferTopics, data: "0x" }] })).toMatchObject({ tokenId: 42n, buyer, recipient, payment: { asset: "FAME", amount: 12n, decimals: 18 } });
  });

  it("rejects a lookalike event from any other address", () => {
    expect(projectPurchaseNotification({ transactionHash: `0x${"11".repeat(32)}`, logs: [] })).toBeNull();
  });

  it("projects the supplied failing Base marketplace receipt as a USDC Society purchase", () => {
    const notification = projectPurchaseNotification({
      transactionHash: fixture.transactionHash as `0x${string}`,
      logs: fixture.logs as never,
    });
    expect(notification).toMatchObject({ tokenId: 152n, payment: { asset: "USDC", decimals: 6 } });
  });

  it("uses the recipient's resolved ENS name for the new-owner field", () => {
    const purchase = { transactionHash: `0x${"11".repeat(32)}`, tokenId: 42n, buyer: "0x0000000000000000000000000000000000000001", recipient: "0x0000000000000000000000000000000000000002", payment: { asset: "FAME" as const, amount: 12n, decimals: 18 } };
    expect(purchaseEmbed(purchase, "fame.eth").fields[0]).toMatchObject({ name: "new owner", value: "fame.eth" });
  });
});
