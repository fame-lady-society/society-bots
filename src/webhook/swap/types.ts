export interface ISwapWebhook {
  webhookId: string;
  id: string;
  createdAt: string;
  type: "GRAPHQL";
  event: ISwapWebhookEvent;
  sequenceNumber: string;
}

export interface ISwapWebhookEvent {
  data: ISwapWebhookEventData;
}

export interface ISwapWebhookEventData {
  block: ISwapWebhookEventDataBlock;
}

export interface ISwapWebhookEventDataBlock {
  logs: ISwapWebhookEventDataBlockLog[];
}

export interface ISwapWebhookEventDataBlockLog {
  data: `0x${string}`;
  topics: [signature: `0x${string}`, ...args: `0x${string}`[]];
  transaction: ISwapWebhookEventDataBlockLogTransaction;
}

interface IAccount {
  address: `0x${string}`;
}

export interface ISwapWebhookEventDataBlockLogTransaction {
  hash: `0x${string}`;
  from: IAccount;
  to: IAccount;
  logs: ISwapWebhookEventDataBlockLogTransactionLog[];
  type: number;
  status: number;
}

export interface ISwapWebhookEventDataBlockLogTransactionLog {
  account: IAccount;
  data: `0x${string}`;
  topics: [] | [signature: `0x${string}`, ...args: `0x${string}`[]];
}



export type CompleteSwapEvent = {
  v3SwapEvents: {
    sender: `0x${string}`;
    recipient: `0x${string}`;
    amount0: bigint;
    amount1: bigint;
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
  }[];
  v2SwapEvents: {
    sender: `0x${string}`;
    amount0In: bigint;
    amount1In: bigint;
    amount0Out: bigint;
    amount1Out: bigint;
    to: `0x${string}`;
  }[];
  mintEvents: {
    from: `0x${string}`;
    to: `0x${string}`;
    tokenId: bigint;
  }[];
  burnEvents: {
    from: `0x${string}`;
    to: `0x${string}`;
    tokenId: bigint;
  }[];
  syncEvents: {
    reserve0: bigint;
    reserve1: bigint;
  }[];
  token0TransferEvents: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: bigint;
  }[];
  token1TransferEvents: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: bigint;
  }[];
};