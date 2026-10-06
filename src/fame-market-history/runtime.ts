import { famePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { collect } from "./collector.ts";
import { historyScope, integer } from "./model.ts";
import { boundedTransport, chainReader } from "./rpc.ts";
import { awsArchive } from "./storage.ts";
import { failureCode } from "./failure.ts";
import { valuationReader } from "./valuation-rpc.ts";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
export function configuration(env: NodeJS.ProcessEnv, dryRun = false) {
  const numeric = (name: string, fallback?: number) =>
    integer(Number(env[name] ?? fallback), name, 1);
  return {
    rpcUrl: required(env, "FAME_HISTORY_RPC_URL"),
    table: dryRun
      ? (env.FAME_HISTORY_TABLE ?? "")
      : required(env, "FAME_HISTORY_TABLE"),
    bucket: dryRun ? "" : required(env, "FAME_HISTORY_BUCKET"),
    poolStateTable: required(env, "FAME_HISTORY_POOL_STATE_TABLE"),
    startBlock: numeric("FAME_HISTORY_START_BLOCK"),
    maxRequests: numeric("FAME_HISTORY_MAX_REQUESTS", 256),
    maxBlocks: numeric("FAME_HISTORY_MAX_BLOCKS", 500),
    maxEvents: numeric("FAME_HISTORY_MAX_EVENTS", 5000),
    maxResponseBytes: numeric(
      "FAME_HISTORY_MAX_RESPONSE_BYTES",
      4 * 1024 * 1024,
    ),
  };
}

export async function runHistory(
  env: NodeJS.ProcessEnv,
  { dryRun, deadline }: { dryRun: boolean; deadline: number },
) {
  const config = configuration(env, dryRun);
  const scope = historyScope(famePoolStateRegistry);
  const rpc = boundedTransport({
    url: config.rpcUrl,
    maxRequests: config.maxRequests,
    maxResponseBytes: config.maxResponseBytes,
    deadline,
  });
  const chain = chainReader(scope, rpc.transport, config.maxEvents, {
    remainingRequests: () => rpc.capacity.remainingRequests() - 2,
    canScan: () =>
      rpc.capacity.canScan() && rpc.capacity.remainingRequests() > 5,
  });
  const store = awsArchive(config);
  chain.valuation = valuationReader(scope, rpc.transport);
  // Rehearse before creating any history resources. Existing history can be read
  // explicitly, otherwise the supplied start block is the dry-run boundary.
  if (dryRun && !config.table)
    store.cursor = async (_scope, startBlock) => ({
      startBlock,
      nextBlock: startBlock,
      previousHash: null,
    });
  try {
    const result = await collect({
      chain,
      store,
      scope,
      startBlock: config.startBlock,
      maxBlocks: config.maxBlocks,
      maxEvents: config.maxEvents,
      dryRun,
    });
    return {
      ...result,
      metrics: rpc.metrics,
      scopePools: scope.pools.map((p) => p.id),
    };
  } catch (error) {
    // Preserve cost evidence on failed runs without emitting SDK messages/URLs.
    console.error(
      JSON.stringify({
        event: "fame-history-attempt-failed",
        code: failureCode(error),
        scopeId: scope.id,
        metrics: rpc.metrics,
      }),
    );
    throw new Error(
      "History collection failed; inspect diagnostic logs and last committed range",
    );
  }
}
