/** Operator-run backward refill. Uses the deployed stack and never changes live cursors. */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { fameHistoryRegistry } from "../../src/fame-market-history/registry.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { referenceReader } from "../../src/fame-market-history/reference-rpc.ts";
import {
  referenceProgress,
  referenceProgressKey,
  referencePolicy,
} from "../../src/fame-market-history/reference.ts";
import { awsReferenceRefill } from "../../src/fame-market-history/reference-refill-storage.ts";
import { refillReferences } from "../../src/fame-market-history/reference-refill.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      "max-buckets": { type: "string", default: "12" },
      apply: { type: "boolean", default: false },
    },
  });
  const from = Number(values.from),
    maxBuckets = Number(values["max-buckets"]);
  if (
    !Number.isSafeInteger(from) ||
    from <= 0 ||
    from % 300 ||
    !Number.isSafeInteger(maxBuckets) ||
    maxBuckets < 1 ||
    maxBuckets > 288
  )
    throw Error("Use aligned --from and --max-buckets 1..288");
  const region = "us-west-1";
  const aws = (...args: string[]) =>
    JSON.parse(
      execFileSync("aws", [...args, "--region", region, "--output", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  if (aws("sts", "get-caller-identity").Account !== "590183914614")
    throw Error("Unexpected AWS account");
  const stack = aws(
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    "FameMarketHistory",
  ).Stacks[0];
  const output = (name: string): string => {
    const matches = stack.Outputs.filter((o: { OutputKey: string }) =>
      new RegExp(`^History${name}[A-F0-9]{8}$`).test(o.OutputKey),
    );
    if (matches.length !== 1) throw Error("Missing deployed history resources");
    return matches[0].OutputValue;
  };
  const table = output("TableName"),
    bucket = output("BucketName");
  const scope = historyScope(fameHistoryRegistry),
    policy = referencePolicy(scope);
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region, maxAttempts: 2 }),
  );
  const s3 = new S3Client({ region, maxAttempts: 2 });
  const ssm = new SSMClient({ region, maxAttempts: 2 });
  try {
    const live = referenceProgress(
      (
        await db.send(
          new GetCommand({
            TableName: table,
            Key: referenceProgressKey(scope.id, "collected"),
            ConsistentRead: true,
          }),
        )
      ).Item,
      policy.revision,
    );
    if (
      !live ||
      from >= live.startTimestamp ||
      live.startTimestamp - from > 86400
    )
      throw Error(
        "Refill must cover at most 24 hours preceding live activation",
      );
    console.log(
      JSON.stringify({
        event: "reference-refill-plan",
        scope: scope.id,
        from,
        to: live.startTimestamp,
        buckets: (live.startTimestamp - from) / 300,
        maxBuckets,
        apply: values.apply,
      }),
    );
    if (!values.apply) return;
    const url = (
      await ssm.send(
        new GetParameterCommand({
          Name: "/society-bots/market-history/base-rpc",
          WithDecryption: true,
        }),
      )
    ).Parameter?.Value;
    if (!url) throw Error("Missing history RPC parameter");
    const rpc = boundedTransport({
      url,
      maxRequests: 6000,
      maxResponseBytes: 4 * 1024 * 1024,
      maxTotalResponseBytes: 512 * 1024 * 1024,
      deadline: Date.now() + 30 * 60 * 1000,
    });
    const chain = chainReader(scope, rpc.transport, 1),
      upper = await chain.finalized();
    const store = awsReferenceRefill({ scope, table, bucket, db, s3 });
    await store.initialize({
      targetFrom: from,
      toTimestamp: live.startTimestamp,
      nextTimestamp: live.startTimestamp,
      policyRevision: policy.revision,
      upper,
    });
    let count = 0;
    const result = await refillReferences({
      scope,
      store,
      chain,
      sample: referenceReader(scope, rpc.transport),
      maxBuckets,
      onBucket: (e) => {
        count++;
        if (count === 1 || count % 12 === 0)
          console.log(
            JSON.stringify({
              event: "reference-refill-progress",
              published: count,
              timestamp: e.timestamp,
              rpc: rpc.metrics,
            }),
          );
      },
    });
    console.log(
      JSON.stringify({
        event: "reference-refill-result",
        ...result,
        rpc: rpc.metrics,
      }),
    );
  } finally {
    db.destroy();
    s3.destroy();
    ssm.destroy();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      event: "reference-refill-failed",
      code: failureCode(error),
      name: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exitCode = 1;
});
