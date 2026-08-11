import { decodeEventLog, encodeEventTopics, isAddressEqual, type Address, type Log } from "viem";
import { base } from "viem/chains";
import { BASE_UNIVERSAL_MARKETPLACE_ADDRESS } from "@/constants.ts";
import { inventoryBatchDepositedEvent, inventoryDepositedEvent } from "@/events.ts";
import type { StakeNotification } from "./types.ts";

type ReceiptLog = Pick<Log, "address" | "data" | "topics" | "logIndex">;
type DecodedStakeEvent = {
  provider: Address;
  tokenIds: readonly bigint[];
  providerUnits: bigint;
  logIndex: number;
};

const DISCORD_FIELD_VALUE_LIMIT = 1_024;
const MAX_TOKEN_FIELDS = 22;
const MAX_TOKEN_FIELD_CHARACTERS = 4_000;

export const marketplaceStakeEvents = [inventoryDepositedEvent, inventoryBatchDepositedEvent] as const;
const stakeEventTopics = new Set(marketplaceStakeEvents.map((event) => encodeEventTopics({ abi: [event] })[0].toLowerCase()));

function decodeStakeEvent(log: ReceiptLog): DecodedStakeEvent | null {
  if (!isAddressEqual(log.address, BASE_UNIVERSAL_MARKETPLACE_ADDRESS as Address)) return null;
  if (typeof log.logIndex !== "number") throw new Error("Marketplace staking receipt log is malformed");
  const topic = log.topics[0]?.toLowerCase();
  if (!topic || !stakeEventTopics.has(topic)) return null;
  try {
    const decoded = decodeEventLog({ abi: marketplaceStakeEvents, data: log.data, topics: log.topics, strict: true });
    if (decoded.eventName === "InventoryDeposited") {
      return { provider: decoded.args.provider, tokenIds: [decoded.args.tokenId], providerUnits: decoded.args.providerUnits, logIndex: log.logIndex };
    }
    if (decoded.eventName === "InventoryBatchDeposited") {
      return { provider: decoded.args.provider, tokenIds: decoded.args.tokenIds, providerUnits: decoded.args.providerUnits, logIndex: log.logIndex };
    }
    return null;
  } catch {
    throw new Error("Marketplace staking event could not be decoded");
  }
}

export function projectStakeNotification({ transactionHash, logs }: { transactionHash: `0x${string}`; logs: readonly ReceiptLog[] }): StakeNotification | null {
  const events = logs
    .map(decodeStakeEvent)
    .filter((event): event is DecodedStakeEvent => event !== null)
    .sort((left, right) => left.logIndex - right.logIndex);
  if (events.length === 0) return null;

  let provider: Address | null = null;
  let providerUnits = 0n;
  const tokenIds: bigint[] = [];
  for (const event of events) {
    if (provider !== null && !isAddressEqual(provider, event.provider)) {
      throw new Error("Marketplace staking transaction has multiple providers");
    }
    provider = event.provider;
    providerUnits = event.providerUnits;
    if (event.tokenIds.length === 0) {
      throw new Error("Marketplace batch staking event is malformed");
    }
    tokenIds.push(...event.tokenIds);
  }
  if (provider === null || tokenIds.length === 0 || new Set(tokenIds).size !== tokenIds.length) {
    throw new Error("Marketplace staking transaction is malformed");
  }
  return { transactionHash, provider, tokenIds, providerUnits };
}

function tokenFields(tokenIds: readonly bigint[]) {
  const fields: { name: string; value: string; inline: false }[] = [];
  let value = "";
  for (const tokenId of tokenIds) {
    const label = `#${tokenId.toString()}`;
    const candidate = value.length === 0 ? label : `${value}, ${label}`;
    if (candidate.length <= DISCORD_FIELD_VALUE_LIMIT) {
      value = candidate;
      continue;
    }
    fields.push({ name: fields.length === 0 ? "staked NFTs" : "staked NFTs (continued)", value, inline: false });
    value = label;
  }
  fields.push({ name: fields.length === 0 ? "staked NFTs" : "staked NFTs (continued)", value, inline: false });
  if (fields.length > MAX_TOKEN_FIELDS || fields.reduce((total, field) => total + field.value.length, 0) > MAX_TOKEN_FIELD_CHARACTERS) {
    throw new Error("Marketplace staking notification exceeds Discord embed limits");
  }
  return fields;
}

export function stakeEmbed(stake: StakeNotification, providerDisplayName: string, imageUrl: string) {
  const featuredTokenId = stake.tokenIds[0];
  const count = stake.tokenIds.length;
  return {
    title: "$FAME Society Staked",
    description: `${count.toString()} FAME Society NFT${count === 1 ? " was" : "s were"} staked.`,
    url: `${base.blockExplorers.default.url}/tx/${stake.transactionHash}`,
    image: { url: imageUrl },
    fields: [
      { name: "staked by", value: providerDisplayName, inline: true },
      { name: "featured artwork", value: `FAME Society #${featuredTokenId.toString()}`, inline: true },
      ...tokenFields(stake.tokenIds),
    ],
  };
}
