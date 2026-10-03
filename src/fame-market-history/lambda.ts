import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { runHistory } from "./runtime.ts";

export async function handler(
  _event: unknown,
  context: { getRemainingTimeInMillis(): number },
) {
  try {
    const name = process.env.FAME_HISTORY_RPC_PARAMETER;
    if (!name) throw new Error("Missing RPC parameter");
    const response = await new SSMClient({ maxAttempts: 2 }).send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    if (!response.Parameter?.Value) throw new Error("Missing RPC URL");
    const result = await runHistory(
      { ...process.env, FAME_HISTORY_RPC_URL: response.Parameter.Value },
      {
        dryRun: false,
        deadline:
          Date.now() +
          Math.min(240_000, context.getRemainingTimeInMillis() - 15000),
      },
    );
    console.log(
      JSON.stringify({
        event: "fame-history-collected",
        ...result,
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "Society/FameMarketHistory",
              Dimensions: [[]],
              Metrics: [
                { Name: "CoverageLagBlocks", Unit: "Count" },
                { Name: "RpcRequests", Unit: "Count" },
                { Name: "ResponseBytes", Unit: "Bytes" },
              ],
            },
          ],
        },
        CoverageLagBlocks: result.coverageLagBlocks,
        RpcRequests: result.metrics.requests,
        ResponseBytes: result.metrics.responseBytes,
      }),
    );
    return result;
  } catch {
    console.error(
      JSON.stringify({
        event: "fame-history-failed",
        message:
          "Collection stopped. Inspect budget and last committed coverage; provider details suppressed.",
      }),
    );
    throw new Error("FAME history collection failed");
  }
}
