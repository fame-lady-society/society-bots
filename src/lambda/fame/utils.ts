import { IMetadata } from "@/metadata.ts";
import { baseClient } from "@/viem.ts";
import {
  fameSocietyRevealerAbi,
  fameSocietyRevealerAddress,
  fameSocietyTokenAbi,
  fameSocietyTokenAddress,
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
    tokenId: BigInt(tokenId),
  });

  const fetchImage = await fetch(imageUrl);
  const buffer = await fetchImage.arrayBuffer();
  return buffer;
}

async function fetchMetadata({
  client,
  tokenId,
}: {
  client: typeof baseClient;
  tokenId: bigint;
}) {
  const renderer = await client.readContract({
    abi: fameSocietyTokenAbi,
    address: fameSocietyTokenAddress[base.id],
    functionName: "renderer",
  });
  console.log("renderer", renderer);
  const tokenURI = await client.readContract({
    abi: erc721Abi,
    address: renderer,
    functionName: "tokenURI",
    args: [tokenId],
  });
  const metadataResponse = await fetch(tokenURI);
  const metadata: IMetadata = await metadataResponse.json();
  return metadata;
}
