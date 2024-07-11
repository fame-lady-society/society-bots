import "dotenv/config";
import { defineConfig } from "@wagmi/cli";
import { etherscan } from "@wagmi/cli/plugins";
import { sepolia, mainnet, base } from "viem/chains";

export default defineConfig({
  out: "src/wagmi.generated.ts",
  contracts: [],
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
      ],
    }),
  ],
});
