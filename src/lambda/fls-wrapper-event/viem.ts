import { createPublicClient, http, fallback } from "viem";
import { mainnet, sepolia } from "viem/chains";

export const sepoliaClient = createPublicClient({
  transport: fallback([
    http(`https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`, {
      batch: true,
    }),
    http(
      `https://eth-sepolia.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY}`,
      {
        batch: true,
      }
    ),
  ]),
  chain: sepolia,
});
export const mainnetClient = createPublicClient({
  transport: fallback([
    http(`https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`, {
      batch: true,
    }),
    http(`https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_KEY}`, {
      batch: true,
    }),
  ]),
  chain: mainnet,
});
