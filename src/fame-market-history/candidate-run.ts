/** One explicitly started, frozen catch-up run. No production promotion. */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { candidatePlan, candidateChunks, candidateHash } from "./candidate.ts";
import { candidateStore } from "./candidate-storage.ts";
import { digest } from "./model.ts";
export const candidateRunKey = { pk: "candidate:full-v1", sk: "run" };
export const latestCompletedDay = (now: number) =>
  Math.floor(now / 86400000) * 86400;
const planHash = (to: number) =>
  digest(JSON.stringify(candidatePlan(to).map(candidateHash)));
export function candidateRun(
  db: DynamoDBDocumentClient,
  table: string,
  now = Date.now,
) {
  const read = async () => {
    const row = (
      await db.send(
        new GetCommand({
          TableName: table,
          Key: candidateRunKey,
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (
      row &&
      (row.planHash !== planHash(row.to) ||
        !["running", "paused"].includes(row.desired))
    )
      throw new Error("Candidate run plan changed");
    return row;
  };
  return {
    read,
    status: async () => {
      const run = await read();
      if (!run) return { state: "not-started" };
      const chunks = candidatePlan(run.to);
      for (let i = 0; i < chunks.length; i++) {
        const store = candidateStore(db, table, now, chunks[i]);
        if (!(await store.read())?.completed)
          return {
            ...run,
            completedChunks: i,
            totalChunks: chunks.length,
            currentChunk: chunks[i],
            progress: await store.status(),
          };
      }
      return {
        ...run,
        state: "complete",
        completedChunks: chunks.length,
        totalChunks: chunks.length,
      };
    },
    control: async (command: "start" | "pause" | "resume") => {
      if (command === "start") {
        if (await read()) return read();
        const previous = await candidateStore(
          db,
          table,
          now,
          "october-30d-v1",
        ).read();
        if (!previous?.completed || previous.leaseOwner)
          throw new Error("October must be complete and unleased");
        const to = latestCompletedDay(now());
        try {
          await db.send(
            new PutCommand({
              TableName: table,
              Item: {
                ...candidateRunKey,
                to,
                planHash: planHash(to),
                createdAt: now(),
                desired: "running",
              },
              ConditionExpression: "attribute_not_exists(pk)",
            }),
          );
        } catch (e) {
          if (!(await read())) throw e;
        }
      } else {
        const run = await read();
        if (!run) throw new Error("Start the candidate run first");
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: candidateRunKey,
            UpdateExpression: "SET desired = :d",
            ConditionExpression: "planHash = :h",
            ExpressionAttributeValues: {
              ":d": command === "pause" ? "paused" : "running",
              ":h": run.planHash,
            },
          }),
        );
      }
      return read();
    },
    select: async () => {
      const run = await read();
      if (run?.desired === "paused") return undefined;
      const chunks = run ? candidatePlan(run.to) : candidateChunks;
      for (const chunk of chunks) {
        const store = candidateStore(db, table, now, chunk),
          job = await store.read();
        if (job?.completed) continue;
        if (!job && run && chunk.startsWith("catchup-"))
          await store.control("start");
        return chunk;
      }
      return undefined;
    },
  };
}
