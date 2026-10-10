import { servingRevision } from "./revision.ts";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { dataset, decodeDataset, datasetKey } from "./dataset.ts";
import { digest, hash, integer, type Cursor, type Header } from "./model.ts";
import { activeScopeKey, sampledKey, progressKey } from "./keys.ts";
import { cursorKey } from "./storage.ts";
import { sampledPolicy } from "./sampled-market.ts";
import { expansionPools } from "./scope-expansion.ts";
import {
  validateSampledPublication,
  type SampledPublication,
} from "./sampled-live.ts";

export interface ExpansionJob {
  version: "fame-scope-expansion-v1";
  tableArn: string;
  bucket: string;
  source: ReturnType<typeof dataset>;
  target: ReturnType<typeof dataset>;
  startBlock: number;
  sampleStart: number;
  anchor: Header;
}
export const expansionKey = (scopeId: string) => ({
  pk: `expansion:${scopeId}`,
  sk: "job",
});
export function validateExpansion(job: ExpansionJob) {
  if (
    job.version !== "fame-scope-expansion-v1" ||
    !/^arn:aws:dynamodb:[a-z0-9-]+:\d{12}:table\/[A-Za-z0-9_.-]+$/.test(
      job.tableArn,
    ) ||
    !job.bucket
  )
    throw new Error("Invalid expansion resource identity");
  const source = decodeDataset(job.source),
    target = decodeDataset(job.target);
  const added = expansionPools(source.scope, target.scope);
  for (const p of source.scope.pools) {
    if (
      [p.token0, p.token1].some(
        (token) =>
          source.metadata.decimals[token] !== target.metadata.decimals[token],
      )
    )
      throw new Error("Expansion changed existing token precision");
  }
  integer(job.startBlock, "expansion start", 1);
  integer(job.sampleStart, "expansion sample start");
  integer(job.anchor.number, "expansion anchor", 1);
  integer(job.anchor.timestamp, "expansion anchor time");
  hash(job.anchor.hash);
  hash(job.anchor.parentHash);
  if (
    job.sampleStart % 300 ||
    job.anchor.timestamp >= job.sampleStart + 300 ||
    job.anchor.number !== job.startBlock
  )
    throw new Error("Invalid expansion sampling boundary");
  return { source, target, added, jobId: digest(JSON.stringify(job)) };
}
export async function getRow(
  db: DynamoDBDocumentClient,
  table: string,
  Key: { pk: string; sk: string },
) {
  return (
    await db.send(
      new GetCommand({ TableName: table, Key, ConsistentRead: true }),
    )
  ).Item;
}
export function rawCursor(row: Record<string, unknown> | undefined): Cursor {
  if (!row) throw new Error("Missing committed raw cursor");
  return {
    startBlock: integer(row.startBlock, "raw start", 1),
    nextBlock: integer(row.nextBlock, "raw next", 1),
    previousHash: hash(row.previousHash),
  };
}
/** Register before deploying the definition-aware lambdas. This enriches the
 * immutable definitions without selecting the new scope or touching live progress. */
export async function registerExpansion(
  db: DynamoDBDocumentClient,
  table: string,
  job: ExpansionJob,
) {
  const { jobId, source, target } = validateExpansion(job);
  const prior = await getRow(db, table, expansionKey(target.scope.id));
  if (prior) {
    if (prior.jobId !== jobId)
      throw new Error("Target scope belongs to another expansion job");
    return;
  }
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: table,
            Key: activeScopeKey,
            ConditionExpression: "scopeId = :source",
            ExpressionAttributeValues: { ":source": job.source.scopeId },
          },
        },
        {
          ConditionCheck: {
            TableName: table,
            Key: cursorKey(source.scope.id),
            ConditionExpression: "startBlock = :start",
            ExpressionAttributeValues: { ":start": job.startBlock },
          },
        },
        {
          ConditionCheck: {
            TableName: table,
            Key: progressKey(source.scope.id),
            ConditionExpression: "metadataRevision = :revision",
            ExpressionAttributeValues: {
              ":revision": servingRevision(source.scope, source.metadata),
            },
          },
        },
        ...[job.source, job.target].map((d) => ({
          Put: {
            TableName: table,
            Item: { ...datasetKey(d.scopeId), ...d },
            ConditionExpression:
              "attribute_not_exists(pk) OR definitionHash = :hash",
            ExpressionAttributeValues: { ":hash": d.definitionHash },
          },
        })),
        {
          ConditionCheck: {
            TableName: table,
            Key: cursorKey(job.target.scopeId),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          ConditionCheck: {
            TableName: table,
            Key: sampledKey(sampledPolicy(target.scope).revision, "collected"),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: table,
            Item: {
              ...expansionKey(job.target.scopeId),
              jobId,
              body: JSON.stringify(job),
              status: "staging",
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    }),
  );
}

export interface HandoffProof {
  sourceCursor: Cursor;
  targetCursor: Cursor;
  sourcePublication: SampledPublication;
  targetPublication: SampledPublication;
  sampledNext: number;
  aggregatedNext: number;
}
export function validateHandoff(job: ExpansionJob, proof: HandoffProof) {
  const { source, target } = validateExpansion(job);
  const s = proof.sourceCursor,
    t = proof.targetCursor;
  if (
    s.startBlock !== job.startBlock ||
    t.startBlock !== s.startBlock ||
    t.nextBlock !== s.nextBlock ||
    t.previousHash !== s.previousHash ||
    !s.previousHash
  )
    throw new Error(
      "Expanded raw archive must exactly catch the live cursor before handoff",
    );
  if (proof.aggregatedNext !== t.nextBlock)
    throw new Error("Expanded aggregation must catch raw coverage");
  const sourcePublication = validateSampledPublication(
    proof.sourcePublication,
    sampledPolicy(source.scope).revision,
  );
  const targetPublication = validateSampledPublication(
    proof.targetPublication,
    sampledPolicy(target.scope).revision,
  );
  if (
    targetPublication.pages.length !== 288 ||
    targetPublication.nextTimestamp < sourcePublication.nextTimestamp ||
    proof.sampledNext < targetPublication.nextTimestamp
  )
    throw new Error(
      "Expanded publication must have a full day and reach the live publication",
    );
}
/** Caller verifies every target page + activity sidecar before invoking this.
 * Changed cursors/generations abort the switch; rerun verification to retry. */
export async function activateExpansion(
  db: DynamoDBDocumentClient,
  table: string,
  job: ExpansionJob,
  proof: HandoffProof,
) {
  validateHandoff(job, proof);
  const { source, target, jobId } = validateExpansion(job);
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: table,
            Item: { ...activeScopeKey, scopeId: job.target.scopeId },
            ConditionExpression: "scopeId = :source",
            ExpressionAttributeValues: { ":source": job.source.scopeId },
          },
        },
        ...[job.source, job.target].map((d) => ({
          ConditionCheck: {
            TableName: table,
            Key: datasetKey(d.scopeId),
            ConditionExpression: "definitionHash = :hash",
            ExpressionAttributeValues: { ":hash": d.definitionHash },
          },
        })),
        ...(
          [
            [source.scope.id, proof.sourceCursor],
            [target.scope.id, proof.targetCursor],
          ] as const
        ).map(([id, c]) => ({
          ConditionCheck: {
            TableName: table,
            Key: cursorKey(id),
            ConditionExpression:
              "startBlock = :start AND nextBlock = :next AND previousHash = :hash",
            ExpressionAttributeValues: {
              ":start": c.startBlock,
              ":next": c.nextBlock,
              ":hash": c.previousHash,
            },
          },
        })),
        ...(
          [
            [source.scope, proof.sourcePublication],
            [target.scope, proof.targetPublication],
          ] as const
        ).map(([scope, p]) => ({
          ConditionCheck: {
            TableName: table,
            Key: sampledKey(sampledPolicy(scope).revision, "published"),
            ConditionExpression: "generation = :generation",
            ExpressionAttributeValues: { ":generation": p.generation },
          },
        })),
        {
          ConditionCheck: {
            TableName: table,
            Key: sampledKey(sampledPolicy(target.scope).revision, "collected"),
            ConditionExpression: "nextTimestamp = :next",
            ExpressionAttributeValues: { ":next": proof.sampledNext },
          },
        },
        {
          ConditionCheck: {
            TableName: table,
            Key: progressKey(target.scope.id),
            ConditionExpression: "nextBlock = :next",
            ExpressionAttributeValues: { ":next": proof.aggregatedNext },
          },
        },
        {
          Update: {
            TableName: table,
            Key: expansionKey(target.scope.id),
            UpdateExpression: "SET #status = :active",
            ConditionExpression: "jobId = :id AND #status = :staging",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":id": jobId,
              ":staging": "staging",
              ":active": "active",
            },
          },
        },
      ],
    }),
  );
}
