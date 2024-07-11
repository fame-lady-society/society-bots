import { createPublicClient, http, fallback, AbiEvent } from "viem";
import { base, mainnet, sepolia } from "viem/chains";

const sepoliaRpcs: string[] = JSON.parse(process.env.SEPOLIA_RPCS_JSON || "[]");

export const sepoliaClient = createPublicClient({
  transport: fallback(sepoliaRpcs.map((rpc) => http(rpc, { batch: true }))),
  chain: sepolia,
});

const mainnetRpcs: string[] = JSON.parse(process.env.MAINNET_RPCS_JSON || "[]");

export const mainnetClient = createPublicClient({
  transport: fallback(mainnetRpcs.map((rpc) => http(rpc, { batch: true }))),
  chain: mainnet,
});

const baseRpcs: string[] = JSON.parse(process.env.BASE_RPCS_JSON || "[]");

export const baseClient = createPublicClient({
  transport: fallback(baseRpcs.map((rpc) => http(rpc, { batch: true }))),
  chain: base,
});
