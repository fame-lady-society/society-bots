import { AbiEvent, Address, erc721Abi, Hex, zeroAddress } from "viem";
import { mainnetClient, sepoliaClient } from "@/viem.ts";
import { createLogger } from "@/utils/logging.ts";

const logger = createLogger({
  name: "fls-wrapper-event-processor",
});

async function findEvents<E extends AbiEvent>(
  client: typeof sepoliaClient | typeof mainnetClient,
  contractAddress: `0x${string}`,
  event: E,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const events = await client.getLogs({
    address: contractAddress,
    fromBlock,
    toBlock,
    event,
    strict: true,
  });

  return events.map((event) => {
    return {
      ...event,
      blockNumber: event.blockNumber,
    };
  });
}

const transferEvent = {
  type: "event",
  anonymous: false,
  inputs: [
    {
      name: "from",
      internalType: "address",
      type: "address",
      indexed: true,
    },
    { name: "to", internalType: "address", type: "address", indexed: true },
    {
      name: "tokenId",
      internalType: "uint256",
      type: "uint256",
      indexed: true,
    },
  ],
  name: "Transfer",
} as const;

const metadataEvent = {
  type: "event",
  anonymous: false,
  inputs: [
    {
      name: "_tokenId",
      internalType: "uint256",
      type: "uint256",
      indexed: false,
    },
  ],
  name: "MetadataUpdate",
} as const;

export class DefaultEventProcessor {
  constructor(
    private client: typeof sepoliaClient | typeof mainnetClient,
    private contractAddress: `0x${string}`,
    private wrappedContractAddress: `0x${string}`,
  ) {}

  async processEvents(params: { fromBlock: bigint; toBlock: bigint }) {
    // Move existing event processing logic here
    const [transferEvents, metadataEvents] = await Promise.all([
      findEvents<typeof transferEvent>(
        this.client,
        this.contractAddress,
        transferEvent,
        params.fromBlock,
        params.toBlock,
      ).then((events) => {
        return events.filter((event) => event.args.from === zeroAddress);
      }),

      findEvents<typeof metadataEvent>(
        this.client,
        this.contractAddress,
        metadataEvent,
        params.fromBlock,
        params.toBlock,
      ),
    ]);

    // Instead of sending notifications directly, collect them
    const wrappedCount = transferEvents.length
      ? await this.client.readContract({
          address: this.wrappedContractAddress,
          abi: erc721Abi,
          functionName: "balanceOf",
          args: [this.contractAddress],
        })
      : 0n;

    // Return the notifications and new block numbers
    return {
      newBlock: params.toBlock + 1n,
      wrappedCount,
      // Metadata events that are accompianed by a transfer event do not count
      metadataEvents: metadataEvents.filter((event) =>
        transferEvents.find(
          (transfer) => transfer.args.tokenId === event.args._tokenId,
        ),
      ),
      transferEvents,
    };
  }
}
