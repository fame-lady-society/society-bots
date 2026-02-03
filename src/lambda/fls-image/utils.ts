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

  const {url: gatewayUrl, content: imageContent} = await resolveIpfsUrl(imageUrl);
  if (imageContent) {
    return imageContent;
  }
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
  const {url: metadataUrl, content: metadataContent} = await resolveIpfsUrl(tokenURI);
  if (metadataContent) {
    return JSON.parse(new TextDecoder().decode(metadataContent)) as IMetadata;
  }
  const metadataResponse = await fetch(metadataUrl);
  const metadata: IMetadata = await metadataResponse.json();
  return metadata;
}

async function resolveIpfsUrl(url: string): Promise<{
  url: string;
  content: ArrayBuffer | null;
}> {
  if (!url.startsWith("ipfs://")) {
    const response = await fetch(url);
    if (response.ok) {
      return {
        url,
        content: await response.arrayBuffer(),
      };
    }
    return {
      url,
      content: null,
    };
  }

  const ipfsPath = url.slice("ipfs://".length);
  const [cid, ...pathParts] = ipfsPath.split("/");
  if (!cid) {
    throw new Error(`Invalid ipfs url: ${url}`);
  }

  const path = pathParts.length > 0 ? `/${pathParts.join("/")}` : "";
  const gatewayDomains = ["storry.tv", "dweb.link", "dget.top"];
  const gatewayUrls = gatewayDomains.map(
    (domain) => `https://${cid}.ipfs.${domain}${path}`,
  );

  for (const gatewayUrl of gatewayUrls) {
    const response = await fetch(gatewayUrl);
    if (response.ok) {
      return {
        url: gatewayUrl,
        content: await response.arrayBuffer(),
      };
    }
  }

  throw new Error(
    `Failed to resolve ipfs url via gateways: ${gatewayUrls.join(", ")}`,
  );
}
