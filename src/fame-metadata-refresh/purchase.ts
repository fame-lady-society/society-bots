import { BaseError, ContractFunctionRevertedError, decodeEventLog, erc721Abi, formatUnits, isAddressEqual, zeroAddress, type Address, type Log } from "viem";
import { base } from "viem/chains";
import { BASE_FAME_ADDRESS, BASE_FAME_CHECKOUT_ADDRESS, BASE_FAME_NFT_ADDRESS, BASE_UNIVERSAL_MARKETPLACE_ADDRESS, BASE_USDC_ADDRESS, BASE_WETH_ADDRESS } from "@/constants.ts";
import { artworkPurchasedEvent, checkoutSettledEvent, ERC721TransferEventAbi } from "@/events.ts";
import { METADATA_REQUEST_TIMEOUT_MS } from "./opensea.ts";
import type { PurchaseNotification } from "./types.ts";

type ReceiptLog = Pick<Log, "address" | "data" | "topics">;
type DecodedEvent = { eventName: string; args: Record<string, unknown> };
const fameNftMetadataAbi = [
  ...erc721Abi,
  { type: "error", inputs: [], name: "TokenDoesNotExist" },
] as const;

function decode(log: ReceiptLog, event: typeof artworkPurchasedEvent | typeof checkoutSettledEvent): DecodedEvent {
  return decodeEventLog({ abi: [event], data: log.data, topics: log.topics, strict: true }) as DecodedEvent;
}

function decodeTransfer(log: ReceiptLog): DecodedEvent {
  return decodeEventLog({ abi: [ERC721TransferEventAbi], data: log.data, topics: log.topics, strict: true }) as DecodedEvent;
}

function matching(logs: readonly ReceiptLog[], address: Address) {
  return logs.filter((log) => isAddressEqual(log.address, address));
}

export function projectPurchaseNotification({ transactionHash, logs }: { transactionHash: `0x${string}`; logs: readonly ReceiptLog[] }): PurchaseNotification | null {
  const purchaseLogs = matching(logs, BASE_UNIVERSAL_MARKETPLACE_ADDRESS as Address)
    .map((log) => { try { return decode(log, artworkPurchasedEvent); } catch { return null; } })
    .filter((event): event is DecodedEvent => event?.eventName === "ArtworkPurchased");
  if (purchaseLogs.length !== 1) return null;
  const purchase = purchaseLogs[0].args;
  if (typeof purchase.buyer !== "string" || typeof purchase.recipient !== "string" || typeof purchase.shellId !== "bigint" || typeof purchase.unitAmount !== "bigint" || typeof purchase.grossPremiumAmount !== "bigint") return null;
  const transfers = logs
    .map((log, receiptIndex) => {
      if (!isAddressEqual(log.address, BASE_FAME_NFT_ADDRESS as Address)) return null;
      try { return { event: decodeTransfer(log), receiptIndex }; } catch { return null; }
    })
    .filter((entry): entry is { event: DecodedEvent; receiptIndex: number } => entry?.event.eventName === "Transfer")
    .filter(
      ({ event }) =>
        typeof event.args.from === "string" &&
        typeof event.args.to === "string" &&
        event.args.tokenId === purchase.shellId,
    );
  const deliveries = transfers.filter(({ event }) =>
    isAddressEqual(event.args.from as Address, BASE_UNIVERSAL_MARKETPLACE_ADDRESS as Address) &&
    isAddressEqual(event.args.to as Address, purchase.recipient as Address),
  );
  if (deliveries.length !== 1) return null;
  let finalOwner = purchase.recipient as Address;
  for (const { event } of transfers.filter(({ receiptIndex }) => receiptIndex > deliveries[0].receiptIndex)) {
    if (!isAddressEqual(event.args.from as Address, finalOwner)) return null;
    finalOwner = event.args.to as Address;
  }
  if (isAddressEqual(finalOwner, zeroAddress)) return null;
  const basePurchase = { transactionHash, tokenId: purchase.shellId, buyer: purchase.buyer as Address, recipient: finalOwner };
  const settlements = matching(logs, BASE_FAME_CHECKOUT_ADDRESS as Address)
    .map((log) => { try { return decode(log, checkoutSettledEvent); } catch { return null; } })
    .filter((event): event is DecodedEvent => event?.eventName === "CheckoutSettled")
    .filter((event) => typeof event.args.buyer === "string" && event.args.buyer.toLowerCase() === purchase.buyer?.toString().toLowerCase() && event.args.shellId === purchase.shellId);
  if (settlements.length === 0) {
    return { ...basePurchase, payment: { asset: "FAME", amount: purchase.unitAmount + purchase.grossPremiumAmount, decimals: 18 } };
  }
  if (settlements.length !== 1) return null;
  const settlement = settlements[0].args;
  if (typeof settlement.inputAsset !== "string" || typeof settlement.inputAmount !== "bigint" || typeof settlement.inputRefund !== "bigint" || settlement.inputRefund > settlement.inputAmount) return null;
  const asset = settlement.inputAsset.toLowerCase();
  if (asset === zeroAddress) return { ...basePurchase, payment: { asset: "ETH", amount: settlement.inputAmount - settlement.inputRefund, decimals: 18 } };
  if (asset === BASE_USDC_ADDRESS.toLowerCase()) return { ...basePurchase, payment: { asset: "USDC", amount: settlement.inputAmount - settlement.inputRefund, decimals: 6 } };
  if (asset === BASE_WETH_ADDRESS.toLowerCase()) return { ...basePurchase, payment: { asset: "WETH", amount: settlement.inputAmount - settlement.inputRefund, decimals: 18 } };
  if (asset === BASE_FAME_ADDRESS.toLowerCase()) return { ...basePurchase, payment: { asset: "FAME", amount: settlement.inputAmount - settlement.inputRefund, decimals: 18 } };
  return null;
}

export function isMissingFameNft(error: unknown) {
  const reverted = error instanceof BaseError
    ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
    : null;
  return reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === "TokenDoesNotExist";
}

export async function authoritativeMetadata({ client, tokenId, fetcher = fetch }: { client: { readContract(args: { abi: typeof fameNftMetadataAbi; address: Address; functionName: "tokenURI"; args: [bigint] }): Promise<string> }; tokenId: bigint; fetcher?: typeof fetch }) {
  const tokenUri = await client.readContract({ abi: fameNftMetadataAbi, address: BASE_FAME_NFT_ADDRESS as Address, functionName: "tokenURI", args: [tokenId] });
  const response = await fetcher(tokenUri, { signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error("Authoritative metadata read failed");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object") throw new Error("Authoritative metadata is malformed");
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.name !== "string" || typeof metadata.description !== "string" || typeof metadata.image !== "string") throw new Error("Authoritative metadata is incomparable");
  return { name: metadata.name, description: metadata.description, image: metadata.image };
}

export function purchaseEmbed(purchase: PurchaseNotification, recipientDisplayName: string = purchase.recipient) {
  return {
    title: "$FAME Society Purchased",
    description: `FAME Society #${purchase.tokenId.toString()} was purchased.`,
    url: `${base.blockExplorers.default.url}/tx/${purchase.transactionHash}`,
    image: { url: `https://${process.env.IMAGE_HOST}/thumb/${purchase.tokenId.toString()}` },
    fields: [
      { name: "new owner", value: recipientDisplayName, inline: true },
      { name: "paid", value: `${formatUnits(purchase.payment.amount, purchase.payment.decimals)} ${purchase.payment.asset}`, inline: true },
    ],
  };
}
