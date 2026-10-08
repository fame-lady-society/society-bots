/** Read-only reproduction against the configured production provider. No checkpoint writes. */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { historyScope } from "../../src/fame-market-history/model.ts";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { sampledPolicy } from "../../src/fame-market-history/sampled-market.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { referenceBoundary } from "../../src/fame-market-history/reference-collector.ts";
import { RangeLimit, WorkLimit } from "../../src/fame-market-history/limits.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
import {
  sampledReader,
  deriveSampledObservation,
} from "../../src/fame-market-history/sampled-rpc.ts";
const scope = historyScope(famePoolStateRegistry);
let stage = "configuration",
  requestedBlock: number | string | null = null;
try {
  const table = process.env.FAME_HISTORY_TABLE;
  if (!table) throw Error("Missing table");
  const db = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 1 }),
  );
  const { Item: cursor } = await db.send(
    new GetCommand({
      TableName: table,
      Key: { pk: `sampled:${sampledPolicy(scope).revision}`, sk: "collected" },
      ConsistentRead: true,
    }),
  );
  if (!cursor) throw Error("Missing cursor");
  const ssm = new SSMClient({ maxAttempts: 1 });
  const { Parameter } = await ssm.send(
    new GetParameterCommand({
      Name: "/society-bots/market-history/base-rpc",
      WithDecryption: true,
    }),
  );
  if (!Parameter?.Value) throw Error("Missing RPC");
  const rpc = boundedTransport({
    url: Parameter.Value,
    maxRequests: 40,
    maxResponseBytes: 256 * 1024,
    deadline: Date.now() + 90000,
  });
  const chain = chainReader(scope, rpc.transport, 1);
  stage = "finalized-header";
  requestedBlock = "finalized";
  const head = await chain.finalized();
  stage = "anchor";
  requestedBlock = cursor.anchor.number;
  const anchor = await chain.header(cursor.anchor.number);
  console.log(
    JSON.stringify({
      stage,
      head,
      anchorMatches: anchor.hash === cursor.anchor.hash,
      nextTimestamp: cursor.nextTimestamp,
    }),
  );
  if (anchor.hash !== cursor.anchor.hash)
    throw new Error("Sampled anchor hash changed");
  stage = "boundary";
  try {
    const boundary = await referenceBoundary(
      cursor.nextTimestamp,
      anchor,
      head,
      async (n) => {
        requestedBlock = n;
        const h = await chain.header(n);
        console.log(
          JSON.stringify({
            stage: "header",
            number: h.number,
            timestamp: h.timestamp,
          }),
        );
        return h;
      },
    );
    console.log(JSON.stringify({ stage, boundary, metrics: rpc.metrics }));
    stage = "sample";
    const evidence = await sampledReader(scope, rpc.transport)(
      cursor.nextTimestamp,
      boundary.block,
      boundary.after,
    );
    const observation = deriveSampledObservation(scope, evidence);
    console.log(
      JSON.stringify({
        stage,
        timestamp: observation.timestamp,
        availableRates: Object.values(observation.rates).filter(Boolean).length,
        metrics: rpc.metrics,
        awsWrites: 0,
      }),
    );
  } catch (error) {
    process.exitCode = 1;
    let cause: unknown = error;
    const reasons: string[] = [];
    const seen = new Set<unknown>();
    while (cause instanceof Error && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof RangeLimit || cause instanceof WorkLimit)
        reasons.push(cause.message);
      else if (
        [
          "Nonmonotonic reference headers",
          "Reference canonical boundary changed",
          "Reference search not bracketed",
        ].includes(cause.message)
      )
        reasons.push(cause.message);
      cause = "cause" in cause ? cause.cause : undefined;
    }
    console.log(
      JSON.stringify({
        stage,
        requestedBlock,
        code: failureCode(error),
        reasons,
        metrics: rpc.metrics,
      }),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({ stage, requestedBlock, code: failureCode(error) }),
  );
  process.exitCode = 1;
}
