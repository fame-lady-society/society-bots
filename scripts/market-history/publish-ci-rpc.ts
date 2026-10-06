import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { historyRpcParameter } from "./ci-config.ts";

// CI deployment only. Never called by rehearsal; the URL stays out of templates.
try {
  const input = historyRpcParameter(
    process.env.FAME_POOL_STATE_INDEXER_BASE_RPCS_JSON,
    process.env.FAME_HISTORY_RPC_PARAMETER,
  );
  await new SSMClient({ maxAttempts: 2 }).send(new PutParameterCommand(input));
  console.log("History RPC SecureString synchronized.");
} catch {
  console.error(
    "History RPC parameter publication failed; secret details suppressed.",
  );
  process.exitCode = 1;
}
