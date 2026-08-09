import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeAbiParameters, encodeEventTopics, parseAbiParameters, zeroAddress, type Abi } from "viem";
import { BASE_FAME_CHECKOUT_ADDRESS, BASE_FAME_NFT_ADDRESS, BASE_UNIVERSAL_MARKETPLACE_ADDRESS } from "@/constants.ts";
import { artworkPurchasedEvent, checkoutSettledEvent, ERC721TransferEventAbi } from "@/events.ts";
import type { MetadataRefreshCheckpointId, MetadataRefreshStore } from "./dynamodb.ts";
import { runMetadataRefreshIndexer } from "./indexer.ts";
import { BASE_CHAIN_ID, type MetadataRefreshJob } from "./types.ts";
import fixture from "./_fixtures/base-failing-marketplace-receipt.json";

const START_BLOCK = 49_729_692n;
const buyer = "0x0000000000000000000000000000000000000001" as const;
const intermediary = "0x0000000000000000000000000000000000000002" as const;
const finalOwner = "0x0000000000000000000000000000000000000003" as const;
const transactionHash = `0x${"11".repeat(32)}` as const;
const METADATA_CHECKPOINT: MetadataRefreshCheckpointId = "base-metadata-update";
const PURCHASE_CHECKPOINT: MetadataRefreshCheckpointId = "base-marketplace-purchase";

type Command = { constructor: { name: string }; input: Record<string, unknown> };
type Publish = jest.Mock<(input: { Message: string; TopicArn: string }) => Promise<{ MessageId: string }>>;

class InMemoryMetadataRefreshStore {
  private readonly items = new Map<string, Record<string, unknown>>();

  async send(command: Command) {
    const input = command.input;
    if (command.constructor.name === "GetCommand") {
      return { Item: this.items.get(keyOf(input.Key)) };
    }
    if (command.constructor.name === "PutCommand") {
      const item = recordOf(input.Item);
      const key = keyOf(item);
      if (input.ConditionExpression === "attribute_not_exists(pk)" && this.items.has(key)) {
        throw conditionalFailure();
      }
      this.items.set(key, item);
      return {};
    }
    if (command.constructor.name === "UpdateCommand") {
      const key = keyOf(input.Key);
      const existing = this.items.get(key);
      if (!existing) throw conditionalFailure();
      const values = recordOf(input.ExpressionAttributeValues);
      if (key.startsWith("checkpoint|")) {
        if (existing.nextBlock !== values[":expectedBlock"] || existing.nextLogIndex !== values[":expectedLogIndex"]) throw conditionalFailure();
        this.items.set(key, { ...existing, nextBlock: values[":nextBlock"], nextLogIndex: values[":nextLogIndex"] });
        return {};
      }
      const nextState = values[":published"] ?? values[":accepted"] ?? values[":skipped"] ?? values[":inFlight"];
      this.items.set(key, {
        ...existing,
        ...(typeof nextState === "string" ? { state: nextState } : {}),
        ...(typeof values[":attempts"] === "number" ? { attempts: values[":attempts"] } : {}),
        ...(typeof values[":reason"] === "string" ? { skipReason: values[":reason"] } : {}),
      });
      return {};
    }
    throw new Error(`Unexpected command ${command.constructor.name}`);
  }

  setCheckpoint(blockNumber: bigint, checkpointId: MetadataRefreshCheckpointId = METADATA_CHECKPOINT, nextLogIndex = 0) {
    this.items.set(`checkpoint|${checkpointId}`, { pk: "checkpoint", sk: checkpointId, nextBlock: Number(blockNumber), nextLogIndex });
  }

  setMetadataJob(job: MetadataRefreshJob) {
    const pk = `event#${job.chainId}#${job.transactionHash}`;
    const sk = `log#${job.logIndex}`;
    this.items.set(`${pk}|${sk}`, { ...job, pk, sk, tokenId: job.tokenId.toString(), blockNumber: Number(job.blockNumber) });
  }

  checkpoint(checkpointId: MetadataRefreshCheckpointId = METADATA_CHECKPOINT) {
    const item = this.items.get(`checkpoint|${checkpointId}`);
    return item ? { nextBlock: item.nextBlock, nextLogIndex: item.nextLogIndex } : null;
  }

  notificationState() {
    return this.items.get(`discord#${transactionHash}|log#7`)?.state;
  }

  acceptedJobCount() {
    return [...this.items.values()].filter((item) => item.state === "accepted").length;
  }

  skippedJobCount() {
    return [...this.items.values()].filter((item) => item.state === "skipped").length;
  }

  metadataJob(transactionHash: `0x${string}`, logIndex: number) {
    return this.items.get(`event#${BASE_CHAIN_ID}#${transactionHash}|log#${logIndex}`);
  }
}

function recordOf(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Expected a record");
  return value as Record<string, unknown>;
}

function keyOf(value: unknown) {
  const record = recordOf(value);
  return `${String(record.pk)}|${String(record.sk)}`;
}

function conditionalFailure() {
  return Object.assign(new Error("conditional failure"), { name: "ConditionalCheckFailedException" });
}

function purchaseReceipt({ forwarded = false, nativeEth = false } = {}) {
  const purchaseTopics = encodeEventTopics({ abi: [artworkPurchasedEvent], eventName: "ArtworkPurchased", args: { buyer, recipient: intermediary, shellId: 42n } });
  const purchaseData = encodeAbiParameters(parseAbiParameters("uint8 path, uint256 sourceId, bytes32 artwork, uint256 unitAmount, uint256 grossPremiumAmount, uint256 inventoryBefore, uint256 inventoryAfter"), [0, 0n, `0x${"00".repeat(32)}`, 10n, 2n, 3n, 4n]);
  const deliveryTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, to: intermediary, tokenId: 42n } });
  const forwardingTopics = encodeEventTopics({ abi: [ERC721TransferEventAbi], eventName: "Transfer", args: { from: intermediary, to: finalOwner, tokenId: 42n } });
  const settlementTopics = encodeEventTopics({ abi: [checkoutSettledEvent], eventName: "CheckoutSettled", args: { buyer, inputAsset: zeroAddress, shellId: 42n } });
  const settlementData = encodeAbiParameters(parseAbiParameters("bytes32 routeHash, uint8 fulfillmentPath, uint256 sourceId, bytes32 artwork, uint256 inputAmount, uint256 inputRefund, uint256 routerFameOutput, uint256 marketplaceFameCharge, uint256 fameRefund"), [`0x${"00".repeat(32)}`, 0, 0n, `0x${"00".repeat(32)}`, 10_000_000_000_000_000_000n, 1_000_000_000_000_000_000n, 12n, 12n, 0n]);
  return {
    transactionHash,
    logs: [
      { address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS, topics: purchaseTopics, data: purchaseData },
      { address: BASE_FAME_NFT_ADDRESS, topics: deliveryTopics, data: "0x" },
      ...(forwarded ? [{ address: BASE_FAME_NFT_ADDRESS, topics: forwardingTopics, data: "0x" as const }] : []),
      ...(nativeEth ? [{ address: BASE_FAME_CHECKOUT_ADDRESS, topics: settlementTopics, data: settlementData }] : []),
    ],
  };
}

function purchaseLog({ blockNumber = START_BLOCK, logIndex = 7, hash = transactionHash }: { blockNumber?: bigint; logIndex?: number; hash?: `0x${string}` } = {}) {
  return { transactionHash: hash, logIndex, blockNumber };
}

function metadataLog(index: number) {
  return {
    transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    logIndex: index,
    blockNumber: START_BLOCK + BigInt(index),
    args: { _tokenId: BigInt(index + 1) },
  };
}

function tokenDoesNotExistError(abi: Abi, tokenId: bigint) {
  const reverted = new ContractFunctionRevertedError({ abi, data: "0xceea21b6", functionName: "tokenURI" });
  return new ContractFunctionExecutionError(reverted, {
    abi,
    args: [tokenId],
    contractAddress: BASE_FAME_NFT_ADDRESS,
    functionName: "tokenURI",
  });
}

function dependencies({
  store,
  metadataLogs = [],
  purchases = [],
  receipt = purchaseReceipt(),
  head = START_BLOCK + 8n,
  ensName = "holder.eth",
  publish = jest.fn<(input: { Message: string; TopicArn: string }) => Promise<{ MessageId: string }>>(async () => ({ MessageId: "message-id" })),
  fetcher,
  remainingTimeInMillis,
  readContract,
}: {
  store: InMemoryMetadataRefreshStore;
  metadataLogs?: ReturnType<typeof metadataLog>[];
  purchases?: ReturnType<typeof purchaseLog>[];
  receipt?: ReturnType<typeof purchaseReceipt>;
  head?: bigint;
  ensName?: string | Error | null;
  publish?: Publish;
  fetcher?: typeof fetch;
  remainingTimeInMillis?: () => number;
  readContract?: (input: { abi: Abi; address: string; functionName: string; args: [bigint] }) => Promise<unknown>;
}) {
  const getLogs = jest.fn(async ({ address, fromBlock, toBlock }: { address: string; fromBlock: bigint; toBlock: bigint }) => {
    const logs = address.toLowerCase() === BASE_FAME_NFT_ADDRESS.toLowerCase() ? metadataLogs : purchases;
    return logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
  });
  const getEnsName = jest.fn(async () => {
    if (ensName instanceof Error) throw ensName;
    return ensName;
  });
  const defaultFetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://metadata.example/")) {
      return new Response(JSON.stringify({ name: "FAME", description: "Society", image: "https://image.example/fame.png" }), { status: 200 });
    }
    return new Response(JSON.stringify({ nft: { name: "FAME", description: "Society", image_url: "https://image.example/fame.png" } }), { status: 200 });
  };
  return {
    dependencies: {
      client: {
        getBlockNumber: jest.fn(async () => head),
        getLogs,
        getTransactionReceipt: jest.fn(async ({ hash }: { hash: `0x${string}` }) => ({ ...receipt, transactionHash: hash })),
        readContract: jest.fn(readContract ?? (async ({ args }: { args: [bigint] }) => `https://metadata.example/${args[0].toString()}`)),
      },
      ensClient: { getEnsName },
      store: store as unknown as MetadataRefreshStore,
      sns: { publish } as never,
      fetcher: fetcher ?? defaultFetcher,
      remainingTimeInMillis,
    },
    getEnsName,
    publish,
  };
}

describe("metadata refresh indexer lifecycle", () => {
  beforeEach(() => {
    process.env.DYNAMODB_FAME_METADATA_REFRESH_TABLE_NAME = "metadata-refresh";
    process.env.DISCORD_MESSAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:discord";
    process.env.DISCORD_CHANNEL_ID = "channel";
    process.env.OPENSEA_API_KEY = "unit-key";
    process.env.IMAGE_HOST = "images.example";
  });

  it("initializes forward-only at the fixed source block and advances after an empty finalized block", async () => {
    const store = new InMemoryMetadataRefreshStore();
    const setup = dependencies({ store });

    await runMetadataRefreshIndexer(setup.dependencies as never);

    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK + 1n), nextLogIndex: 0 });
    expect(store.checkpoint(PURCHASE_CHECKPOINT)).toEqual({ nextBlock: Number(START_BLOCK + 1n), nextLogIndex: 0 });
  });

  it("publishes the final forwarded owner once and skips a delivered replay", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const setup = dependencies({ store, purchases: [purchaseLog()], receipt: purchaseReceipt({ forwarded: true }) });

    await runMetadataRefreshIndexer(setup.dependencies as never);
    store.setCheckpoint(START_BLOCK, PURCHASE_CHECKPOINT);
    await runMetadataRefreshIndexer(setup.dependencies as never);

    expect(setup.getEnsName).toHaveBeenCalledWith({ address: finalOwner });
    expect(setup.publish).toHaveBeenCalledTimes(1);
    const message = JSON.parse(String(setup.publish.mock.calls[0][0].Message));
    expect(message.message.embeds[0].fields[0]).toMatchObject({ name: "new owner", value: "holder.eth" });
    expect(store.notificationState()).toBe("published");
  });

  it("keeps a failed publication retryable and advances only after the retry succeeds", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const publish = jest.fn<(input: { Message: string; TopicArn: string }) => Promise<{ MessageId: string }>>()
      .mockRejectedValueOnce(new Error("SNS unavailable"))
      .mockResolvedValueOnce({ MessageId: "message-id" });
    const setup = dependencies({ store, purchases: [purchaseLog()], publish });

    await expect(runMetadataRefreshIndexer(setup.dependencies as never)).rejects.toThrow("SNS unavailable");
    expect(store.checkpoint(PURCHASE_CHECKPOINT)).toEqual({ nextBlock: Number(START_BLOCK), nextLogIndex: 0 });
    expect(store.notificationState()).toBe("pending");

    await expect(runMetadataRefreshIndexer(setup.dependencies as never)).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(store.notificationState()).toBe("published");
    expect(store.checkpoint(PURCHASE_CHECKPOINT)).toEqual({ nextBlock: Number(START_BLOCK + 1n), nextLogIndex: 0 });
  });

  it("falls back to the final-owner address when ENS resolution fails", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const setup = dependencies({ store, purchases: [purchaseLog()], receipt: purchaseReceipt({ forwarded: true }), ensName: new Error("mainnet unavailable") });

    await runMetadataRefreshIndexer(setup.dependencies as never);

    const message = JSON.parse(String(setup.publish.mock.calls[0][0].Message));
    expect(message.message.embeds[0].fields[0]).toMatchObject({ name: "new owner", value: finalOwner });
  });

  it("publishes a native ETH checkout with the final owner", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const setup = dependencies({ store, purchases: [purchaseLog()], receipt: purchaseReceipt({ forwarded: true, nativeEth: true }) });

    await runMetadataRefreshIndexer(setup.dependencies as never);

    const message = JSON.parse(String(setup.publish.mock.calls[0][0].Message));
    expect(message.message.embeds[0].fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "new owner", value: "holder.eth" }),
      expect.objectContaining({ name: "paid", value: "9 ETH" }),
    ]));
  });

  it("drains a metadata window with more than twenty updates across invocations", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const logs = Array.from({ length: 21 }, (_, index) => metadataLog(index));
    const setup = dependencies({ store, metadataLogs: logs, head: START_BLOCK + 28n });

    await runMetadataRefreshIndexer(setup.dependencies as never);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK + 20n), nextLogIndex: 0 });
    expect(store.acceptedJobCount()).toBe(20);

    await runMetadataRefreshIndexer(setup.dependencies as never);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK + 21n), nextLogIndex: 0 });
    expect(store.acceptedJobCount()).toBe(21);
  });

  it("drains more than twenty updates from one block with a log cursor", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const logs = Array.from({ length: 21 }, (_, index) => ({ ...metadataLog(index), blockNumber: START_BLOCK }));
    const setup = dependencies({ store, metadataLogs: logs });

    await runMetadataRefreshIndexer(setup.dependencies as never);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK), nextLogIndex: 20 });
    expect(store.acceptedJobCount()).toBe(20);

    await runMetadataRefreshIndexer(setup.dependencies as never);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK + 1n), nextLogIndex: 0 });
    expect(store.acceptedJobCount()).toBe(21);
  });

  it("caps a same-block sale burst and resumes from the purchase log cursor", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    store.setCheckpoint(START_BLOCK, PURCHASE_CHECKPOINT);
    const purchases = Array.from({ length: 21 }, (_, index) => purchaseLog({
      hash: `0x${(index + 100).toString(16).padStart(64, "0")}`,
      logIndex: index,
    }));
    const setup = dependencies({ store, purchases });

    await runMetadataRefreshIndexer(setup.dependencies as never);
    expect(setup.publish).toHaveBeenCalledTimes(20);
    expect(store.checkpoint(PURCHASE_CHECKPOINT)).toEqual({ nextBlock: Number(START_BLOCK), nextLogIndex: 20 });

    await runMetadataRefreshIndexer(setup.dependencies as never);
    expect(setup.publish).toHaveBeenCalledTimes(21);
    expect(store.checkpoint(PURCHASE_CHECKPOINT)).toEqual({ nextBlock: Number(START_BLOCK + 1n), nextLogIndex: 0 });
  });

  it("advances purchases beyond a permanently failing metadata window", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    store.setCheckpoint(START_BLOCK, PURCHASE_CHECKPOINT);
    const laterHash = `0x${"22".repeat(32)}` as const;
    const fetcher: typeof fetch = async (input) => {
      if (String(input).startsWith("https://metadata.example/")) {
        return new Response(JSON.stringify({ name: "FAME", description: "Society", image: "https://image.example/fame.png" }), { status: 200 });
      }
      return new Response(null, { status: 401 });
    };
    const setup = dependencies({
      store,
      metadataLogs: [metadataLog(0)],
      purchases: [purchaseLog(), purchaseLog({ blockNumber: START_BLOCK + 200n, hash: laterHash })],
      head: START_BLOCK + 208n,
      fetcher,
    });

    await expect(runMetadataRefreshIndexer(setup.dependencies as never)).rejects.toThrow("OpenSea metadata read failed");
    expect(setup.publish).toHaveBeenCalledTimes(1);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK), nextLogIndex: 0 });
    expect(store.checkpoint(PURCHASE_CHECKPOINT)).toEqual({ nextBlock: Number(START_BLOCK + 200n), nextLogIndex: 0 });

    await expect(runMetadataRefreshIndexer(setup.dependencies as never)).rejects.toThrow("OpenSea metadata read failed");
    expect(setup.publish).toHaveBeenCalledTimes(2);
    expect(store.checkpoint(PURCHASE_CHECKPOINT)).toEqual({ nextBlock: Number(START_BLOCK + 201n), nextLogIndex: 0 });
  });

  it("retries retryable OpenSea responses before accepting the job", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    let openSeaReads = 0;
    const fetcher: typeof fetch = async (input) => {
      if (String(input).startsWith("https://metadata.example/")) {
        return new Response(JSON.stringify({ name: "FAME", description: "Society", image: "https://image.example/fame.png" }), { status: 200 });
      }
      openSeaReads += 1;
      if (openSeaReads < 3) return new Response(null, { status: 503, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ nft: { name: "FAME", description: "Society", image_url: "https://image.example/fame.png" } }), { status: 200 });
    };
    const setup = dependencies({ store, metadataLogs: [metadataLog(0)], fetcher });

    await runMetadataRefreshIndexer(setup.dependencies as never);

    expect(openSeaReads).toBe(3);
    expect(store.acceptedJobCount()).toBe(1);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK + 1n), nextLogIndex: 0 });
  });

  it("recovers an in-flight missing NFT without blocking live metadata or replaying the skipped job", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const receiptBlock = BigInt(fixture.blockNumber);
    const metadataLogs = fixture.logs.slice(0, 2).map((log) => ({
      transactionHash: fixture.transactionHash as `0x${string}`,
      blockNumber: receiptBlock,
      logIndex: Number(BigInt(log.logIndex)),
      args: { _tokenId: BigInt(log.data) },
    }));
    const missingLog = metadataLogs.find((log) => log.args._tokenId === 617n);
    if (!missingLog) throw new Error("Fixture is missing MetadataUpdate(617)");
    store.setMetadataJob({
      chainId: BASE_CHAIN_ID,
      transactionHash: missingLog.transactionHash,
      logIndex: missingLog.logIndex,
      tokenId: missingLog.args._tokenId,
      blockNumber: missingLog.blockNumber,
      state: "in_flight",
      attempts: 1,
    });
    const readContract = jest.fn(async ({ abi, functionName, args }: { abi: Abi; functionName: string; args: [bigint] }) => {
      if (functionName !== "tokenURI") throw new Error(`Unexpected contract read ${functionName}`);
      if (args[0] === 617n) throw tokenDoesNotExistError(abi, args[0]);
      return `https://metadata.example/${args[0].toString()}`;
    });
    const fetcher = jest.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("https://metadata.example/")) {
        return new Response(JSON.stringify({ name: "FAME", description: "Society", image: "https://image.example/fame.png" }), { status: 200 });
      }
      return new Response(JSON.stringify({ nft: { name: "FAME", description: "Society", image_url: "https://image.example/fame.png" } }), { status: 200 });
    });
    const setup = dependencies({ store, metadataLogs, head: receiptBlock + 8n, readContract, fetcher });

    await runMetadataRefreshIndexer(setup.dependencies as never);

    expect(store.acceptedJobCount()).toBe(1);
    expect(store.skippedJobCount()).toBe(1);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(receiptBlock + 1n), nextLogIndex: 0 });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "tokenURI", args: [617n] }));
    expect(store.metadataJob(missingLog.transactionHash, missingLog.logIndex)).toEqual(expect.objectContaining({ state: "skipped", skipReason: "token_not_found" }));
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("/617"))).toBe(false);

    const callsAfterFirstRun = readContract.mock.calls.length;
    store.setCheckpoint(START_BLOCK);
    await runMetadataRefreshIndexer(setup.dependencies as never);
    expect(readContract).toHaveBeenCalledTimes(callsAfterFirstRun);
  });

  it("keeps unrelated tokenURI failures loud and retryable", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const setup = dependencies({
      store,
      metadataLogs: [metadataLog(0)],
      readContract: async () => { throw new Error("RPC unavailable"); },
    });

    await expect(runMetadataRefreshIndexer(setup.dependencies as never)).rejects.toThrow("RPC unavailable");
    expect(store.skippedJobCount()).toBe(0);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK), nextLogIndex: 0 });
  });

  it("retries a transport failure and holds the checkpoint after terminal OpenSea failure", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    let openSeaReads = 0;
    const fetcher: typeof fetch = async (input) => {
      if (String(input).startsWith("https://metadata.example/")) {
        return new Response(JSON.stringify({ name: "FAME", description: "Society", image: "https://image.example/fame.png" }), { status: 200 });
      }
      openSeaReads += 1;
      if (openSeaReads === 1) throw new TypeError("connection reset");
      return new Response(null, { status: 503, headers: { "retry-after": "0" } });
    };
    const setup = dependencies({ store, metadataLogs: [metadataLog(0)], fetcher });

    await expect(runMetadataRefreshIndexer(setup.dependencies as never)).rejects.toThrow("OpenSea metadata read failed");

    expect(openSeaReads).toBe(3);
    expect(store.acceptedJobCount()).toBe(0);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK), nextLogIndex: 0 });
  });

  it("holds the metadata checkpoint when the Lambda lacks time for another bounded retry cycle", async () => {
    const store = new InMemoryMetadataRefreshStore();
    store.setCheckpoint(START_BLOCK);
    const setup = dependencies({
      store,
      metadataLogs: [metadataLog(0)],
      remainingTimeInMillis: () => 44_999,
    });

    await expect(runMetadataRefreshIndexer(setup.dependencies as never)).rejects.toThrow("Insufficient Lambda time");

    expect(store.acceptedJobCount()).toBe(0);
    expect(store.checkpoint()).toEqual({ nextBlock: Number(START_BLOCK), nextLogIndex: 0 });
  });
});
