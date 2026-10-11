/** Operator control of the dedicated stack only. No arbitrary table override. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { candidateStore } from "../../src/fame-market-history/candidate-storage.ts";
import {
  candidateChunks,
  type CandidateChunk,
} from "../../src/fame-market-history/candidate.ts";
const [command, profile, query] = process.argv.slice(2);
if (
  !["start", "pause", "resume", "status", "query"].includes(command) ||
  !profile ||
  (command === "query"
    ? process.argv.length !== 5
    : process.argv.length < 4 ||
      process.argv.length > 5 ||
      (query !== undefined &&
        !candidateChunks.includes(query as CandidateChunk)))
)
  throw new Error(
    "Usage: candidate-control.ts start|pause|resume|status <AWS profile> [launch-30d-v1|august-30d-v1|september-30d-v1]; query <AWS profile> <query string>",
  );
const aws = (args: string[]) =>
  JSON.parse(
    execFileSync(
      "aws",
      [
        ...args,
        "--profile",
        profile,
        "--region",
        "us-west-1",
        "--output",
        "json",
      ],
      { encoding: "utf8" },
    ),
  );
if (aws(["sts", "get-caller-identity"]).Account !== "590183914614")
  throw new Error("Wrong AWS account");
const stacks = aws([
  "cloudformation",
  "describe-stacks",
  "--stack-name",
  "FameHistoryCandidate",
]).Stacks;
const table = stacks[0]?.Outputs?.find(
  (o: any) => o.OutputKey === "TableName",
)?.OutputValue;
if (!table) throw new Error("Deploy the candidate stack first");
// Honor the same profile used for discovery. Do not accept ambient service endpoints.
if (process.env.AWS_ENDPOINT_URL || process.env.AWS_ENDPOINT_URL_DYNAMODB)
  throw new Error("Unexpected AWS endpoint override");
const credentials = aws([
  "configure",
  "export-credentials",
  "--format",
  "process",
]);
const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: "us-west-1",
    maxAttempts: 2,
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
  }),
);
const store = candidateStore(
  db,
  table,
  Date.now,
  (command === "query" ? undefined : query) as CandidateChunk | undefined,
);
if (command === "query") {
  const reader = stacks[0].Outputs.find(
    (o: any) => o.OutputKey === "ReaderName",
  )?.OutputValue;
  if (!reader) throw new Error("Missing candidate reader");
  const dir = await mkdtemp(path.join(tmpdir(), "candidate-query-"));
  try {
    const file = path.join(dir, "response.json");
    const result = aws([
      "lambda",
      "invoke",
      "--function-name",
      reader,
      "--cli-binary-format",
      "raw-in-base64-out",
      "--payload",
      JSON.stringify({
        rawQueryString: query,
        requestContext: { http: { method: "GET" } },
      }),
      file,
    ]);
    if (result.FunctionError)
      throw new Error("Candidate reader invocation failed");
    const response = JSON.parse(await readFile(file, "utf8"));
    console.log(JSON.stringify(response));
    if (response.statusCode !== 200) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} else {
  if (command !== "status")
    await store.control(command as "start" | "pause" | "resume");
  console.log(JSON.stringify(await store.status(), null, 2));
}
