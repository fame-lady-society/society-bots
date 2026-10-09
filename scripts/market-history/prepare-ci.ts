import { appendFile } from "node:fs/promises";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { historyRpcParameter } from "./ci-config.ts";
import { historyStart, START_PARAMETER } from "./start-marker.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";

// Manual CI deployment only. Credentials never enter outputs or synthesized templates.
const ssm = new SSMClient({ maxAttempts: 2 });
try {
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) throw new Error("CI environment file required");
  const input = historyRpcParameter(
    process.env.FAME_POOL_STATE_INDEXER_BASE_RPCS_JSON,
    process.env.FAME_HISTORY_RPC_PARAMETER,
  );
  await ssm.send(new PutParameterCommand(input));
  const start = await historyStart(ssm, async () => {
    const rpc = boundedTransport({
      url: input.Value,
      maxRequests: 4,
      maxResponseBytes: 256 * 1024,
      deadline: Date.now() + 30_000,
    });
    return chainReader(
      historyScope(famePoolStateRegistry),
      rpc.transport,
      1,
    ).finalized();
  });
  await appendFile(envFile, `FAME_HISTORY_START_BLOCK=${start.block.number}\n`);
  console.log(
    JSON.stringify({
      event: "history-deployment-start",
      parameter: START_PARAMETER,
      ...start,
    }),
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### FAME history start\n\nBase block **${start.block.number}** (${new Date(start.block.timestamp * 1000).toISOString()}).\n\nHash: \`${start.block.hash}\`. Saved in \`${START_PARAMETER}\`; reused on subsequent deployments.\n`,
    );
} catch {
  console.error(
    "History deployment preparation failed; existing start markers were not overwritten. Secret details suppressed.",
  );
  process.exitCode = 1;
} finally {
  ssm.destroy();
}
