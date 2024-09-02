import { bigIntToStringJsonFormat } from "../../utils/json";
import { arbLogs1 } from "./_fixtures/arbs.ts";
import { swapWithNftMintLogs } from "./_fixtures/swaps.ts";
import { CompleteSwapEvent, aggregateSwapEvents, handler } from "./handler.ts";

import { createPublicClient, http, zeroAddress } from "viem";

const client = createPublicClient({
  transport: http("http://localhost:8545"),
});

const arbTransactionHash =
  "0xb29502bb8483aa95ccb02d4e5798eb90f8ee0b5188604caf4dee7f429c98d922";
const swapWithNfts =
  "0x4bf34a62add53c797d63ddb6905fe712628967ae9f4516f7c62bc2b60857eae9";
describe("swap event handler", () => {
  it("should handle swap event", async () => {
    const { currentUsdPrice, recipientMap } = await handler({
      logs: arbLogs1,
      transactionHash: arbTransactionHash,
    });
    let output = "";
    output += `currentUsdPrice: ${currentUsdPrice}\n`;
    output += `recipientMap.size: ${recipientMap.size}\n`;
    for (const [address, events] of recipientMap) {
      output += `  address: ${address}\n`;
      if (events.v2SwapEvents.length > 0) {
        output += "  v2 swap events:\n";
      }
      for (const {
        amount0In,
        amount0Out,
        amount1In,
        amount1Out,
        sender,
        to,
      } of events.v2SwapEvents) {
        output += `    amount0In: ${amount0In} amount0Out: ${amount0Out} amount1In: ${amount1In} amount1Out: ${amount1Out} sender: ${sender} to: ${to}\n`;
      }
      if (events.syncEvents.length > 0) {
        output += "  sync events:\n";
      }
      for (const { reserve0, reserve1 } of events.syncEvents) {
        output += `    reserve0: ${reserve0} reserve1: ${reserve1}\n`;
      }
      if (events.v3SwapEvents.length > 0) {
        output += "  v3 swap events:\n";
      }
      for (const {
        amount0,
        amount1,
        sender,
        liquidity,
        recipient,
        sqrtPriceX96,
        tick,
      } of events.v3SwapEvents) {
        output += `    amount0: ${amount0} amount1: ${amount1} sender: ${sender} liquidity: ${liquidity} recipient: ${recipient} sqrtPriceX96: ${sqrtPriceX96} tick: ${tick}\n`;
      }
      if (events.mintEvents.length > 0) {
        output += "  mint events:\n";
      }
      for (const { from, to, tokenId } of events.mintEvents) {
        output += `    from: ${from} to: ${to} tokenId: ${tokenId}\n`;
      }
      if (events.burnEvents.length > 0) {
        output += "  burn events:\n";
      }
      for (const { from, to, tokenId } of events.burnEvents) {
        output += `    from: ${from} to: ${to} tokenId: ${tokenId}\n`;
      }
      if (events.token0TransferEvents.length > 0) {
        output += "  token0 transfer events:\n";
      }
      for (const { from, to, value } of events.token0TransferEvents) {
        output += `    from: ${from} to: ${to} value: ${value}\n`;
      }
      if (events.token1TransferEvents.length > 0) {
        output += "  token1 transfer events:\n";
      }
      for (const { from, to, value } of events.token1TransferEvents) {
        output += `    from: ${from} to: ${to} value: ${value}\n`;
      }
    }
    const a = aggregateSwapEvents({ recipientMap });
    expect(a.isArb).toEqual(true);
  });

  it("should handle swap with nft mint event", async () => {
    const { currentUsdPrice, recipientMap } = await handler({
      logs: swapWithNftMintLogs,
      transactionHash: swapWithNfts,
    });

    const allNftMintEvents = Array.from(recipientMap.values()).flatMap(
      (events) => events.mintEvents
    );

    const a = aggregateSwapEvents({ recipientMap });
    const { nftsMinted } = a;

    expect(nftsMinted.length).toEqual(allNftMintEvents.length);
    expect(nftsMinted.length).toEqual(4);
  });
});
