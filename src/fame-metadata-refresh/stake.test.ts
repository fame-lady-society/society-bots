import { describe, expect, it } from "@jest/globals";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Address } from "viem";
import { BASE_UNIVERSAL_MARKETPLACE_ADDRESS } from "@/constants.ts";
import { inventoryBatchDepositedEvent, inventoryDepositedEvent } from "@/events.ts";
import { authoritativeImage } from "./purchase.ts";
import { projectStakeNotification, stakeEmbed } from "./stake.ts";

const transactionHash = `0x${"11".repeat(32)}` as const;
const provider = "0x0000000000000000000000000000000000000001" as const;
const otherProvider = "0x0000000000000000000000000000000000000002" as const;

function singleLog(tokenId: bigint, logIndex = 1, address: string = BASE_UNIVERSAL_MARKETPLACE_ADDRESS, eventProvider: Address = provider, providerUnits = 1n) {
  return {
    address,
    logIndex,
    topics: encodeEventTopics({ abi: [inventoryDepositedEvent], eventName: "InventoryDeposited", args: { provider: eventProvider, tokenId } }),
    data: encodeAbiParameters(parseAbiParameters("uint256 providerUnits"), [providerUnits]),
  };
}

function batchLog(tokenIds: readonly bigint[], logIndex = 1, eventProvider: Address = provider, providerUnits = BigInt(tokenIds.length)) {
  return {
    address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS,
    logIndex,
    topics: encodeEventTopics({ abi: [inventoryBatchDepositedEvent], eventName: "InventoryBatchDeposited", args: { provider: eventProvider } }),
    data: encodeAbiParameters(parseAbiParameters("uint256[] tokenIds, uint256 providerUnits"), [tokenIds, providerUnits]),
  };
}

describe("marketplace stake projection", () => {
  it("projects a direct single-token deposit", () => {
    expect(projectStakeNotification({ transactionHash, logs: [singleLog(42n)] as never })).toEqual({
      transactionHash,
      provider,
      tokenIds: [42n],
      providerUnits: 1n,
    });
  });

  it("projects one-token and eight-token batches", () => {
    expect(projectStakeNotification({ transactionHash, logs: [batchLog([42n])] as never })?.tokenIds).toEqual([42n]);
    const tokenIds = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];
    expect(projectStakeNotification({ transactionHash, logs: [batchLog(tokenIds)] as never })).toMatchObject({ tokenIds, providerUnits: 8n });
  });

  it("flattens mixed events in receipt-log and batch-array order", () => {
    expect(projectStakeNotification({
      transactionHash,
      logs: [singleLog(9n, 7, BASE_UNIVERSAL_MARKETPLACE_ADDRESS, provider, 4n), batchLog([4n, 5n], 3, provider, 2n), singleLog(8n, 5, BASE_UNIVERSAL_MARKETPLACE_ADDRESS, provider, 3n)] as never,
    })).toMatchObject({ tokenIds: [4n, 5n, 8n, 9n], providerUnits: 4n });
  });

  it("ignores lookalike events from another contract", () => {
    expect(projectStakeNotification({ transactionHash, logs: [singleLog(42n, 1, otherProvider)] as never })).toBeNull();
  });

  it("rejects inconsistent providers", () => {
    expect(() => projectStakeNotification({ transactionHash, logs: [singleLog(42n), singleLog(43n, 2, BASE_UNIVERSAL_MARKETPLACE_ADDRESS, otherProvider, 2n)] as never })).toThrow("multiple providers");
  });

  it("rejects a malformed canonical staking event", () => {
    expect(() => projectStakeNotification({
      transactionHash,
      logs: [{ ...singleLog(42n), data: "0x" }] as never,
    })).toThrow("could not be decoded");
  });

  it("builds one summary card with every token and the first artwork featured", () => {
    const stake = projectStakeNotification({ transactionHash, logs: [batchLog([42n, 43n, 44n])] as never });
    if (!stake) throw new Error("Expected a stake projection");
    const imageUrl = "https://gateway.irys.xyz/current-art?revision=7";
    const embed = stakeEmbed(stake, "staker.eth", imageUrl);
    expect(embed).toMatchObject({
      title: "$FAME Society Staked",
      description: "3 FAME Society NFTs were staked.",
      url: `https://basescan.org/tx/${transactionHash}`,
      image: { url: imageUrl },
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "staked by", value: "staker.eth" }),
        expect.objectContaining({ name: "featured artwork", value: "FAME Society #42" }),
        expect.objectContaining({ name: "staked NFTs", value: "#42, #43, #44" }),
      ]),
    });
  });

  it("accepts an image-only authoritative metadata document without rewriting its URL", async () => {
    const imageUrl = "https://gateway.irys.xyz/current-art?revision=7";
    const client = { readContract: async () => "https://metadata.example/42" };
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ image: imageUrl }), { status: 200 });
    await expect(authoritativeImage({ client: client as never, tokenId: 42n, fetcher })).resolves.toBe(imageUrl);
  });
});
