import {
  createPublicClient,
  http,
  fallback,
  createWalletClient,
  Account,
} from "viem";
import { base, mainnet, optimism, sepolia } from "viem/chains";

export const sepoliaRpcs: string[] = JSON.parse(
  process.env.SEPOLIA_RPCS_JSON || "[]",
);

export const sepoliaClient = createPublicClient({
  transport: fallback(sepoliaRpcs.map((rpc) => http(rpc, { batch: true }))),
  chain: sepolia,
  batch: {
    multicall: {
      batchSize: 512,
    },
  },
});

const mainnetRpcs: string[] = JSON.parse(process.env.MAINNET_RPCS_JSON || "[]");

export const mainnetClient = createPublicClient({
  transport: fallback(mainnetRpcs.map((rpc) => http(rpc, { batch: true }))),
  chain: mainnet,
  batch: {
    multicall: {
      batchSize: 512,
    },
  },
});

const baseRpcs: string[] = JSON.parse(process.env.BASE_RPCS_JSON || "[]");

export const baseClient = createPublicClient({
  transport: fallback(baseRpcs.map((rpc) => http(rpc, { batch: true }))),
  chain: base,
  batch: {
    multicall: {
      batchSize: 512,
    },
  },
});
