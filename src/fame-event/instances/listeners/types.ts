import type { uniswapV2SwapEventAbi, uniswapV3SwapEventAbi } from "@/events.ts";
import type { WatchEventOnLogsParameter } from "viem";
import { base, sepolia } from "viem/chains";

export type SupportedChainId = typeof sepolia.id | typeof base.id;

export type V2LogEvent = WatchEventOnLogsParameter<
  typeof uniswapV2SwapEventAbi,
  undefined,
  true,
  "Swap"
>;

export type V3LogEvent = WatchEventOnLogsParameter<
  typeof uniswapV3SwapEventAbi,
  undefined,
  true,
  "Swap"
>;

export type IChannelMessage = {
  type: `fame:event:swap`;
  chainId: SupportedChainId;
  transactionHash: `0x${string}`;
};
