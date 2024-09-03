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
