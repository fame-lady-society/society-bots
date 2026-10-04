import type { CollectResult } from "./collector.ts";
import type { RpcMetrics } from "./rpc.ts";

/** Best-effort operational telemetry, never a billing ledger or work gate. */
export function telemetry(
  event: string,
  values: Record<string, number>,
  details: Record<string, unknown> = {},
) {
  return {
    event,
    ...details,
    ...values,
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: "Society/FameMarketHistory",
          Dimensions: [[]],
          Metrics: Object.keys(values).map((Name) => ({
            Name,
            Unit: Name.endsWith("Bytes") ? "Bytes" : "Count",
          })),
        },
      ],
    },
  };
}

export function collectorTelemetry(
  metrics: RpcMetrics,
  result?: CollectResult,
  code?: string,
) {
  return telemetry(
    "fame-history-attempt",
    {
      RpcRequests: metrics.requests,
      ResponseBytes: metrics.responseBytes,
      RpcGetLogsRequests: metrics.methods.eth_getLogs ?? 0,
      RpcHeaderRequests: metrics.methods.eth_getBlockByNumber ?? 0,
      RpcChainIdRequests: metrics.methods.eth_chainId ?? 0,
      CollectionFailures: result ? 0 : 1,
      CollectionYields: result?.yieldReason ? 1 : 0,
      CollectionProgressBlocks:
        result?.status === "archived"
          ? result.toBlock - result.fromBlock + 1
          : 0,
      ...(result ? { CoverageLagBlocks: result.coverageLagBlocks } : {}),
    },
    { metrics, ...(result ? { result } : { code }) },
  );
}
