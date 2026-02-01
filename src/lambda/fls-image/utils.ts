import { IMetadata } from "@/metadata.ts";
import { mainnetClient } from "@/viem.ts";
import {
  fameLadySocietyAbi,
  fameLadySocietyAddress,
} from "@/wagmi.generated.ts";
import { mainnet } from "viem/chains";


export async function fetchTokenImage(
  tokenId: string | number | bigint,
): Promise<ArrayBuffer> {
  const { image: imageUrl } = await fetchMetadata({
    client: mainnetClient,
    tokenId: BigInt(tokenId),
  });

  const gatewayUrl = await resolveImageUrl(imageUrl);
  const fetchImage = await fetch(gatewayUrl);
  if (!fetchImage.ok) {
    throw new Error(
      `Failed to fetch image from ${gatewayUrl}: ${fetchImage.status} ${fetchImage.statusText}`,
    );
  }
  return fetchImage.arrayBuffer();
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

async function resolveImageUrl(imageUrl: string): Promise<string> {
  if (!imageUrl.startsWith("ipfs://")) {
    return imageUrl;
  }

  const ipfsPath = imageUrl.slice("ipfs://".length);
  const [cid, ...pathParts] = ipfsPath.split("/");
  if (!cid) {
    throw new Error(`Invalid ipfs image url: ${imageUrl}`);
  }

  const path = pathParts.length > 0 ? `/${pathParts.join("/")}` : "";
  const gatewayDomains = ["storry.tv", "dweb.link", "dget.top"];
  const gatewayUrls = gatewayDomains.map(
    (domain) => `https://${cid}.ipfs.${domain}${path}`,
  );

  for (const gatewayUrl of gatewayUrls) {
    const response = await fetch(gatewayUrl);
    if (response.ok) {
      return gatewayUrl;
    }
  }

  throw new Error(
    `Failed to resolve ipfs image url via gateways: ${gatewayUrls.join(", ")}`,
  );
}
