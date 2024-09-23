import type { mainnetClient, sepoliaClient } from "@/viem.ts";
import {
  type BlockNumber,
  type BlockTag,
  type AbiEvent,
  type Log,
  type MaybeAbiEventName,
  GetLogsReturnType,
} from "viem";

export async function findEvents<
  TAbiEvent extends AbiEvent | undefined = undefined,
  TAbiEvents extends
    | readonly AbiEvent[]
    | readonly unknown[]
    | undefined = TAbiEvent extends AbiEvent ? [TAbiEvent] : undefined,
  TFromBlock extends BlockNumber | undefined = undefined,
  TToBlock extends BlockNumber | undefined = undefined
>(
  client: typeof sepoliaClient | typeof mainnetClient,
  contractAddress: `0x${string}`,
  event: TAbiEvent,
  fromBlock: bigint,
  toBlock: bigint
): Promise<
  GetLogsReturnType<TAbiEvent, TAbiEvents, true, TFromBlock, TToBlock>
> {
  const events = await client.getLogs<
    TAbiEvent,
    TAbiEvents,
    true,
    TFromBlock,
    TToBlock
  >({
    address: contractAddress,
    fromBlock,
    toBlock,
    event,
    strict: true,
  });

  return events;
}

export function generateTokenIdListString(tokenIds: number[]): string {
  // Sort the token IDs to ensure they are in ascending order
  tokenIds.sort((a, b) => a - b);

  const ranges: string[] = [];
  let rangeStart = tokenIds[0];
  let rangeEnd = tokenIds[0];

  for (let i = 1; i <= tokenIds.length; i++) {
    // Check if the current token ID is consecutive to the previous one
    if (tokenIds[i] === rangeEnd + 1) {
      rangeEnd = tokenIds[i];
    } else {
      // If the start and end of the range are the same, add it as a single number
      if (rangeStart === rangeEnd) {
        ranges.push(`${rangeStart}`);
      } else {
        ranges.push(`${rangeStart}-${rangeEnd}`);
      }
      // Start a new range
      rangeStart = tokenIds[i];
      rangeEnd = tokenIds[i];
    }
  }

  // Join the ranges array into a string with commas separating the ranges
  return ranges.join(", ");
}
