import { describe, it, expect } from "@jest/globals";
import { createPublicClient, http, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { DefaultEventProcessor } from "./processor.ts";
import {
  fameLadySocietyAddress,
  fameLadySquadAddress,
  saveLadyProxyAddress,
  vaultDonatorAddress,
} from "@/wagmi.generated.ts";
import { bigIntToStringJsonFormat } from "@/utils/json.ts";

describe("EventProcessor", () => {
  it("processes events for specific blocks", async () => {
    const client = createPublicClient({
      chain: mainnet,
      transport: http("http://localhost:8545"),
    });

    const processor = new DefaultEventProcessor(
      client as any,
      fameLadySocietyAddress[1],
      fameLadySquadAddress[1],
      saveLadyProxyAddress[1],
      vaultDonatorAddress[1],
    );

    const result = await processor.processEvents({
      fromBlock: 21589199n,
      toBlock: 21589199n,
    });

    console.log(JSON.stringify(result, bigIntToStringJsonFormat, 2));
  });
});

describe("fls-wrapper-event", () => {
  it("should fetch block 21461509", async () => {
    const client = createPublicClient({
      chain: mainnet,
      transport: http("http://localhost:8545"),
    });

    const block = await client.getBlock({
      blockNumber: 21461509n,
    });

    expect(block.number).toBe(21461509n);
  });
});
