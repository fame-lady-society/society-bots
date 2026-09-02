import { mainnetClient } from "@/viem.ts";
import { Address, erc721Abi } from "viem";

export function readTotalDonatedCount({
  client,
  wrappedNftAddress,
  vaultAddress,
}: {
  client: Pick<typeof mainnetClient, "readContract">;
  wrappedNftAddress: Address;
  vaultAddress: Address;
}) {
  return client.readContract({
    address: wrappedNftAddress,
    abi: erc721Abi,
    functionName: "balanceOf",
    args: [vaultAddress],
  });
}
