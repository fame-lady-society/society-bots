import type { Address, Hash } from "viem";

export const BASE_CHAIN_ID = 8453;

export type MetadataRefreshJob = {
  chainId: typeof BASE_CHAIN_ID;
  transactionHash: Hash;
  logIndex: number;
  tokenId: bigint;
  blockNumber: bigint;
  state: "pending" | "in_flight" | "accepted" | "skipped";
  attempts: number;
};

export type PurchaseNotification = {
  transactionHash: Hash;
  tokenId: bigint;
  buyer: Address;
  recipient: Address;
  payment: { asset: "ETH" | "FAME" | "USDC" | "WETH"; amount: bigint; decimals: number };
};

export type MetadataDocument = {
  name: string;
  description: string;
  image: string;
};
