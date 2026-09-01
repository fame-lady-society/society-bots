import type { mainnetClient } from "@/viem.ts";
import { ETHEREUM_FLS_NAMING_ADDRESS } from "@/constants.ts";
import { flsNameClaimedEvent } from "@/events.ts";
import { createLogger } from "@/utils/logging.ts";
import type {
  ProfileCheckpoint,
  ProfileNotificationStore,
} from "./profile-store.ts";
import type { SocietyProfile } from "./profile.ts";

const logger = createLogger({ name: "fls-profile-notifications" });

export const PROFILE_START_BLOCK = 25_883_964n;
const MAX_BLOCKS = 1_000n;
const MAX_EVENTS = 20;

type IndexedLog = {
  blockNumber: bigint;
  logIndex: number;
};

export type ProfileIndexerDependencies = {
  client: Pick<typeof mainnetClient, "getBlockNumber" | "getLogs">;
  store: ProfileNotificationStore;
  publish(profile: SocietyProfile): Promise<void>;
};

async function loadCheckpoint(store: ProfileNotificationStore) {
  let checkpoint = await store.getCheckpoint();
  if (checkpoint !== null) return checkpoint;

  try {
    await store.initializeCheckpoint(PROFILE_START_BLOCK);
    return { nextBlock: PROFILE_START_BLOCK, nextLogIndex: 0 };
  } catch (error: unknown) {
    if (
      (error as { name?: string }).name !== "ConditionalCheckFailedException"
    ) {
      throw error;
    }
  }

  checkpoint = await store.getCheckpoint();
  if (checkpoint === null) {
    throw new Error(
      "Society profile checkpoint initialization raced without a checkpoint",
    );
  }
  return checkpoint;
}

function toBlockFor(checkpoint: ProfileCheckpoint, head: bigint) {
  const windowEnd = checkpoint.nextBlock + MAX_BLOCKS - 1n;
  return windowEnd < head ? windowEnd : head;
}

function boundedLogs<T extends IndexedLog>(
  logs: readonly T[],
  checkpoint: ProfileCheckpoint,
  toBlock: bigint,
) {
  const eligible = logs
    .filter(
      (log) =>
        log.blockNumber > checkpoint.nextBlock ||
        (log.blockNumber === checkpoint.nextBlock &&
          log.logIndex >= checkpoint.nextLogIndex),
    )
    .sort((left, right) =>
      left.blockNumber === right.blockNumber
        ? left.logIndex - right.logIndex
        : left.blockNumber < right.blockNumber
          ? -1
          : 1,
    );

  if (eligible.length <= MAX_EVENTS) {
    return {
      logs: eligible,
      nextCheckpoint: {
        nextBlock: toBlock + 1n,
        nextLogIndex: 0,
      } satisfies ProfileCheckpoint,
    };
  }

  const selectedLogs = eligible.slice(0, MAX_EVENTS);
  const lastSelectedLog = selectedLogs[selectedLogs.length - 1];
  const overflowLog = eligible[MAX_EVENTS];
  const nextCheckpoint =
    overflowLog.blockNumber === lastSelectedLog.blockNumber
      ? {
          nextBlock: lastSelectedLog.blockNumber,
          nextLogIndex: lastSelectedLog.logIndex + 1,
        }
      : { nextBlock: overflowLog.blockNumber, nextLogIndex: 0 };
  return { logs: selectedLogs, nextCheckpoint };
}

export async function runProfileNotificationIndexer(
  dependencies: ProfileIndexerDependencies,
) {
  const [head, checkpoint] = await Promise.all([
    dependencies.client.getBlockNumber(),
    loadCheckpoint(dependencies.store),
  ]);
  if (checkpoint.nextBlock > head) return;

  const toBlock = toBlockFor(checkpoint, head);
  const logs = await dependencies.client.getLogs({
    address: ETHEREUM_FLS_NAMING_ADDRESS,
    event: flsNameClaimedEvent,
    strict: true,
    fromBlock: checkpoint.nextBlock,
    toBlock,
  });

  for (const log of logs) {
    if (
      typeof log.blockNumber !== "bigint" ||
      typeof log.logIndex !== "number" ||
      typeof log.transactionHash !== "string" ||
      typeof log.args.name !== "string" ||
      typeof log.args.primaryTokenId !== "bigint"
    ) {
      throw new Error("NameClaimed log is malformed");
    }
  }

  const window = boundedLogs(logs, checkpoint, toBlock);
  for (const log of window.logs) {
    if (
      !(await dependencies.store.reserveNotification(
        log.transactionHash,
        log.logIndex,
      ))
    ) {
      continue;
    }

    await dependencies.publish({
      name: log.args.name,
      primaryTokenId: log.args.primaryTokenId,
    });
    await dependencies.store.markPublished(log.transactionHash, log.logIndex);
    logger.info(
      {
        event: "society_profile_notification_published",
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber.toString(),
      },
      "Society profile notification published",
    );
  }

  await dependencies.store.advanceCheckpoint(checkpoint, window.nextCheckpoint);
  logger.info(
    {
      event: "society_profile_checkpoint_advanced",
      nextBlock: window.nextCheckpoint.nextBlock.toString(),
      nextLogIndex: window.nextCheckpoint.nextLogIndex,
    },
    "Society profile checkpoint advanced",
  );
}
