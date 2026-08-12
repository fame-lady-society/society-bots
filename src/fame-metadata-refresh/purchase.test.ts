import { encodeEventTopics, encodeAbiParameters, padHex, parseAbiParameters, zeroAddress } from "viem";
import { BASE_FAME_CHECKOUT_ADDRESS, BASE_FAME_NFT_ADDRESS, BASE_UNIVERSAL_MARKETPLACE_ADDRESS } from "@/constants.ts";
import { artworkPurchasedEvent, checkoutSettledEvent, ERC721TransferEventAbi } from "@/events.ts";
import { projectPurchaseNotification, purchaseEmbed } from "./purchase.ts";
import fixture from "./_fixtures/base-failing-marketplace-receipt.json";

const RETIRED_MARKETPLACE_ADDRESS = "0x54e7E4F2d439Be599706f51068f7EB2ce2D2a27e";
const RETIRED_FAME_CHECKOUT_ADDRESS = "0x1905B4a633074243f3D9FDB59596fB7419adce2c";

function remapFixtureAddress(address: string) {
  if (address.toLowerCase() === RETIRED_MARKETPLACE_ADDRESS.toLowerCase()) {
    return BASE_UNIVERSAL_MARKETPLACE_ADDRESS;
  }
  if (address.toLowerCase() === RETIRED_FAME_CHECKOUT_ADDRESS.toLowerCase()) {
    return BASE_FAME_CHECKOUT_ADDRESS;
  }
  return address;
}

function projectHistoricalFixtureToActiveStack() {
  const retiredMarketplaceTopic = padHex(RETIRED_MARKETPLACE_ADDRESS as `0x${string}`, { size: 32 }).toLowerCase();
  const activeMarketplaceTopic = padHex(BASE_UNIVERSAL_MARKETPLACE_ADDRESS, { size: 32 });
  return fixture.logs.map((log) => ({
    ...log,
    address: remapFixtureAddress(log.address),
    topics: log.topics.map((topic) => topic.toLowerCase() === retiredMarketplaceTopic ? activeMarketplaceTopic : topic),
  }));
}

describe("marketplace purchase projection", () => {
  it("uses the V3 marketplace and checkout authorities", () => {
    expect(BASE_UNIVERSAL_MARKETPLACE_ADDRESS).toBe("0x93222897902a5Fc2f20079d242c660117277930A");
    expect(BASE_FAME_CHECKOUT_ADDRESS).toBe("0x50B9649Aa28D7d0B966B2A51092C5BcF37905a63");
  });

  it("recognizes a direct FAME purchase only from the canonical marketplace receipt event", () => {
    const buyer = "0x0000000000000000000000000000000000000001" as const;
    const recipient = "0x0000000000000000000000000000000000000002" as const;
    const topics = encodeEventTopics({ abi: [artworkPurchasedEvent], eventName: "ArtworkPurchased", args: { buyer, recipient, shellId: 42n } });
    const transferTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, to: recipient, tokenId: 42n } });
    const data = encodeAbiParameters(parseAbiParameters("uint8 path, uint256 sourceId, bytes32 artwork, uint256 unitAmount, uint256 grossPremiumAmount, uint256 inventoryBefore, uint256 inventoryAfter"), [0, 0n, `0x${"00".repeat(32)}`, 10n, 2n, 3n, 4n]);
    expect(projectPurchaseNotification({ transactionHash: `0x${"11".repeat(32)}`, logs: [{ address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, topics, data }, { address: BASE_FAME_NFT_ADDRESS, topics: transferTopics, data: "0x" }] as never })).toMatchObject({ tokenId: 42n, buyer, recipient, payment: { asset: "FAME", amount: 12n, decimals: 18 } });
  });

  it("ignores a retired checkout settlement alongside a V3 marketplace purchase", () => {
    const buyer = "0x0000000000000000000000000000000000000001" as const;
    const recipient = "0x0000000000000000000000000000000000000002" as const;
    const purchaseTopics = encodeEventTopics({ abi: [artworkPurchasedEvent], eventName: "ArtworkPurchased", args: { buyer, recipient, shellId: 42n } });
    const purchaseData = encodeAbiParameters(parseAbiParameters("uint8 path, uint256 sourceId, bytes32 artwork, uint256 unitAmount, uint256 grossPremiumAmount, uint256 inventoryBefore, uint256 inventoryAfter"), [0, 0n, `0x${"00".repeat(32)}`, 10n, 2n, 3n, 4n]);
    const deliveryTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, to: recipient, tokenId: 42n } });
    const settlementTopics = encodeEventTopics({ abi: [checkoutSettledEvent], eventName: "CheckoutSettled", args: { buyer, inputAsset: zeroAddress, shellId: 42n } });
    const settlementData = encodeAbiParameters(parseAbiParameters("bytes32 routeHash, uint8 fulfillmentPath, uint256 sourceId, bytes32 artwork, uint256 inputAmount, uint256 inputRefund, uint256 routerFameOutput, uint256 marketplaceFameCharge, uint256 fameRefund"), [`0x${"00".repeat(32)}`, 0, 0n, `0x${"00".repeat(32)}`, 10_000_000_000_000_000_000n, 1_000_000_000_000_000_000n, 12n, 12n, 0n]);

    expect(projectPurchaseNotification({
      transactionHash: `0x${"11".repeat(32)}`,
      logs: [
        { address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, topics: purchaseTopics, data: purchaseData },
        { address: BASE_FAME_NFT_ADDRESS, topics: deliveryTopics, data: "0x" },
        { address: RETIRED_FAME_CHECKOUT_ADDRESS, topics: settlementTopics, data: settlementData },
      ] as never,
    })).toMatchObject({ tokenId: 42n, buyer, recipient, payment: { asset: "FAME", amount: 12n, decimals: 18 } });
  });

  it("rejects a lookalike event from any other address", () => {
    expect(projectPurchaseNotification({ transactionHash: `0x${"11".repeat(32)}`, logs: [] })).toBeNull();
  });

  it("rejects the historical receipt from the retired marketplace", () => {
    expect(projectPurchaseNotification({
      transactionHash: fixture.transactionHash as `0x${string}`,
      logs: fixture.logs as never,
    })).toBeNull();
  });

  it("projects a test-only active-stack copy of the historical receipt as a USDC Society purchase", () => {
    const notification = projectPurchaseNotification({
      transactionHash: fixture.transactionHash as `0x${string}`,
      logs: projectHistoricalFixtureToActiveStack() as never,
    });
    expect(notification).toMatchObject({ tokenId: 152n, payment: { asset: "USDC", decimals: 6 } });
  });

  it("attributes a forwarded purchase to the final FAME NFT holder", () => {
    const buyer = "0x0000000000000000000000000000000000000001" as const;
    const recipient = "0x0000000000000000000000000000000000000002" as const;
    const finalOwner = "0x0000000000000000000000000000000000000003" as const;
    const purchaseTopics = encodeEventTopics({ abi: [artworkPurchasedEvent], eventName: "ArtworkPurchased", args: { buyer, recipient, shellId: 42n } });
    const purchaseData = encodeAbiParameters(parseAbiParameters("uint8 path, uint256 sourceId, bytes32 artwork, uint256 unitAmount, uint256 grossPremiumAmount, uint256 inventoryBefore, uint256 inventoryAfter"), [0, 0n, `0x${"00".repeat(32)}`, 10n, 2n, 3n, 4n]);
    const deliveryTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, to: recipient, tokenId: 42n } });
    const forwardingTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: recipient, to: finalOwner, tokenId: 42n } });

    expect(projectPurchaseNotification({
      transactionHash: `0x${"11".repeat(32)}`,
      logs: [
        { address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, topics: purchaseTopics, data: purchaseData },
        { address: BASE_FAME_NFT_ADDRESS, topics: deliveryTopics, data: "0x" },
        { address: BASE_FAME_NFT_ADDRESS, topics: forwardingTopics, data: "0x" },
      ] as never,
    })).toMatchObject({ tokenId: 42n, recipient: finalOwner });
  });

  it("projects a native ETH checkout using the net settled amount", () => {
    const buyer = "0x0000000000000000000000000000000000000001" as const;
    const recipient = "0x0000000000000000000000000000000000000002" as const;
    const purchaseTopics = encodeEventTopics({ abi: [artworkPurchasedEvent], eventName: "ArtworkPurchased", args: { buyer, recipient, shellId: 42n } });
    const purchaseData = encodeAbiParameters(parseAbiParameters("uint8 path, uint256 sourceId, bytes32 artwork, uint256 unitAmount, uint256 grossPremiumAmount, uint256 inventoryBefore, uint256 inventoryAfter"), [0, 0n, `0x${"00".repeat(32)}`, 10n, 2n, 3n, 4n]);
    const deliveryTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, to: recipient, tokenId: 42n } });
    const settlementTopics = encodeEventTopics({ abi: [checkoutSettledEvent], eventName: "CheckoutSettled", args: { buyer, inputAsset: zeroAddress, shellId: 42n } });
    const settlementData = encodeAbiParameters(parseAbiParameters("bytes32 routeHash, uint8 fulfillmentPath, uint256 sourceId, bytes32 artwork, uint256 inputAmount, uint256 inputRefund, uint256 routerFameOutput, uint256 marketplaceFameCharge, uint256 fameRefund"), [`0x${"00".repeat(32)}`, 0, 0n, `0x${"00".repeat(32)}`, 10_000_000_000_000_000_000n, 1_000_000_000_000_000_000n, 12n, 12n, 0n]);

    expect(projectPurchaseNotification({
      transactionHash: `0x${"11".repeat(32)}`,
      logs: [
        { address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, topics: purchaseTopics, data: purchaseData },
        { address: BASE_FAME_NFT_ADDRESS, topics: deliveryTopics, data: "0x" },
        { address: BASE_FAME_CHECKOUT_ADDRESS, topics: settlementTopics, data: settlementData },
      ] as never,
    })).toMatchObject({ tokenId: 42n, recipient, payment: { asset: "ETH", amount: 9_000_000_000_000_000_000n, decimals: 18 } });
  });

  it("rejects a purchase when later FAME NFT ownership cannot be derived", () => {
    const buyer = "0x0000000000000000000000000000000000000001" as const;
    const recipient = "0x0000000000000000000000000000000000000002" as const;
    const unrelated = "0x0000000000000000000000000000000000000003" as const;
    const finalOwner = "0x0000000000000000000000000000000000000004" as const;
    const purchaseTopics = encodeEventTopics({ abi: [artworkPurchasedEvent], eventName: "ArtworkPurchased", args: { buyer, recipient, shellId: 42n } });
    const purchaseData = encodeAbiParameters(parseAbiParameters("uint8 path, uint256 sourceId, bytes32 artwork, uint256 unitAmount, uint256 grossPremiumAmount, uint256 inventoryBefore, uint256 inventoryAfter"), [0, 0n, `0x${"00".repeat(32)}`, 10n, 2n, 3n, 4n]);
    const deliveryTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, to: recipient, tokenId: 42n } });
    const ambiguousTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: unrelated, to: finalOwner, tokenId: 42n } });

    expect(projectPurchaseNotification({
      transactionHash: `0x${"11".repeat(32)}`,
      logs: [
        { address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, topics: purchaseTopics, data: purchaseData },
        { address: BASE_FAME_NFT_ADDRESS, topics: deliveryTopics, data: "0x" },
        { address: BASE_FAME_NFT_ADDRESS, topics: ambiguousTopics, data: "0x" },
      ] as never,
    })).toBeNull();
  });

  it("uses the recipient's resolved ENS name for the new-owner field", () => {
    const purchase = { transactionHash: `0x${"11".repeat(32)}` as const, tokenId: 42n, buyer: "0x0000000000000000000000000000000000000001" as const, recipient: "0x0000000000000000000000000000000000000002" as const, payment: { asset: "FAME" as const, amount: 12n, decimals: 18 } };
    const embed = purchaseEmbed(purchase, "fame.eth", "https://gateway.irys.xyz/current-art");
    expect(embed.fields[0]).toMatchObject({ name: "new owner", value: "fame.eth" });
    expect(embed.image).toEqual({ url: "https://gateway.irys.xyz/current-art" });
  });
});
