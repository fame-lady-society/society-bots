import { describe, expect, test } from "@jest/globals";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "node:fs";
import {
  currentFameLandingSnapshotKey,
  getCurrentFameLandingSnapshot,
  landingSnapshotContentKey,
  publishFameLandingSnapshot,
} from "./landing-snapshot.ts";
import {
  FAME_LANDING_SNAPSHOT_CONTENT_TTL_SECONDS,
  fameLandingAuthority,
  fameLandingSnapshotId,
  parseFameLandingSnapshot,
  type FameLandingSnapshot,
} from "../landing-snapshot.ts";
import type {
  PoolStateDocumentClient,
  PoolStateDynamoResponse,
} from "./pool-state.ts";

type Command = Parameters<PoolStateDocumentClient["send"]>[0];

function key(item: Record<string, unknown>): string {
  return `${String(item.pk)}\u0000${String(item.sk)}`;
}

class LandingSnapshotDb implements PoolStateDocumentClient {
  public readonly commands: Command[] = [];
  public readonly items = new Map<string, Record<string, unknown>>();

  async send(command: Command): Promise<PoolStateDynamoResponse> {
    this.commands.push(command);
    if (command instanceof GetCommand) {
      return { Item: this.items.get(key(command.input.Key ?? {})) };
    }
    if (!(command instanceof PutCommand)) {
      throw new Error(`Unexpected ${command.constructor.name}.`);
    }
    const item = command.input.Item;
    if (!item) throw new Error("Missing put item.");
    const existing = this.items.get(key(item));
    const condition = command.input.ConditionExpression;
    if (
      condition === "attribute_not_exists(pk) AND attribute_not_exists(sk)" &&
      existing
    ) {
      const error = new Error("conditional");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    if (condition?.includes("safeBlockNumber < :safeBlockNumber") && existing) {
      const incomingBlock = Number(
        command.input.ExpressionAttributeValues?.[":safeBlockNumber"],
      );
      const currentBlock = Number(existing.safeBlockNumber);
      const currentCapturedAt = String(existing.capturedAt);
      const incomingCapturedAt = String(
        command.input.ExpressionAttributeValues?.[":capturedAt"],
      );
      if (
        (currentBlock > incomingBlock ||
          (currentBlock === incomingBlock &&
            currentCapturedAt >= incomingCapturedAt)) &&
        existing.snapshotId !== item.snapshotId
      ) {
        const error = new Error("conditional");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
    }
    this.items.set(key(item), item);
    return {};
  }
}

function snapshotFixture(): FameLandingSnapshot {
  return parseFameLandingSnapshot(
    JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/fame-landing-defi-snapshot-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown,
    fameLandingAuthority,
  );
}

describe("FAME landing snapshot DynamoDB publication", () => {
  test("writes immutable content with 24-hour TTL before a non-expiring pointer", async () => {
    const db = new LandingSnapshotDb();
    const snapshot = snapshotFixture();
    const publishedAt = new Date("2026-08-09T12:00:05.000Z");

    const result = await publishFameLandingSnapshot({
      db,
      tableName: "PoolState",
      snapshot,
      publishedAt,
    });

    expect(result).toBe("advanced");
    const puts = db.commands.filter(
      (command): command is PutCommand => command instanceof PutCommand,
    );
    expect(puts).toHaveLength(2);
    expect(puts[0]?.input.Item).toMatchObject({
      ...landingSnapshotContentKey(snapshot.provenance.snapshotId),
      snapshotId: snapshot.provenance.snapshotId,
      expiresAt:
        Math.floor(publishedAt.getTime() / 1_000) +
        FAME_LANDING_SNAPSHOT_CONTENT_TTL_SECONDS,
    });
    expect(puts[1]?.input.Item).toMatchObject({
      ...currentFameLandingSnapshotKey(),
      snapshotId: snapshot.provenance.snapshotId,
      safeBlockNumber: snapshot.provenance.safeBlockNumber,
    });
    expect(puts[1]?.input.Item).not.toHaveProperty("expiresAt");
  });

  test("publishes explicit unavailable leaves and reads only pointer-selected content", async () => {
    const db = new LandingSnapshotDb();
    const snapshot = snapshotFixture();
    snapshot.fields.quotes.defiBuyUsdc = {
      status: "unavailable",
      reason: "dependency-unavailable",
    };
    await publishFameLandingSnapshot({
      db,
      tableName: "PoolState",
      snapshot,
    });

    const current = await getCurrentFameLandingSnapshot({
      db,
      tableName: "PoolState",
    });
    expect(current?.fields.quotes.defiBuyUsdc).toEqual({
      status: "unavailable",
      reason: "dependency-unavailable",
    });
    const reads = db.commands.filter(
      (command): command is GetCommand => command instanceof GetCommand,
    );
    expect(reads).toHaveLength(2);
    expect(
      reads.every((command) => command.input.ConsistentRead === true),
    ).toBe(true);
  });

  test("recovers a content-only write but cannot regress a newer pointer", async () => {
    const db = new LandingSnapshotDb();
    const snapshot = snapshotFixture();
    const contentKey = landingSnapshotContentKey(
      snapshot.provenance.snapshotId,
    );
    db.items.set(key(contentKey), {
      ...contentKey,
      recordKind: "fame-landing-snapshot-content-v1",
      snapshotId: snapshot.provenance.snapshotId,
      safeBlockNumber: snapshot.provenance.safeBlockNumber,
      safeBlockHash: snapshot.provenance.safeBlockHash,
      sourceRegistryId: snapshot.provenance.sourceRegistryId,
      routeAuthorityRevision: snapshot.provenance.routeAuthorityRevision,
      schemaVersion: snapshot.schemaVersion,
      document: snapshot,
      capturedAt: snapshot.provenance.capturedAt,
      publishedAt: snapshot.provenance.capturedAt,
      expiresAt: 9_999_999_999,
    });

    await expect(
      publishFameLandingSnapshot({ db, tableName: "PoolState", snapshot }),
    ).resolves.toBe("advanced");

    const newer = structuredClone(snapshot);
    newer.provenance.safeBlockNumber += 1;
    newer.provenance.safeBlockHash =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    newer.provenance.capturedAt = "2026-08-09T12:01:00.000Z";
    newer.provenance.snapshotId = fameLandingSnapshotId(
      newer.provenance.safeBlockNumber,
      newer.provenance.safeBlockHash,
      newer.provenance.capturedAt,
    );
    await publishFameLandingSnapshot({
      db,
      tableName: "PoolState",
      snapshot: newer,
    });
    await expect(
      publishFameLandingSnapshot({ db, tableName: "PoolState", snapshot }),
    ).resolves.toBe("ignored");
    expect(db.items.get(key(currentFameLandingSnapshotKey()))?.snapshotId).toBe(
      newer.provenance.snapshotId,
    );
  });

  test("retries unavailable leaves at the same safe block in a newer immutable pass", async () => {
    const db = new LandingSnapshotDb();
    const first = snapshotFixture();
    first.fields.quotes.defiBuyEth = {
      status: "unavailable",
      reason: "dependency-unavailable",
    };
    await publishFameLandingSnapshot({
      db,
      tableName: "PoolState",
      snapshot: first,
    });

    const retried = snapshotFixture();
    retried.provenance.capturedAt = "2026-08-09T12:01:00.000Z";
    retried.provenance.snapshotId = fameLandingSnapshotId(
      retried.provenance.safeBlockNumber,
      retried.provenance.safeBlockHash,
      retried.provenance.capturedAt,
    );
    await expect(
      publishFameLandingSnapshot({
        db,
        tableName: "PoolState",
        snapshot: retried,
      }),
    ).resolves.toBe("advanced");
    await expect(
      getCurrentFameLandingSnapshot({ db, tableName: "PoolState" }),
    ).resolves.toEqual(retried);
  });

  test("fails closed when pointer and immutable content disagree", async () => {
    const db = new LandingSnapshotDb();
    const snapshot = snapshotFixture();
    await publishFameLandingSnapshot({ db, tableName: "PoolState", snapshot });
    const content = db.items.get(
      key(landingSnapshotContentKey(snapshot.provenance.snapshotId)),
    );
    if (!content) throw new Error("Missing fixture content.");
    content.sourceRegistryId = "wrong";

    await expect(
      getCurrentFameLandingSnapshot({ db, tableName: "PoolState" }),
    ).rejects.toThrow(/pointer and content disagree/u);
  });
});
