import { describe, expect, test } from "@jest/globals";
import { buildFameDeltaReplaySmokeReport } from "./fame-pool-state-delta-replay-smoke.ts";

describe("FAME delta replay smoke report", () => {
  test("summarizes maintenance, provider pressure, and quote fallback evidence", () => {
    const report = buildFameDeltaReplaySmokeReport({
      indexer: {
        sourceRegistryId: "pool-state-registry-v3:unit",
        observedThroughBlock: 123,
        clReplaySnapshots: 1,
        clReplayMetrics: [
          {
            poolId: "slipstream-usdc-weth-100",
            bitmapWordCount: 2,
            initializedTickCount: 3,
            bitmapChunkCount: 1,
            tickChunkCount: 1,
            providerReadCount: 75,
            durationMs: 42,
            stateHash:
              "0x1111111111111111111111111111111111111111111111111111111111111111",
          },
        ],
        clReplayMaintenanceMetrics: [
          {
            poolId: "slipstream-usdc-weth-100",
            status: "warming",
            reason: "shadow-not-promoted",
            fromBlock: 120,
            toBlock: 123,
            scannedLogCount: 2,
            appliedEventCount: 2,
            candidateWritten: true,
            stateHash:
              "0x2222222222222222222222222222222222222222222222222222222222222222",
          },
        ],
      },
      quoteResponse: {
        sourceRegistryId: "pool-state-registry-v3:unit",
        currentBlock: 123,
        producerMaxFreshnessBlocks: 120,
        effectiveMaxFreshnessBlocks: 120,
        quotes: [
          {
            status: "unavailable",
            requested: {
              poolId: "slipstream-usdc-weth-100",
              tokenIn: "0x0000000000000000000000000000000000000001",
              tokenOut: "0x0000000000000000000000000000000000000002",
              amountIn: "1000",
            },
            reason: "producer-untrusted",
            poolId: "slipstream-usdc-weth-100",
          },
        ],
      },
    });

    expect(report).toEqual({
      sourceRegistryId: "pool-state-registry-v3:unit",
      observedThroughBlock: 123,
      replaySnapshotCount: 1,
      providerReadCount: 75,
      maintenance: [
        {
          poolId: "slipstream-usdc-weth-100",
          status: "warming",
          reason: "shadow-not-promoted",
          fromBlock: 120,
          toBlock: 123,
          scannedLogCount: 2,
          appliedEventCount: 2,
          candidateWritten: true,
          stateHash:
            "0x2222222222222222222222222222222222222222222222222222222222222222",
        },
      ],
      quote: {
        quoted: 0,
        unavailable: 1,
        unavailableReasons: {
          "producer-untrusted": 1,
        },
      },
    });
    expect(JSON.stringify(report)).not.toContain("https://");
    expect(JSON.stringify(report)).not.toContain("Bearer");
    expect(JSON.stringify(report)).not.toContain("eth_getLogs");
  });
});
