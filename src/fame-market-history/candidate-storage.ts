import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  candidateScope,
  candidateJobKey,
  candidateChunks,
  type CandidateChunk,
  candidateHash,
  candidateSpec,
  validateCandidateBounds,
  type CandidateBounds,
} from "./candidate.ts";
import { dataset, datasetKey, decodeDataset, closeHistory } from "./dataset.ts";
import { activeScopeKey, progressKey, sampledKey } from "./keys.ts";
import { cursorKey } from "./storage.ts";
import type { TokenMetadata } from "./decode.ts";
import type { RpcMetrics } from "./rpc.ts";
export const CANDIDATE_LEASE_MS = 360_000; // Longer than the deployed 300s Lambda timeout.
const conditional = (e: unknown) =>
  e instanceof Error && e.name === "ConditionalCheckFailedException";
export function candidateStore(
  db: DynamoDBDocumentClient,
  table: string,
  now = Date.now,
  chunk: CandidateChunk = "launch-30d-v1",
) {
  const candidateKey = candidateJobKey(chunk),
    spec = candidateSpec(chunk);
  const get = async (Key: Record<string, string>) =>
    (
      await db.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  const read = async () => {
    const row = await get(candidateKey);
    if (
      row &&
      (row.specHash !== candidateHash(chunk) ||
        row.spec !== JSON.stringify(spec) ||
        (chunk !== "launch-30d-v1" &&
          row.predecessor !==
            candidateChunks[candidateChunks.indexOf(chunk) - 1]) ||
        !["running", "paused"].includes(row.desired) ||
        typeof row.completed !== "boolean")
    )
      throw new Error(
        "Candidate specification changed; use a reviewed new chunk",
      );
    return row;
  };
  return {
    read,
    control: async (command: "start" | "pause" | "resume") => {
      if (command === "start") {
        // A retried start cannot reset progress or resume a paused job.
        if (await read()) return read();
        const item = {
          ...candidateKey,
          spec: JSON.stringify(spec),
          specHash: candidateHash(chunk),
          desired: "running",
          completed: false,
          createdAt: now(),
        };
        if (chunk !== "launch-30d-v1") {
          const previousChunk =
            candidateChunks[candidateChunks.indexOf(chunk) - 1];
          const previous = await candidateStore(
            db,
            table,
            now,
            previousChunk,
          ).read();
          if (!previous?.completed || previous.leaseOwner || !previous.bounds)
            throw new Error(
              "Previous candidate chunk must be complete and unleased",
            );
          validateCandidateBounds(previous.bounds, previousChunk);
          const source = candidateSpec(previousChunk);
          const nextBlock = previous.bounds.end.number + 1;
          const checks = [
            {
              Key: candidateJobKey(previousChunk),
              ConditionExpression:
                "completed = :done AND specHash = :hash AND attribute_not_exists(leaseOwner)",
              ExpressionAttributeValues: {
                ":done": true,
                ":hash": candidateHash(previousChunk),
              },
            },
            {
              Key: cursorKey(source.scopeId),
              ConditionExpression: "nextBlock = :block AND startBlock = :start",
              ExpressionAttributeValues: {
                ":block": nextBlock,
                ":start":
                  previous.bounds.captureStart?.number ?? source.startBlock,
              },
            },
            {
              Key: progressKey(source.scopeId),
              ConditionExpression: "nextBlock = :block",
              ExpressionAttributeValues: { ":block": nextBlock },
            },
            ...["collected", "published"].map((kind) => ({
              Key: sampledKey(
                source.policyRevision,
                kind as "collected" | "published",
              ),
              ConditionExpression: "nextTimestamp = :time",
              ExpressionAttributeValues: { ":time": spec.from },
            })),
            {
              Key: activeScopeKey,
              ConditionExpression: "scopeId = :scope",
              ExpressionAttributeValues: { ":scope": source.scopeId },
            },
          ];
          try {
            await db.send(
              new TransactWriteCommand({
                TransactItems: [
                  ...checks.map((check) => ({
                    ConditionCheck: { TableName: table, ...check },
                  })),
                  {
                    Put: {
                      TableName: table,
                      Item: { ...item, predecessor: previousChunk },
                      ConditionExpression: "attribute_not_exists(pk)",
                    },
                  },
                ],
              }),
            );
          } catch (e) {
            // Lost response or competing identical starts are idempotent only if
            // the exact immutable job now exists. Other transaction errors surface.
            if (!(await read())) {
              if (
                e instanceof Error &&
                e.name === "TransactionCanceledException"
              )
                throw new Error(
                  "Candidate continuation requires completed predecessor, matching active scope and aligned raw/Parquet/sample/publication checkpoints",
                  { cause: e },
                );
              throw e;
            }
          }
          return read();
        }
        try {
          await db.send(
            new PutCommand({
              TableName: table,
              Item: item,
              ConditionExpression: "attribute_not_exists(pk)",
            }),
          );
        } catch (e) {
          if (!conditional(e)) throw e;
          await read();
        } // Idempotent start never resets progress or resumes a paused job.
      } else
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: candidateKey,
            UpdateExpression: "SET desired = :desired",
            ConditionExpression: "specHash = :spec AND completed = :false",
            ExpressionAttributeValues: {
              ":desired": command === "pause" ? "paused" : "running",
              ":spec": candidateHash(chunk),
              ":false": false,
            },
          }),
        );
      return read();
    },
    acquire: async (owner: string) => {
      try {
        const r = await db.send(
          new UpdateCommand({
            TableName: table,
            Key: candidateKey,
            UpdateExpression: "SET leaseOwner = :owner, leaseUntil = :until",
            ConditionExpression:
              "specHash = :spec AND desired = :running AND completed = :false AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)",
            ExpressionAttributeValues: {
              ":owner": owner,
              ":until": now() + CANDIDATE_LEASE_MS,
              ":now": now(),
              ":spec": candidateHash(chunk),
              ":running": "running",
              ":false": false,
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        return r.Attributes!;
      } catch (e) {
        if (conditional(e)) {
          await read();
          return null;
        }
        throw e;
      }
    },
    canContinue: async (owner: string) => {
      const r = await read();
      return (
        r?.desired === "running" &&
        r.leaseOwner === owner &&
        r.leaseUntil > now()
      );
    },
    initialize: async (
      owner: string,
      bounds: CandidateBounds,
      metadata: TokenMetadata,
    ) => {
      validateCandidateBounds(bounds, chunk);
      const scope = candidateScope(chunk);
      const source =
        chunk === "october-30d-v1"
          ? await get(datasetKey(candidateSpec("september-30d-v1").scopeId))
          : null;
      const history = source
        ? closeHistory(decodeDataset(source), spec.from)
        : [];
      if (chunk === "october-30d-v1") {
        const previous = await candidateStore(
          db,
          table,
          now,
          "september-30d-v1",
        ).read();
        if (
          !source ||
          !previous?.completed ||
          !(["number", "hash", "parentHash", "timestamp"] as const).every(
            (k) => bounds.captureStart?.[k] === previous.bounds?.endBefore?.[k],
          )
        )
          throw new Error("Admission boundary does not match retained history");
      }
      if (chunk === "november-30d-v1") {
        const previous = await candidateStore(
          db,
          table,
          now,
          "october-30d-v1",
        ).read();
        if (
          !previous?.completed ||
          previous.leaseOwner ||
          !(["number", "hash", "parentHash", "timestamp"] as const).every(
            (k) =>
              bounds.captureStart?.[k] === previous.bounds?.captureStart?.[k],
          )
        )
          throw new Error("Continuation dataset boundary changed");
      }
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: table,
                Key: candidateKey,
                UpdateExpression: "SET bounds = :bounds",
                ConditionExpression:
                  "leaseOwner = :owner AND leaseUntil > :now AND attribute_not_exists(bounds)",
                ExpressionAttributeValues: {
                  ":owner": owner,
                  ":now": now(),
                  ":bounds": bounds,
                },
              },
            },
            ...(chunk === "launch-30d-v1"
              ? [
                  {
                    Put: {
                      TableName: table,
                      Item: { ...activeScopeKey, scopeId: scope.id },
                      ConditionExpression: "attribute_not_exists(pk)",
                    },
                  },
                ]
              : []),
            ...(["launch-30d-v1", "october-30d-v1"].includes(chunk)
              ? [
                  {
                    Put: {
                      TableName: table,
                      Item: {
                        ...datasetKey(scope.id),
                        ...dataset(scope, metadata, history),
                      },
                      ConditionExpression: "attribute_not_exists(pk)",
                    },
                  },
                ]
              : []),
          ],
        }),
      );
    },
    activateOctober: async (owner: string) => {
      if (chunk !== "october-30d-v1") throw new Error("Not an admission job");
      const source = candidateSpec("september-30d-v1");
      const previous = await candidateStore(
        db,
        table,
        now,
        "september-30d-v1",
      ).read();
      if (!previous?.completed || !previous.bounds)
        throw new Error("Missing completed predecessor");
      validateCandidateBounds(previous.bounds, "september-30d-v1");
      const nextBlock = previous.bounds.end.number + 1;
      const job = await read();
      if (
        !job?.bounds?.captureStart ||
        job.bounds.captureStart.hash !== previous.bounds.endBefore.hash
      )
        throw new Error("Missing admission capture boundary");
      const definition = await get(datasetKey(spec.scopeId));
      if (!definition || decodeDataset(definition).scope.id !== spec.scopeId)
        throw new Error("Missing staged dataset definition");
      const expectedHistory = closeHistory(
        decodeDataset((await get(datasetKey(source.scopeId)))!),
        spec.from,
      );
      if (
        JSON.stringify(decodeDataset(definition).history) !==
        JSON.stringify(expectedHistory)
      )
        throw new Error("Admission history lineage mismatch");
      const opening = await get(
        sampledKey(spec.policyRevision, `observation:${spec.from - 300}`),
      );
      if (!opening?.sha256)
        throw new Error("Missing admission opening observation");
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: datasetKey(spec.scopeId),
                ConditionExpression: "definitionHash = :hash",
                ExpressionAttributeValues: {
                  ":hash": definition.definitionHash,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: table,
                Key: candidateKey,
                ConditionExpression:
                  "leaseOwner = :owner AND leaseUntil > :now AND desired = :running AND specHash = :hash AND attribute_exists(bounds)",
                ExpressionAttributeValues: {
                  ":owner": owner,
                  ":now": now(),
                  ":running": "running",
                  ":hash": candidateHash(chunk),
                },
              },
            },
            {
              ConditionCheck: {
                TableName: table,
                Key: candidateJobKey("september-30d-v1"),
                ConditionExpression:
                  "completed = :yes AND specHash = :hash AND attribute_not_exists(leaseOwner)",
                ExpressionAttributeValues: {
                  ":yes": true,
                  ":hash": candidateHash("september-30d-v1"),
                },
              },
            },
            ...[source].flatMap((s) => [
              {
                ConditionCheck: {
                  TableName: table,
                  Key: cursorKey(s.scopeId),
                  ConditionExpression: "nextBlock = :next",
                  ExpressionAttributeValues: { ":next": nextBlock },
                },
              },
              {
                ConditionCheck: {
                  TableName: table,
                  Key: progressKey(s.scopeId),
                  ConditionExpression: "nextBlock = :next",
                  ExpressionAttributeValues: { ":next": nextBlock },
                },
              },
              ...(["collected", "published"] as const).map((kind) => ({
                ConditionCheck: {
                  TableName: table,
                  Key: sampledKey(s.policyRevision, kind),
                  ConditionExpression: "nextTimestamp = :next",
                  ExpressionAttributeValues: { ":next": spec.from },
                },
              })),
            ]),
            {
              ConditionCheck: {
                TableName: table,
                Key: sampledKey(spec.policyRevision, "collected"),
                ConditionExpression:
                  "startTimestamp = :start AND nextTimestamp = :start AND anchor.#hash = :hash",
                ExpressionAttributeNames: { "#hash": "hash" },
                ExpressionAttributeValues: {
                  ":start": spec.from,
                  ":hash": job.bounds.captureStart.hash,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: table,
                Key: sampledKey(
                  spec.policyRevision,
                  `observation:${spec.from - 300}`,
                ),
                ConditionExpression: "sha256 = :sha",
                ExpressionAttributeValues: { ":sha": opening.sha256 },
              },
            },
            ...[
              cursorKey(spec.scopeId),
              progressKey(spec.scopeId),
              sampledKey(spec.policyRevision, "published"),
            ].map((Key) => ({
              ConditionCheck: {
                TableName: table,
                Key,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            })),
            {
              Update: {
                TableName: table,
                Key: activeScopeKey,
                UpdateExpression: "SET scopeId = :target",
                ConditionExpression: "scopeId = :source",
                ExpressionAttributeValues: {
                  ":source": source.scopeId,
                  ":target": spec.scopeId,
                },
              },
            },
          ],
        }),
      );
    },
    finish: async (
      owner: string,
      result: Record<string, unknown>,
      metrics: RpcMetrics,
    ) => {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: candidateKey,
          UpdateExpression:
            "SET lastResult = :result, lastRunAt = :now, lastMetrics = :metrics, completed = :done REMOVE leaseOwner, leaseUntil ADD measuredRequests :requests, measuredResponseBytes :bytes",
          ConditionExpression: "leaseOwner = :owner",
          ExpressionAttributeValues: {
            ":owner": owner,
            ":now": now(),
            ":result": result,
            ":metrics": metrics,
            ":done": result.phase === "complete",
            ":requests": metrics.requests,
            ":bytes": metrics.responseBytes,
          },
        }),
      );
    },
    status: async () => {
      const job = await read();
      if (!job) return { state: "not-started", spec };
      const s = spec;
      const [raw, aggregation, collected, published] = await Promise.all([
        get(cursorKey(s.scopeId)),
        get(progressKey(s.scopeId)),
        get(sampledKey(s.policyRevision, "collected")),
        get(sampledKey(s.policyRevision, "published")),
      ]);
      return {
        job,
        rawNextBlock:
          raw?.nextBlock ?? job.bounds?.captureStart?.number ?? s.startBlock,
        parquetNextBlock:
          aggregation?.nextBlock ??
          job.bounds?.captureStart?.number ??
          s.startBlock,
        sampleNextTimestamp: collected?.nextTimestamp ?? s.from,
        publishedNextTimestamp: published?.nextTimestamp ?? s.from,
        leaseActive: !!job.leaseOwner && job.leaseUntil > now(),
      };
    },
    aggregationNext: async () =>
      (await get(progressKey(spec.scopeId)))?.nextBlock ??
      (await read())?.bounds?.captureStart?.number ??
      spec.startBlock,
  };
}
