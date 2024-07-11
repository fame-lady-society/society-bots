import { erc721Abi } from "viem";
import { mainnetClient, sepoliaClient } from "./viem";
import { fetchJson } from "./ipfs";
import { IMetadata } from "@0xflick/models";

export async function fetchMetadata({
  client,
  address,
  tokenId,
}: {
  client: typeof sepoliaClient | typeof mainnetClient;
  address: `0x${string}`;
  tokenId: bigint;
}) {
  return client
    .readContract({
      abi: erc721Abi,
      address: address,
      functionName: "tokenURI",
      args: [BigInt(tokenId)],
    })
    .then(async (tokenUri) => {
      const metadata = await fetchJson<IMetadata>({
        cid: tokenUri.replace("ipfs://", ""),
      });
      return metadata;
    });
}

export const defaultDescription = `Fame Lady Society is the wrapped token for the first ever generative all-female avatar collection on the Ethereum blockchain. Yes, we are THE community who took over a project TWICE to write our own story. This is NFT history. This is HERstory. FLS are 8888 distinctive Ladies made up of millions of fierce trait combinations. Community = Everything. Commercial IP rights of each Lady NFT belong to its owner.`;

export function customDescription(metadata: IMetadata): string | null {
  const chunks = metadata.description?.split(defaultDescription);
  let description: string | null = null;
  if (chunks && chunks.length > 1) {
    description = chunks[0].trim();
  }
  return description;
}
