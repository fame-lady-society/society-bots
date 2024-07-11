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
