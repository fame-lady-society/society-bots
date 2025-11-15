import { IMetadata } from "@/metadata.ts";
import { mainnetClient } from "@/viem.ts";
import {
  fameLadySocietyAbi,
  fameLadySocietyAddress,
} from "@/wagmi.generated.ts";
import { erc721Abi } from "viem";
import { mainnet } from "viem/chains";

export async function fetchTokenImage(
  tokenId: string | number | bigint,
): Promise<ArrayBuffer> {
  const { image: imageUrl } = await fetchMetadata({
    client: mainnetClient,
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
  client: typeof mainnetClient;
  tokenId: bigint;
}) {
  const tokenURI = await client.readContract({
    abi: fameLadySocietyAbi,
    address: fameLadySocietyAddress[mainnet.id],
    functionName: "tokenURI",
    args: [tokenId],
  });
  const metadataResponse = await fetch(tokenURI);
  const metadata: IMetadata = await metadataResponse.json();
  return metadata;
}
