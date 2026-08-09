import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  FAME_LANDING_SNAPSHOT_CONTENT_TTL_SECONDS,
  FAME_LANDING_SNAPSHOT_SCHEMA_VERSION,
  fameLandingAuthority,
  parseFameLandingSnapshot,
  type FameLandingAuthority,
  type FameLandingSnapshot,
} from "../landing-snapshot.ts";
import { defaultDb, type PoolStateDocumentClient } from "./pool-state.ts";

const LANDING_SNAPSHOT_PK = "landing:fame-defi-snapshot";

export interface FameLandingSnapshotPointer extends Record<string, unknown> {
  pk: typeof LANDING_SNAPSHOT_PK;
  sk: "current";
  recordKind: "fame-landing-snapshot-pointer-v1";
  snapshotId: string;
  safeBlockNumber: number;
  safeBlockHash: string;
  sourceRegistryId: string;
  routeAuthorityRevision: string;
  schemaVersion: typeof FAME_LANDING_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  publishedAt: string;
}

export interface FameLandingSnapshotContent extends Record<string, unknown> {
  pk: typeof LANDING_SNAPSHOT_PK;
  sk: `snapshot:${string}`;
  recordKind: "fame-landing-snapshot-content-v1";
  snapshotId: string;
  safeBlockNumber: number;
  safeBlockHash: string;
  sourceRegistryId: string;
  routeAuthorityRevision: string;
  schemaVersion: typeof FAME_LANDING_SNAPSHOT_SCHEMA_VERSION;
  capturedAt: string;
  publishedAt: string;
  expiresAt: number;
  document: FameLandingSnapshot;
}

export type PublishFameLandingSnapshotResult = "advanced" | "ignored";

export class FameLandingSnapshotStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FameLandingSnapshotStorageError";
  }
}

function storageError(message: string): never {
  throw new FameLandingSnapshotStorageError(message);
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    storageError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    storageError(`${label}.${field} must be a non-empty string`);
  }
  return result;
}

function requiredInteger(
  value: Record<string, unknown>,
  field: string,
  label: string,
): number {
  const result = value[field];
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 0
  ) {
    storageError(`${label}.${field} must be a non-negative safe integer`);
  }
  return result;
}

export function currentFameLandingSnapshotKey(): {
  pk: typeof LANDING_SNAPSHOT_PK;
  sk: "current";
} {
  return { pk: LANDING_SNAPSHOT_PK, sk: "current" };
}

export function landingSnapshotContentKey(snapshotId: string): {
  pk: typeof LANDING_SNAPSHOT_PK;
  sk: `snapshot:${string}`;
} {
  if (snapshotId.length === 0) storageError("snapshotId must not be empty");
  return { pk: LANDING_SNAPSHOT_PK, sk: `snapshot:${snapshotId}` };
}

function contentFromSnapshot({
  snapshot,
  publishedAt,
  ttlSeconds,
}: {
  snapshot: FameLandingSnapshot;
  publishedAt: Date;
  ttlSeconds: number;
}): FameLandingSnapshotContent {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    storageError("snapshot TTL must be a positive safe integer");
  }
  const publishedAtMs = publishedAt.getTime();
  if (!Number.isFinite(publishedAtMs))
    storageError("publishedAt must be valid");
  return {
    ...landingSnapshotContentKey(snapshot.provenance.snapshotId),
    recordKind: "fame-landing-snapshot-content-v1",
    snapshotId: snapshot.provenance.snapshotId,
    safeBlockNumber: snapshot.provenance.safeBlockNumber,
    safeBlockHash: snapshot.provenance.safeBlockHash,
    sourceRegistryId: snapshot.provenance.sourceRegistryId,
    routeAuthorityRevision: snapshot.provenance.routeAuthorityRevision,
    schemaVersion: snapshot.schemaVersion,
    capturedAt: snapshot.provenance.capturedAt,
    publishedAt: publishedAt.toISOString(),
    expiresAt: Math.floor(publishedAtMs / 1_000) + ttlSeconds,
    document: snapshot,
  };
}

function pointerFromContent(
  content: FameLandingSnapshotContent,
): FameLandingSnapshotPointer {
  return {
    ...currentFameLandingSnapshotKey(),
    recordKind: "fame-landing-snapshot-pointer-v1",
    snapshotId: content.snapshotId,
    safeBlockNumber: content.safeBlockNumber,
    safeBlockHash: content.safeBlockHash,
    sourceRegistryId: content.sourceRegistryId,
    routeAuthorityRevision: content.routeAuthorityRevision,
    schemaVersion: content.schemaVersion,
    capturedAt: content.capturedAt,
    publishedAt: content.publishedAt,
  };
}

function contentMatches(
  existing: Record<string, unknown>,
  expected: FameLandingSnapshotContent,
  authority: FameLandingAuthority,
): boolean {
  try {
    const document = parseFameLandingSnapshot(existing.document, authority);
    return (
      existing.recordKind === expected.recordKind &&
      existing.pk === expected.pk &&
      existing.sk === expected.sk &&
      existing.snapshotId === expected.snapshotId &&
      existing.safeBlockNumber === expected.safeBlockNumber &&
      existing.safeBlockHash === expected.safeBlockHash &&
      existing.sourceRegistryId === expected.sourceRegistryId &&
      existing.routeAuthorityRevision === expected.routeAuthorityRevision &&
      existing.schemaVersion === expected.schemaVersion &&
      JSON.stringify(document) === JSON.stringify(expected.document)
    );
  } catch {
    return false;
  }
}

export async function publishFameLandingSnapshot({
  db = defaultDb,
  tableName,
  snapshot: inputSnapshot,
  authority = fameLandingAuthority,
  publishedAt = new Date(),
  ttlSeconds = FAME_LANDING_SNAPSHOT_CONTENT_TTL_SECONDS,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  snapshot: FameLandingSnapshot;
  authority?: FameLandingAuthority;
  publishedAt?: Date;
  ttlSeconds?: number;
}): Promise<PublishFameLandingSnapshotResult> {
  const snapshot = parseFameLandingSnapshot(inputSnapshot, authority);
  const content = contentFromSnapshot({ snapshot, publishedAt, ttlSeconds });
  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: content,
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    const existing = await db.send(
      new GetCommand({
        TableName: tableName,
        Key: landingSnapshotContentKey(snapshot.provenance.snapshotId),
        ConsistentRead: true,
      }),
    );
    if (!existing.Item || !contentMatches(existing.Item, content, authority)) {
      storageError("immutable snapshot id already contains different content");
    }
  }

  const pointer = pointerFromContent(content);
  try {
    await db.send(
      new PutCommand({
        TableName: tableName,
        Item: pointer,
        ConditionExpression:
          "attribute_not_exists(pk) OR safeBlockNumber < :safeBlockNumber OR (safeBlockNumber = :safeBlockNumber AND capturedAt < :capturedAt) OR snapshotId = :snapshotId",
        ExpressionAttributeValues: {
          ":safeBlockNumber": pointer.safeBlockNumber,
          ":capturedAt": pointer.capturedAt,
          ":snapshotId": pointer.snapshotId,
        },
      }),
    );
    return "advanced";
  } catch (error) {
    if (isConditionalCheckFailed(error)) return "ignored";
    throw error;
  }
}

function parsePointer(value: unknown): FameLandingSnapshotPointer {
  const item = record(value, "landing snapshot pointer");
  if (
    item.pk !== LANDING_SNAPSHOT_PK ||
    item.sk !== "current" ||
    item.recordKind !== "fame-landing-snapshot-pointer-v1" ||
    item.schemaVersion !== FAME_LANDING_SNAPSHOT_SCHEMA_VERSION ||
    "expiresAt" in item
  ) {
    storageError("landing snapshot pointer is malformed");
  }
  return {
    pk: LANDING_SNAPSHOT_PK,
    sk: "current",
    recordKind: "fame-landing-snapshot-pointer-v1",
    snapshotId: requiredString(item, "snapshotId", "pointer"),
    safeBlockNumber: requiredInteger(item, "safeBlockNumber", "pointer"),
    safeBlockHash: requiredString(item, "safeBlockHash", "pointer"),
    sourceRegistryId: requiredString(item, "sourceRegistryId", "pointer"),
    routeAuthorityRevision: requiredString(
      item,
      "routeAuthorityRevision",
      "pointer",
    ),
    schemaVersion: FAME_LANDING_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: requiredString(item, "capturedAt", "pointer"),
    publishedAt: requiredString(item, "publishedAt", "pointer"),
  };
}

export async function getCurrentFameLandingSnapshot({
  db = defaultDb,
  tableName,
  authority = fameLandingAuthority,
}: {
  db?: PoolStateDocumentClient;
  tableName: string;
  authority?: FameLandingAuthority;
}): Promise<FameLandingSnapshot | null> {
  const pointerResponse = await db.send(
    new GetCommand({
      TableName: tableName,
      Key: currentFameLandingSnapshotKey(),
      ConsistentRead: true,
    }),
  );
  if (!pointerResponse.Item) return null;
  const pointer = parsePointer(pointerResponse.Item);
  const contentResponse = await db.send(
    new GetCommand({
      TableName: tableName,
      Key: landingSnapshotContentKey(pointer.snapshotId),
      ConsistentRead: true,
    }),
  );
  if (!contentResponse.Item) {
    storageError("pointer-selected immutable content is missing");
  }
  const content = record(
    contentResponse.Item,
    "pointer-selected landing snapshot content",
  );
  const snapshot = parseFameLandingSnapshot(content.document, authority);
  if (
    content.recordKind !== "fame-landing-snapshot-content-v1" ||
    content.pk !== LANDING_SNAPSHOT_PK ||
    content.sk !== `snapshot:${pointer.snapshotId}` ||
    content.snapshotId !== pointer.snapshotId ||
    content.safeBlockNumber !== pointer.safeBlockNumber ||
    content.safeBlockHash !== pointer.safeBlockHash ||
    content.sourceRegistryId !== pointer.sourceRegistryId ||
    content.routeAuthorityRevision !== pointer.routeAuthorityRevision ||
    content.schemaVersion !== pointer.schemaVersion ||
    snapshot.provenance.snapshotId !== pointer.snapshotId ||
    snapshot.provenance.safeBlockNumber !== pointer.safeBlockNumber ||
    snapshot.provenance.safeBlockHash !== pointer.safeBlockHash ||
    snapshot.provenance.sourceRegistryId !== pointer.sourceRegistryId ||
    snapshot.provenance.routeAuthorityRevision !==
      pointer.routeAuthorityRevision
  ) {
    storageError("landing snapshot pointer and content disagree");
  }
  return snapshot;
}
