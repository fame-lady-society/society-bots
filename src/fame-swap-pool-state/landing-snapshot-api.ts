import { getCurrentFameLandingSnapshot } from "./dynamodb/landing-snapshot.ts";
import {
  FAME_LANDING_SNAPSHOT_CACHE_SECONDS,
  FAME_LANDING_SNAPSHOT_FUTURE_TOLERANCE_SECONDS,
  FAME_LANDING_SNAPSHOT_MAX_AGE_SECONDS,
  FAME_LANDING_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS,
  type FameLandingSnapshot,
} from "./landing-snapshot.ts";

export type FameLandingSnapshotTransportReason =
  | "snapshot-future"
  | "snapshot-invalid"
  | "snapshot-missing"
  | "snapshot-stale";

export type FameLandingSnapshotApiResult =
  | {
      status: "success";
      snapshot: FameLandingSnapshot;
      ageSeconds: number;
      cacheControl: string;
    }
  | {
      status: "unavailable";
      reason: FameLandingSnapshotTransportReason;
    };

export async function readFameLandingSnapshotResponse({
  tableName,
  now = new Date(),
  getSnapshot = ({ tableName: selectedTableName }: { tableName: string }) =>
    getCurrentFameLandingSnapshot({ tableName: selectedTableName }),
  maxAgeSeconds = FAME_LANDING_SNAPSHOT_MAX_AGE_SECONDS,
  cacheSeconds: configuredCacheSeconds = FAME_LANDING_SNAPSHOT_CACHE_SECONDS,
  staleWhileRevalidateSeconds = FAME_LANDING_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS,
  futureToleranceSeconds = FAME_LANDING_SNAPSHOT_FUTURE_TOLERANCE_SECONDS,
}: {
  tableName: string;
  now?: Date;
  getSnapshot?: (options: {
    tableName: string;
  }) => Promise<FameLandingSnapshot | null>;
  maxAgeSeconds?: number;
  cacheSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  futureToleranceSeconds?: number;
}): Promise<FameLandingSnapshotApiResult> {
  let snapshot: FameLandingSnapshot | null;
  try {
    snapshot = await getSnapshot({ tableName });
  } catch {
    return { status: "unavailable", reason: "snapshot-invalid" };
  }
  if (!snapshot) return { status: "unavailable", reason: "snapshot-missing" };
  const nowMs = now.getTime();
  const capturedAtMs = Date.parse(snapshot.provenance.capturedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(capturedAtMs)) {
    return { status: "unavailable", reason: "snapshot-invalid" };
  }
  const ageSeconds = Math.floor((nowMs - capturedAtMs) / 1_000);
  if (ageSeconds < -futureToleranceSeconds) {
    return { status: "unavailable", reason: "snapshot-future" };
  }
  if (ageSeconds >= maxAgeSeconds) {
    return { status: "unavailable", reason: "snapshot-stale" };
  }
  const normalizedAge = Math.max(0, ageSeconds);
  const remaining = maxAgeSeconds - normalizedAge;
  const cacheSeconds = Math.min(configuredCacheSeconds, remaining);
  const staleSeconds = Math.min(
    staleWhileRevalidateSeconds,
    Math.max(0, remaining - cacheSeconds),
  );
  return {
    status: "success",
    snapshot,
    ageSeconds: normalizedAge,
    cacheControl: `public, max-age=${cacheSeconds.toString()}, s-maxage=${cacheSeconds.toString()}, stale-while-revalidate=${staleSeconds.toString()}`,
  };
}
