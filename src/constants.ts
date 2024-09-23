import { WETH9 } from "@uniswap/sdk-core";
import { base, sepolia } from "viem/chains";

export const BASE_FAME_WETH_V3_POOL =
  "0xeed3eff5775865229dcd0d7e0f6e89c611841202";
export const BASE_FAME_WETH_V2_POOL =
  "0x3e2cab55bebf41719148b4e6b63f6644b18ae49c";
export const BASE_FAME_ADDRESS = "0xf307e242BfE1EC1fF01a4Cef2fdaa81b10A52418";
export const BASE_FAME_NFT_ADDRESS =
  "0xBB5ED04dD7B207592429eb8d599d103CCad646c4";
export const BASE_WETH_ADDRESS = WETH9[base.id].address as `0x${string}`;

export const SEPOLIA_EXAMPLE_WETH_V3_POOL =
  "0x6261bC8dc29CfaDb1EDEEB1dEE9114d876DbFcD5";
export const SEPOLIA_EXAMPLE_WETH_V2_POOL =
  "0xAfF1819650B69874796732DC8439E283d1c42093";
export const SEPOLIA_EXAMPLE_ADDRESS =
  "0xEaD0b62Deced7D0E56E4e3B13e246E183278CAEE";
export const SEPOLIA_WETH_ADDRESS =
  "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
export const SEPOLIA_EXAMPLE_NFT_ADDRESS =
  "0xF661Af827B0E89Bf24B933A12Da44F411ABAED56";

export const v3PoolForChain = (chainId: typeof sepolia.id | typeof base.id) =>
  chainId === sepolia.id
    ? SEPOLIA_EXAMPLE_WETH_V3_POOL
    : BASE_FAME_WETH_V3_POOL;

export const v2PoolForChain = (chainId: typeof sepolia.id | typeof base.id) =>
  chainId === sepolia.id
    ? SEPOLIA_EXAMPLE_WETH_V2_POOL
    : BASE_FAME_WETH_V2_POOL;

export const tokenAddressForChain = (
  chainId: typeof sepolia.id | typeof base.id
) => (chainId === sepolia.id ? SEPOLIA_EXAMPLE_ADDRESS : BASE_FAME_ADDRESS);

export const nftAddressForChain = (
  chainId: typeof sepolia.id | typeof base.id
) =>
  chainId === sepolia.id ? SEPOLIA_EXAMPLE_NFT_ADDRESS : BASE_FAME_NFT_ADDRESS;

export const wethForChain = (chainId: typeof sepolia.id | typeof base.id) =>
  chainId === sepolia.id ? SEPOLIA_WETH_ADDRESS : BASE_WETH_ADDRESS;
