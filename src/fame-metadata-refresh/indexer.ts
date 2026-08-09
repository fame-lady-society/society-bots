import { SNS } from "@aws-sdk/client-sns";
import { type Address } from "viem";
import { baseClient, mainnetClient } from "@/viem.ts";
import { BASE_FAME_NFT_ADDRESS, BASE_UNIVERSAL_MARKETPLACE_ADDRESS } from "@/constants.ts";
import { artworkPurchasedEvent, metadataEvent } from "@/events.ts";
import { sendDiscordMessage } from "@/discord/pubsub/send.ts";
import { createLogger } from "@/utils/logging.ts";
import { advanceCheckpoint, getCheckpoint, initializeCheckpoint, markAccepted, markInFlight, markMissingTokenSkipped, markPurchaseNotificationPublished, putJob, shouldPublishPurchaseNotification, type MetadataRefreshCheckpoint, type MetadataRefreshCheckpointId, type MetadataRefreshStore } from "./dynamodb.ts";
import { isRetryableOpenSeaStatus, metadataMatches, OpenSeaResponseError, readOpenSeaMetadata, refreshOpenSeaMetadata } from "./opensea.ts";
import { authoritativeMetadata, isMissingFameNft, projectPurchaseNotification, purchaseEmbed } from "./purchase.ts";
import { BASE_CHAIN_ID, type MetadataRefreshJob } from "./types.ts";

const logger = createLogger({ name: "fame-metadata-refresh" });
const FINALITY_BLOCKS = 8n;
const MAX_BLOCKS = 1_000n;
const MAX_EVENTS = 20;
const MAX_RETRY_DELAY_MS = 1_000;
const MINIMUM_METADATA_JOB_TIME_MS = 45_000;
const INITIAL_CHECKPOINT = 49_729_692n;
const METADATA_CHECKPOINT: MetadataRefreshCheckpointId = "base-metadata-update";
const PURCHASE_CHECKPOINT: MetadataRefreshCheckpointId = "base-marketplace-purchase";

function startBlock() {
  return INITIAL_CHECKPOINT;
}

async function refreshJob(job: MetadataRefreshJob, dependencies: IndexerDependencies) {
  if (job.state === "accepted" || job.state === "skipped") return;
  await markInFlight(job, dependencies.store);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const authoritative = await authoritativeMetadata({ client: dependencies.client, tokenId: job.tokenId, fetcher: dependencies.fetcher });
      const cached = await readOpenSeaMetadata({ apiKey: process.env.OPENSEA_API_KEY, contract: BASE_FAME_NFT_ADDRESS as Address, tokenId: job.tokenId, fetcher: dependencies.fetcher });
      if (!metadataMatches(authoritative, cached)) {
        await refreshOpenSeaMetadata({ apiKey: process.env.OPENSEA_API_KEY, contract: BASE_FAME_NFT_ADDRESS as Address, tokenId: job.tokenId, fetcher: dependencies.fetcher });
      }
      await markAccepted(job, dependencies.store);
      logger.info({ event: "metadata_refresh_accepted", tokenId: job.tokenId.toString(), transactionHash: job.transactionHash, logIndex: job.logIndex }, "metadata refresh accepted");
      return;
    } catch (error: unknown) {
      if (isMissingFameNft(error)) {
        await markMissingTokenSkipped(job, dependencies.store);
        logger.info({ event: "metadata_refresh_skipped", tokenId: job.tokenId.toString(), transactionHash: job.transactionHash, logIndex: job.logIndex, reason: "token_not_found" }, "Metadata refresh skipped for a token that does not exist");
        return;
      }
      const retryable = error instanceof OpenSeaResponseError
        ? isRetryableOpenSeaStatus(error.status)
        : error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
      if (!retryable || attempt === 2) throw error;
      const retryDelay = error instanceof OpenSeaResponseError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : 250 * 2 ** attempt;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(retryDelay, MAX_RETRY_DELAY_MS)));
    }
  }
}

export type IndexerDependencies = {
  client: Pick<typeof baseClient, "getBlockNumber" | "getLogs" | "getTransactionReceipt" | "readContract">;
  ensClient: Pick<typeof mainnetClient, "getEnsName">;
  store: MetadataRefreshStore;
  sns: SNS;
  fetcher?: typeof fetch;
  remainingTimeInMillis?: () => number;
};

type IndexedLog = { blockNumber: bigint; logIndex: number };

async function loadCheckpoint(checkpointId: MetadataRefreshCheckpointId, store: MetadataRefreshStore) {
  let checkpoint = await getCheckpoint(store, checkpointId);
  if (checkpoint === null) {
    try {
      await initializeCheckpoint(startBlock(), store, checkpointId);
      checkpoint = { nextBlock: startBlock(), nextLogIndex: 0 };
    } catch (error: unknown) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
      checkpoint = await getCheckpoint(store, checkpointId);
      if (checkpoint === null) throw new Error("Metadata refresh checkpoint initialization raced without a checkpoint");
    }
  }
  return checkpoint;
}

function toBlockFor(checkpoint: MetadataRefreshCheckpoint, finalizedHead: bigint) {
  return checkpoint.nextBlock + MAX_BLOCKS - 1n < finalizedHead
    ? checkpoint.nextBlock + MAX_BLOCKS - 1n
    : finalizedHead;
}

function boundedLogs<T extends IndexedLog>(logs: readonly T[], checkpoint: MetadataRefreshCheckpoint, toBlock: bigint) {
  const eligible = logs
    .filter((log) => log.blockNumber > checkpoint.nextBlock || (log.blockNumber === checkpoint.nextBlock && log.logIndex >= checkpoint.nextLogIndex))
    .sort((left, right) => left.blockNumber === right.blockNumber
      ? left.logIndex - right.logIndex
      : left.blockNumber < right.blockNumber ? -1 : 1);
  if (eligible.length <= MAX_EVENTS) {
    return {
      logs: eligible,
      nextCheckpoint: { nextBlock: toBlock + 1n, nextLogIndex: 0 } satisfies MetadataRefreshCheckpoint,
      hasBacklog: false,
    };
  }
  const selectedLogs = eligible.slice(0, MAX_EVENTS);
  const lastSelectedLog = selectedLogs[selectedLogs.length - 1];
  const overflowLog = eligible[MAX_EVENTS];
  const nextCheckpoint = overflowLog.blockNumber === lastSelectedLog.blockNumber
    ? { nextBlock: lastSelectedLog.blockNumber, nextLogIndex: lastSelectedLog.logIndex + 1 }
    : { nextBlock: overflowLog.blockNumber, nextLogIndex: 0 };
  return { logs: selectedLogs, nextCheckpoint, hasBacklog: true };
}

async function processPurchaseWindow(dependencies: IndexerDependencies, checkpoint: MetadataRefreshCheckpoint, finalizedHead: bigint) {
  const fromBlock = checkpoint.nextBlock;
  if (fromBlock > finalizedHead) return;
  const toBlock = toBlockFor(checkpoint, finalizedHead);
  const logs = await dependencies.client.getLogs({ address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS as Address, event: artworkPurchasedEvent, fromBlock, toBlock });
  for (const log of logs) {
    if (typeof log.blockNumber !== "bigint" || typeof log.logIndex !== "number") throw new Error("ArtworkPurchased log is malformed");
  }
  const window = boundedLogs(logs, checkpoint, toBlock);
  if (window.hasBacklog) {
    logger.warn({ event: "marketplace_purchase_backlog", checkpoint: fromBlock.toString(), processedCount: window.logs.length, nextBlock: window.nextCheckpoint.nextBlock.toString(), nextLogIndex: window.nextCheckpoint.nextLogIndex }, "marketplace purchase backlog was split at an event boundary");
  }
  if (window.logs.length > 0) {
    const topicArn = requiredEnv("DISCORD_MESSAGE_TOPIC_ARN");
    const channelId = requiredEnv("DISCORD_CHANNEL_ID");
    for (const purchaseLog of window.logs) {
      const receipt = await dependencies.client.getTransactionReceipt({ hash: purchaseLog.transactionHash });
      const notification = projectPurchaseNotification({ transactionHash: receipt.transactionHash, logs: receipt.logs });
      if (!notification) {
        logger.warn({ event: "marketplace_purchase_decode_failed", transactionHash: receipt.transactionHash }, "marketplace purchase was not notified");
        continue;
      }
      if (!(await shouldPublishPurchaseNotification(receipt.transactionHash, Number(purchaseLog.logIndex), dependencies.store))) continue;
      let recipientDisplayName: string = notification.recipient;
      try {
        recipientDisplayName = (await dependencies.ensClient.getEnsName({ address: notification.recipient })) ?? notification.recipient;
      } catch (error) {
        logger.warn({ event: "marketplace_purchase_ens_lookup_failed", recipient: notification.recipient, error }, "Failed to fetch ENS name");
      }
      await sendDiscordMessage({ topicArn, channelId, message: { embeds: [purchaseEmbed(notification, recipientDisplayName)] }, sns: dependencies.sns });
      await markPurchaseNotificationPublished(receipt.transactionHash, Number(purchaseLog.logIndex), dependencies.store);
    }
  }
  await advanceCheckpoint(checkpoint, window.nextCheckpoint, dependencies.store, PURCHASE_CHECKPOINT);
  logger.info({ event: "marketplace_purchase_checkpoint_advanced", nextBlock: window.nextCheckpoint.nextBlock.toString(), nextLogIndex: window.nextCheckpoint.nextLogIndex }, "marketplace purchase checkpoint advanced");
}

async function processMetadataWindow(dependencies: IndexerDependencies, checkpoint: MetadataRefreshCheckpoint, finalizedHead: bigint) {
  const fromBlock = checkpoint.nextBlock;
  if (fromBlock > finalizedHead) return;
  const toBlock = toBlockFor(checkpoint, finalizedHead);
  const logs = await dependencies.client.getLogs({ address: BASE_FAME_NFT_ADDRESS as Address, event: metadataEvent, fromBlock, toBlock });
  for (const log of logs) {
    if (typeof log.blockNumber !== "bigint" || typeof log.logIndex !== "number") throw new Error("MetadataUpdate log is malformed");
  }
  const window = boundedLogs(logs, checkpoint, toBlock);
  if (window.hasBacklog) {
    logger.warn({ event: "metadata_refresh_backlog", checkpoint: fromBlock.toString(), processedCount: window.logs.length, nextBlock: window.nextCheckpoint.nextBlock.toString(), nextLogIndex: window.nextCheckpoint.nextLogIndex }, "metadata refresh backlog was split at an event boundary");
  }
  const jobs = [] as MetadataRefreshJob[];
  for (const log of window.logs) {
    if (typeof log.args._tokenId !== "bigint") throw new Error("MetadataUpdate log is malformed");
    jobs.push(await putJob({ chainId: BASE_CHAIN_ID, transactionHash: log.transactionHash, logIndex: Number(log.logIndex), tokenId: log.args._tokenId, blockNumber: log.blockNumber, state: "pending", attempts: 0 }, dependencies.store));
  }
  for (const job of jobs) {
    const remainingTimeMs = dependencies.remainingTimeInMillis?.();
    if (remainingTimeMs !== undefined && remainingTimeMs < MINIMUM_METADATA_JOB_TIME_MS) {
      logger.warn({ event: "metadata_refresh_time_budget_exhausted", tokenId: job.tokenId.toString(), remainingTimeMs }, "metadata refresh stopped before the Lambda deadline");
      throw new Error("Insufficient Lambda time remains for another metadata refresh job");
    }
    try { await refreshJob(job, dependencies); }
    catch (error: unknown) {
      const status = error instanceof OpenSeaResponseError ? error.status : undefined;
      logger.error({ event: "metadata_refresh_failed", tokenId: job.tokenId.toString(), transactionHash: job.transactionHash, logIndex: job.logIndex, status }, "metadata refresh failed");
      throw error;
    }
  }
  await advanceCheckpoint(checkpoint, window.nextCheckpoint, dependencies.store, METADATA_CHECKPOINT);
  logger.info({ event: "metadata_refresh_checkpoint_advanced", nextBlock: window.nextCheckpoint.nextBlock.toString(), nextLogIndex: window.nextCheckpoint.nextLogIndex }, "metadata refresh checkpoint advanced");
}

export async function runMetadataRefreshIndexer(dependencies: IndexerDependencies) {
  const head = await dependencies.client.getBlockNumber();
  const finalizedHead = head > FINALITY_BLOCKS ? head - FINALITY_BLOCKS : 0n;
  const purchaseCheckpoint = await loadCheckpoint(PURCHASE_CHECKPOINT, dependencies.store);
  await processPurchaseWindow(dependencies, purchaseCheckpoint, finalizedHead);
  const metadataCheckpoint = await loadCheckpoint(METADATA_CHECKPOINT, dependencies.store);
  await processMetadataWindow(dependencies, metadataCheckpoint, finalizedHead);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
