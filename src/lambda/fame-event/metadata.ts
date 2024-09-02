import { erc721Abi } from "viem";
import { baseClient, mainnetClient, sepoliaClient } from "../../viem.js";
import { IMetadata } from "../../metadata.js";

export async function fetchMetadata({
  client,
  address,
  tokenId,
}: {
  client: typeof sepoliaClient | typeof mainnetClient | typeof baseClient;
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
      const metadataResponse = await fetch(tokenUri);
      const metadata: IMetadata = await metadataResponse.json();
      return metadata;
    });
}
