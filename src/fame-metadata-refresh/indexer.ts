import { SNS } from "@aws-sdk/client-sns";
import { type Address } from "viem";
import { baseClient, mainnetClient } from "@/viem.ts";
import { BASE_FAME_NFT_ADDRESS, BASE_UNIVERSAL_MARKETPLACE_ADDRESS } from "@/constants.ts";
import { artworkPurchasedEvent, metadataEvent } from "@/events.ts";
import { sendDiscordMessage } from "@/discord/pubsub/send.ts";
import { createLogger } from "@/utils/logging.ts";
import { advanceCheckpoint, claimPurchaseNotification, getCheckpoint, initializeCheckpoint, markAccepted, markInFlight, putJob, type MetadataRefreshStore } from "./dynamodb.ts";
import { metadataMatches, OpenSeaResponseError, readOpenSeaMetadata, refreshOpenSeaMetadata } from "./opensea.ts";
import { authoritativeMetadata, projectPurchaseNotification, purchaseEmbed } from "./purchase.ts";
import { BASE_CHAIN_ID, type MetadataRefreshJob } from "./types.ts";

const logger = createLogger({ name: "fame-metadata-refresh" });
const FINALITY_BLOCKS = 8n;
const MAX_BLOCKS = 200n;
const MAX_JOBS = 20;
const INITIAL_CHECKPOINT = 49_751_804n;

function startBlock() {
  return INITIAL_CHECKPOINT;
}

async function refreshJob(job: MetadataRefreshJob, dependencies: IndexerDependencies) {
  if (job.state === "accepted") return;
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
      const retryable = error instanceof OpenSeaResponseError && (error.status === 429 || error.status >= 500);
      if (!retryable || attempt === 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, error.retryAfterMs ?? 250 * 2 ** attempt));
    }
  }
}

export type IndexerDependencies = {
  client: Pick<typeof baseClient, "getBlockNumber" | "getLogs" | "getTransactionReceipt" | "readContract">;
  ensClient: Pick<typeof mainnetClient, "getEnsName">;
  store: MetadataRefreshStore;
  sns: SNS;
  fetcher?: typeof fetch;
};

export async function runMetadataRefreshIndexer(dependencies: IndexerDependencies) {
  let checkpoint = await getCheckpoint(dependencies.store);
  if (checkpoint === null) {
    try {
      await initializeCheckpoint(startBlock(), dependencies.store);
      checkpoint = startBlock();
    } catch (error: unknown) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
      checkpoint = await getCheckpoint(dependencies.store);
      if (checkpoint === null) throw new Error("Metadata refresh checkpoint initialization raced without a checkpoint");
    }
  }
  const head = await dependencies.client.getBlockNumber();
  const finalizedHead = head > FINALITY_BLOCKS ? head - FINALITY_BLOCKS : 0n;
  if (checkpoint > finalizedHead) return;
  const toBlock = checkpoint + MAX_BLOCKS - 1n < finalizedHead ? checkpoint + MAX_BLOCKS - 1n : finalizedHead;
  const [metadataLogs, purchases] = await Promise.all([
    dependencies.client.getLogs({ address: BASE_FAME_NFT_ADDRESS as Address, event: metadataEvent, fromBlock: checkpoint, toBlock }),
    dependencies.client.getLogs({ address: BASE_UNIVERSAL_MARKETPLACE_ADDRESS as Address, event: artworkPurchasedEvent, fromBlock: checkpoint, toBlock }),
  ]);
  for (const purchaseLog of purchases) {
    const receipt = await dependencies.client.getTransactionReceipt({ hash: purchaseLog.transactionHash });
    const notification = projectPurchaseNotification({ transactionHash: receipt.transactionHash, logs: receipt.logs });
    if (!notification) {
      logger.warn({ event: "marketplace_purchase_decode_failed", transactionHash: receipt.transactionHash }, "marketplace purchase was not notified");
      continue;
    }
    if (typeof purchaseLog.logIndex !== "number") throw new Error("ArtworkPurchased log is missing an index");
    if (!(await claimPurchaseNotification(receipt.transactionHash, Number(purchaseLog.logIndex), dependencies.store))) continue;
    let recipientDisplayName = notification.recipient;
    try {
      recipientDisplayName = (await dependencies.ensClient.getEnsName({ address: notification.recipient })) ?? notification.recipient;
    } catch (error) {
      logger.warn({ event: "marketplace_purchase_ens_lookup_failed", recipient: notification.recipient, error }, "Failed to fetch ENS name");
    }
    await sendDiscordMessage({ topicArn: requiredEnv("DISCORD_MESSAGE_TOPIC_ARN"), channelId: requiredEnv("DISCORD_CHANNEL_ID"), message: { embeds: [purchaseEmbed(notification, recipientDisplayName)] }, sns: dependencies.sns });
  }
  const jobs = [] as MetadataRefreshJob[];
  for (const log of metadataLogs.slice(0, MAX_JOBS)) {
    if (typeof log.args._tokenId !== "bigint" || typeof log.logIndex !== "number") throw new Error("MetadataUpdate log is malformed");
    jobs.push(await putJob({ chainId: BASE_CHAIN_ID, transactionHash: log.transactionHash, logIndex: Number(log.logIndex), tokenId: log.args._tokenId, blockNumber: log.blockNumber, state: "pending", attempts: 0 }, dependencies.store));
  }
  if (metadataLogs.length > MAX_JOBS) {
    logger.warn({ event: "metadata_refresh_backlog", checkpoint: checkpoint.toString(), eventCount: metadataLogs.length }, "metadata refresh backlog");
    return;
  }
  for (const job of jobs) {
    try { await refreshJob(job, dependencies); }
    catch (error: unknown) {
      const status = error instanceof OpenSeaResponseError ? error.status : undefined;
      logger.error({ event: "metadata_refresh_failed", tokenId: job.tokenId.toString(), transactionHash: job.transactionHash, logIndex: job.logIndex, status }, "metadata refresh failed");
      throw error;
    }
  }
  await advanceCheckpoint(checkpoint, toBlock + 1n, dependencies.store);
  logger.info({ event: "metadata_refresh_checkpoint_advanced", nextBlock: (toBlock + 1n).toString() }, "metadata refresh checkpoint advanced");
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
