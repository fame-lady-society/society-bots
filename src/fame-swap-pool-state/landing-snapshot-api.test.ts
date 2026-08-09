import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  FAME_LANDING_SNAPSHOT_MAX_AGE_SECONDS,
  fameLandingAuthority,
  parseFameLandingSnapshot,
  type FameLandingSnapshot,
} from "./landing-snapshot.ts";
import { readFameLandingSnapshotResponse } from "./landing-snapshot-api.ts";

function fixture(): FameLandingSnapshot {
  return parseFameLandingSnapshot(
    JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/fame-landing-defi-snapshot-v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    fameLandingAuthority,
  );
}

describe("public FAME landing snapshot response", () => {
  test("returns one pointer-selected snapshot with bounded cache headers", async () => {
    const snapshot = fixture();
    const now = new Date(
      new Date(snapshot.provenance.capturedAt).getTime() + 45_000,
    );
    const result = await readFameLandingSnapshotResponse({
      tableName: "PoolState",
      now,
      getSnapshot: async () => snapshot,
    });

    expect(result).toMatchObject({
      status: "success",
      snapshot,
      ageSeconds: 45,
    });
    if (result.status !== "success") throw new Error("Expected success.");
    expect(result.cacheControl).toBe(
      "public, max-age=60, s-maxage=60, stale-while-revalidate=120",
    );
  });

  test("returns unavailable for missing storage", async () => {
    await expect(
      readFameLandingSnapshotResponse({
        tableName: "PoolState",
        getSnapshot: async (): Promise<FameLandingSnapshot | null> => null,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "snapshot-missing" });
  });

  test("sanitizes malformed storage as invalid", async () => {
    await expect(
      readFameLandingSnapshotResponse({
        tableName: "PoolState",
        getSnapshot: async (): Promise<FameLandingSnapshot | null> => {
          throw new Error("corrupt row with internal payload");
        },
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "snapshot-invalid" });
  });

  test("rejects stale and future documents without caching them", async () => {
    const snapshot = fixture();
    const captured = new Date(snapshot.provenance.capturedAt).getTime();
    await expect(
      readFameLandingSnapshotResponse({
        tableName: "PoolState",
        now: new Date(captured + FAME_LANDING_SNAPSHOT_MAX_AGE_SECONDS * 1_000),
        getSnapshot: async () => snapshot,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "snapshot-stale" });
    await expect(
      readFameLandingSnapshotResponse({
        tableName: "PoolState",
        now: new Date(captured - 31_000),
        getSnapshot: async () => snapshot,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "snapshot-future" });
  });

  test("shrinks cache lifetime near the freshness ceiling", async () => {
    const snapshot = fixture();
    const now = new Date(
      new Date(snapshot.provenance.capturedAt).getTime() + 290_000,
    );
    const result = await readFameLandingSnapshotResponse({
      tableName: "PoolState",
      now,
      getSnapshot: async () => snapshot,
    });
    expect(result).toMatchObject({ status: "success", ageSeconds: 290 });
    if (result.status !== "success") throw new Error("Expected success.");
    expect(result.cacheControl).toBe(
      "public, max-age=10, s-maxage=10, stale-while-revalidate=0",
    );
  });
});
