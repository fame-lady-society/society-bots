import { BASE_FAME_NFT_ADDRESS } from "@/constants.ts";
import { IMetadata } from "@/metadata.ts";
import { baseClient } from "@/viem.ts";
import {
  fameSocietyRevealerAbi,
  fameSocietyRevealerAddress,
} from "@/wagmi.generated.ts";
import { erc721Abi } from "viem";
import { base } from "viem/chains";

export async function fetchFameSocietyRevealerIndex({
  client,
}: {
  client: typeof baseClient;
}) {
  const index = await client.readContract({
    abi: fameSocietyRevealerAbi,
    address: fameSocietyRevealerAddress[base.id],
    functionName: "revealedSize",
  });
  return index;
}

export async function fetchTokenImage(
  tokenId: string | number | bigint
): Promise<ArrayBuffer> {
  const { image: imageUrl } = await fetchMetadata({
    client: baseClient,
    address: BASE_FAME_NFT_ADDRESS,
    tokenId: BigInt(tokenId),
  });
  const fetchImage = await fetch(imageUrl);
  const buffer = await fetchImage.arrayBuffer();
  return buffer;
}

async function fetchMetadata({
  client,
  address,
  tokenId,
}: {
  client: typeof baseClient;
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
