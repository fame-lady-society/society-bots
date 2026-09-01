import { describe, expect, it, jest } from "@jest/globals";

import type { ProfileIndexerDependencies } from "./profile-indexer.ts";
import {
  PROFILE_START_BLOCK,
  runProfileNotificationIndexer,
} from "./profile-indexer.ts";
import type {
  ProfileCheckpoint,
  ProfileNotificationStore,
} from "./profile-store.ts";

const primary = "0xf11ce547ff948a03570b20eac4a4d7b648693324" as const;

function hash(index: number) {
  return `0x${index.toString(16).padStart(64, "0")}` as `0x${string}`;
}

function claimedLog({
  blockNumber = PROFILE_START_BLOCK,
  logIndex = 0,
  name = "flick",
  primaryTokenId = 6_929n,
}: {
  blockNumber?: bigint;
  logIndex?: number;
  name?: unknown;
  primaryTokenId?: unknown;
} = {}) {
  return {
    blockNumber,
    logIndex,
    transactionHash: hash(logIndex + 1),
    args: {
      tokenId: BigInt(logIndex + 1),
      primary,
      name,
      primaryTokenId,
    },
  };
}

class MemoryProfileStore implements ProfileNotificationStore {
  checkpoint: ProfileCheckpoint | null = null;
  notifications = new Map<string, "pending" | "published">();
  failPublishedWrite = false;

  async getCheckpoint() {
    return this.checkpoint === null ? null : { ...this.checkpoint };
  }

  async initializeCheckpoint(startBlock: bigint) {
    if (this.checkpoint !== null) {
      const error = new Error("checkpoint exists");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    this.checkpoint = { nextBlock: startBlock, nextLogIndex: 0 };
  }

  async advanceCheckpoint(
    expected: ProfileCheckpoint,
    next: ProfileCheckpoint,
  ) {
    if (
      this.checkpoint?.nextBlock !== expected.nextBlock ||
      this.checkpoint.nextLogIndex !== expected.nextLogIndex
    ) {
      const error = new Error("checkpoint changed");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    this.checkpoint = { ...next };
  }

  async reserveNotification(transactionHash: `0x${string}`, logIndex: number) {
    const key = `${transactionHash}:${logIndex}`;
    const state = this.notifications.get(key);
    if (state === "published") return false;
    if (state === undefined) this.notifications.set(key, "pending");
    return true;
  }

  async markPublished(transactionHash: `0x${string}`, logIndex: number) {
    if (this.failPublishedWrite) throw new Error("DynamoDB unavailable");
    const key = `${transactionHash}:${logIndex}`;
    if (this.notifications.get(key) !== "pending") {
      throw new Error("notification is not pending");
    }
    this.notifications.set(key, "published");
  }

  stateFor(logIndex = 0) {
    return this.notifications.get(`${hash(logIndex + 1)}:${logIndex}`);
  }
}

function fakeClient(logs: ReturnType<typeof claimedLog>[], head: bigint) {
  return {
    getBlockNumber: jest.fn(async () => head),
    getLogs: jest.fn(
      async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
        logs.filter(
          (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
        ),
    ),
  } as unknown as ProfileIndexerDependencies["client"];
}

describe("Society profile notification indexer", () => {
  it("starts at the pinned block and processes the latest head without an extra delay", async () => {
    const store = new MemoryProfileStore();
    const beforeStart = claimedLog({ blockNumber: PROFILE_START_BLOCK - 1n });
    const atStart = claimedLog({ logIndex: 1 });
    const client = fakeClient([beforeStart, atStart], PROFILE_START_BLOCK);
    const publish = jest.fn(async () => undefined);

    await runProfileNotificationIndexer({ client, store, publish });

    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        fromBlock: PROFILE_START_BLOCK,
        toBlock: PROFILE_START_BLOCK,
      }),
    );
    expect(publish).toHaveBeenCalledWith({
      name: "flick",
      primaryTokenId: 6_929n,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.checkpoint).toEqual({
      nextBlock: PROFILE_START_BLOCK + 1n,
      nextLogIndex: 0,
    });
  });

  it("keeps a failed publication pending and retries it", async () => {
    const store = new MemoryProfileStore();
    store.checkpoint = { nextBlock: PROFILE_START_BLOCK, nextLogIndex: 0 };
    const client = fakeClient([claimedLog()], PROFILE_START_BLOCK);
    const failure = new Error("SNS unavailable");

    await expect(
      runProfileNotificationIndexer({
        client,
        store,
        publish: jest.fn(async () => {
          throw failure;
        }),
      }),
    ).rejects.toBe(failure);
    expect(store.stateFor()).toBe("pending");
    expect(store.checkpoint).toEqual({
      nextBlock: PROFILE_START_BLOCK,
      nextLogIndex: 0,
    });

    const publish = jest.fn(async () => undefined);
    await runProfileNotificationIndexer({ client, store, publish });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.stateFor()).toBe("published");
    expect(store.checkpoint?.nextBlock).toBe(PROFILE_START_BLOCK + 1n);
  });

  it("skips an already-published event during checkpoint replay", async () => {
    const store = new MemoryProfileStore();
    store.checkpoint = { nextBlock: PROFILE_START_BLOCK, nextLogIndex: 0 };
    const client = fakeClient([claimedLog()], PROFILE_START_BLOCK);
    const publish = jest.fn(async () => undefined);

    await runProfileNotificationIndexer({ client, store, publish });
    store.checkpoint = { nextBlock: PROFILE_START_BLOCK, nextLogIndex: 0 };
    await runProfileNotificationIndexer({ client, store, publish });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.checkpoint?.nextBlock).toBe(PROFILE_START_BLOCK + 1n);
  });

  it("permits at-least-once replay when publication succeeds but the state write fails", async () => {
    const store = new MemoryProfileStore();
    store.checkpoint = { nextBlock: PROFILE_START_BLOCK, nextLogIndex: 0 };
    store.failPublishedWrite = true;
    const client = fakeClient([claimedLog()], PROFILE_START_BLOCK);
    const publish = jest.fn(async () => undefined);

    await expect(
      runProfileNotificationIndexer({ client, store, publish }),
    ).rejects.toThrow("DynamoDB unavailable");
    expect(store.stateFor()).toBe("pending");
    expect(store.checkpoint?.nextBlock).toBe(PROFILE_START_BLOCK);

    store.failPublishedWrite = false;
    await runProfileNotificationIndexer({ client, store, publish });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(store.stateFor()).toBe("published");
  });

  it("continues within one block after the twenty-event boundary", async () => {
    const store = new MemoryProfileStore();
    store.checkpoint = { nextBlock: PROFILE_START_BLOCK, nextLogIndex: 0 };
    const logs = Array.from({ length: 21 }, (_, logIndex) =>
      claimedLog({ logIndex, name: `lady-${logIndex}` }),
    );
    const client = fakeClient(logs, PROFILE_START_BLOCK);
    const publish = jest.fn(async () => undefined);

    await runProfileNotificationIndexer({ client, store, publish });
    expect(publish).toHaveBeenCalledTimes(20);
    expect(store.checkpoint).toEqual({
      nextBlock: PROFILE_START_BLOCK,
      nextLogIndex: 20,
    });

    await runProfileNotificationIndexer({ client, store, publish });
    expect(publish).toHaveBeenCalledTimes(21);
    expect(store.checkpoint).toEqual({
      nextBlock: PROFILE_START_BLOCK + 1n,
      nextLogIndex: 0,
    });
  });

  it("rejects malformed logs without advancing the checkpoint", async () => {
    const store = new MemoryProfileStore();
    store.checkpoint = { nextBlock: PROFILE_START_BLOCK, nextLogIndex: 0 };
    const client = fakeClient(
      [claimedLog({ name: null })],
      PROFILE_START_BLOCK,
    );
    const publish = jest.fn(async () => undefined);

    await expect(
      runProfileNotificationIndexer({ client, store, publish }),
    ).rejects.toThrow("NameClaimed log is malformed");
    expect(publish).not.toHaveBeenCalled();
    expect(store.checkpoint).toEqual({
      nextBlock: PROFILE_START_BLOCK,
      nextLogIndex: 0,
    });
  });
});
