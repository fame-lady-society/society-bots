import "dotenv/config";
import { defineConfig } from "@wagmi/cli";
import { actions, etherscan } from "@wagmi/cli/plugins";
import { sepolia, mainnet, base } from "viem/chains";
import UniswapV2PoolAbi from "./abi/UniswapV2Pool.json";

export default defineConfig({
  out: "src/wagmi.generated.ts",
  contracts: [
    {
      abi: UniswapV2PoolAbi as any,
      name: "UniswapV2Pool",
    },
  ],
  plugins: [
    etherscan({
      apiKey: process.env.ETHERSCAN_API_KEY!,
      chainId: sepolia.id,
      contracts: [
        {
          name: "UniswapV3Pool",
          address: {
            [sepolia.id]: "0x6261bC8dc29CfaDb1EDEEB1dEE9114d876DbFcD5",
          },
        },
        {
          name: "WrappedNFT",
          address: {
            [sepolia.id]: "0x9EFf37047657a0f50b989165b48012834eDB2212",
          },
        },
      ],
    }),
    etherscan({
      apiKey: process.env.BASE_ETHERSCAN_API_KEY!,
      chainId: base.id,
      contracts: [
        {
          name: "Chainlink_USDC_ETH",
          address: {
            [base.id]: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
          },
        },
        {
          name: "FameSocietyToken",
          address: {
            [base.id]: "0xf307e242BfE1EC1fF01a4Cef2fdaa81b10A52418",
          },
        },
        {
          name: "FameSocietyNft",
          address: {
            [base.id]: "0xbb5ed04dd7b207592429eb8d599d103ccad646c4",
          },
        },
        {
          name: "FameSocietyRevealer",
          address: {
            [base.id]: "0xc0c81c4c0e7ba766bd07b5b34266ccc4e0b971c9",
          },
        },
        {
          name: "FAMEusGovernor",
          address: {
            [base.id]: "0xbb2bd06084ab8ab66f14ce33fc713093e0f1d8d8",
          },
        },
      ],
    }),
    etherscan({
      apiKey: process.env.ETHERSCAN_API_KEY,
      chainId: mainnet.id,
      contracts: [
        {
          name: "FameLadySociety",
          address: {
            [mainnet.id]: "0x6cf4328f1ea83b5d592474f9fcdc714faafd1574" as const,
          },
        },
      ],
    }),
    etherscan({
      apiKey: process.env.ETHERSCAN_API_KEY,
      chainId: mainnet.id,
      contracts: [
        {
          name: "FameLadySquad",
          address: {
            [mainnet.id]: "0xf3E6DbBE461C6fa492CeA7Cb1f5C5eA660EB1B47" as const,
          },
        },
      ],
    }),
  ],
});
