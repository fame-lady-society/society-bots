import { base, sepolia } from "viem/chains";
import { baseClient, sepoliaClient } from "@/viem.ts";
import { PublicClient } from "viem";

if (!process.env.DYNAMODB_FAME_INDEX_TABLE_NAME) {
  throw new Error("DYNAMODB_FAME_INDEX_TABLE_NAME is not defined");
}
export const DYNAMODB_FAME_INDEX_TABLE_NAME =
  process.env.DYNAMODB_FAME_INDEX_TABLE_NAME;

if (!process.env.DYNAMODB_REGION) {
  throw new Error("DYNAMODB_REGION is not defined");
}
export const DYNAMODB_REGION = process.env.DYNAMODB_REGION;

if (!process.env.EVENT_LOG_TOPIC_ARN) {
  throw new Error("DISCORD_EVENT_LOG_TOPIC_ARN not set");
}

export const EVENT_LOG_TOPIC_ARN = process.env.EVENT_LOG_TOPIC_ARN;

if (!process.env.CHAIN_ID) {
  throw new Error("CHAIN_ID not set");
}

export const CHAIN_ID = Number(process.env.CHAIN_ID) as
  | typeof sepolia.id
  | typeof base.id;
// CHAIN_ID must be sepolia or base
if (CHAIN_ID !== sepolia.id && CHAIN_ID !== base.id) {
  throw new Error("CHAIN_ID must be sepolia or base");
}

export const CHAIN = CHAIN_ID === sepolia.id ? sepolia : base;

export const CLIENT: PublicClient = (
  CHAIN_ID === sepolia.id ? sepoliaClient : baseClient
) as any;
