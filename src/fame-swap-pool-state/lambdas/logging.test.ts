import { describe, expect, jest, test } from "@jest/globals";
import type { Address, Hex } from "viem";
import type {
  FamePoolStateBatchResponse,
  FamePoolStateResponseEntry,
} from "../api.ts";
import type { FamePoolQuoteBatchResponse } from "../cl-quote.ts";
import type { FamePoolStateIndexerResult } from "../indexer.ts";
import { FAME_V4_ZORA_QUOTE_LANE_POOL_ID } from "../v4-zora-manifests.ts";
import {
  logPoolStateApiBatch,
  logPoolStateIndexerResult,
  poolQuoteApiBatchLogFields,
  poolStateApiBatchLogFields,
  shouldLogPoolStateApiBatch,
  writePoolStateLog,
} from "./logging.ts";

const ADDRESS_A = "0x0000000000000000000000000000000000000001" as Address;
const ADDRESS_B = "0x0000000000000000000000000000000000000002" as Address;
const HEX_32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

function parseLogLine(line: unknown): Record<string, unknown> {
  if (typeof line !== "string") throw new Error("Expected a log string.");
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object log line.");
  }
  return parsed as Record<string, unknown>;
}

function freshReservePool(): FamePoolStateResponseEntry {
  return {
    status: "fresh",
    poolId: "constant-product-pool",
    chainId: 8453,
    poolAddress: ADDRESS_A,
    token0: ADDRESS_A,
    token1: ADDRESS_B,
    reserve0: "100",
    reserve1: "200",
    k: "20000",
    observedThroughBlock: 120,
    lastReserveChangeBlock: 119,
    source: "getReserves",
    quoteModel: "constant-product-reserves",
    maxFreshnessBlocks: 120,
  };
}

function freshReplayPool(): FamePoolStateResponseEntry {
  return {
    status: "fresh",
    stateKind: "cl-replay-v1",
    poolId: "slipstream-usdc-weth-100",
    chainId: 8453,
    poolAddress: ADDRESS_A,
    token0: ADDRESS_A,
    token1: ADDRESS_B,
    venueFamily: "Slipstream",
    tickSpacing: 1,
    sqrtPriceX96: "100",
    tick: 1,
    liquidity: "1000",
    fee: "100",
    feeSource: "pool-fee",
    observedThroughBlock: 120,
    blockHash: HEX_32,
    parentHash: HEX_32,
    snapshotId: "cl-replay-v1:slipstream-usdc-weth-100:120",
    stateHash: HEX_32,
    source: "slipstream-pool-state",
    sourceRegistryId: "registry",
    maxFreshnessBlocks: 120,
    bitmapWordCount: 2,
    initializedTickCount: 3,
    bitmapChunkCount: 1,
    tickChunkCount: 1,
    minWordPosition: -1,
    maxWordPosition: 1,
    minTick: -100,
    maxTick: 100,
    bitmapWords: [
      {
        wordPosition: 0,
        bitmap: HEX_32,
      },
    ],
    initializedTicks: [
      {
        tick: -100,
        liquidityGross: "1",
        liquidityNet: "1",
      },
    ],
  };
}

function freshV4ReplayPool(): FamePoolStateResponseEntry {
  return {
    status: "fresh",
    stateKind: "v4-cl-replay-v1",
    poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
    chainId: 8453,
    poolKey: HEX_32,
    stateViewAddress: ADDRESS_A,
    token0: ADDRESS_A,
    token1: ADDRESS_B,
    venueFamily: "UniswapV4",
    tickSpacing: 200,
    sqrtPriceX96: "100",
    tick: 1,
    liquidity: "1000",
    lpFee: "30000",
    protocolFee: "0",
    feeSource: "v4-slot0",
    observedThroughBlock: 120,
    blockHash: HEX_32,
    parentHash: HEX_32,
    snapshotId: "v4-cl-replay-v1:uniswap-v4-basedflick-zora:120",
    stateHash: HEX_32,
    source: "uniswap-v4-state-view",
    reviewedPoolEvidence: {
      status: "verified",
      source: "reviewed-v4-manifest",
      kind: "zora-protocol-pool",
      manifestVersion: 1,
      poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
      poolKey: HEX_32,
      staticFee: "30000",
      hookAddress: ADDRESS_A,
      hookData: "0x" as Hex,
      protocolFeeStatus: "zero",
    },
    zoraProvenance: {
      status: "verified",
      source: "zora-factory-event",
      chainId: 8453,
      factoryAddress: ADDRESS_A,
      coinAddress: ADDRESS_B,
      poolKey: HEX_32,
      poolId: HEX_32,
      transactionHash: HEX_32,
      eventName: "CoinCreatedV4",
    },
    sourceRegistryId: "registry",
    maxFreshnessBlocks: 120,
    bitmapWordCount: 4,
    initializedTickCount: 5,
    bitmapChunkCount: 2,
    tickChunkCount: 3,
    minWordPosition: -1,
    maxWordPosition: 1,
    minTick: -200,
    maxTick: 200,
    bitmapWords: [
      {
        wordPosition: 0,
        bitmap: HEX_32,
      },
    ],
    initializedTicks: [
      {
        tick: -200,
        liquidityGross: "1",
        liquidityNet: "1",
      },
    ],
  };
}

function batchResponse(
  pools: FamePoolStateResponseEntry[],
): FamePoolStateBatchResponse {
  return {
    sourceRegistryId: "registry",
    currentBlock: 121,
    producerMaxFreshnessBlocks: 120,
    effectiveMaxFreshnessBlocks: 120,
    pools,
  };
}

function indexerResult(
  overrides: Partial<FamePoolStateIndexerResult> = {},
): FamePoolStateIndexerResult {
  return {
    chainId: 8453,
    durationMs: 100,
    fromBlock: 100,
    observedThroughBlock: 120,
    syncEvents: 1,
    writtenEvents: 1,
    ignoredEvents: 0,
    seededPools: 0,
    reconciledPools: 1,
    observedPools: 1,
    clHeadSnapshots: 1,
    clHeadWrittenPools: 1,
    clHeadFailedPools: 0,
    clHeadFailures: [],
    clReplaySnapshots: 1,
    clReplayWrittenPools: 1,
    clReplayFailedPools: 0,
    clReplayFailures: [],
    clReplayMetrics: [],
    v4ClReplaySnapshots: 0,
    v4ClReplayWrittenPools: 0,
    v4ClReplayFailedPools: 0,
    v4ClReplayFailures: [],
    v4ClReplayMetrics: [],
    v4ClReplayMaintenanceMetrics: [],
    clReplayMaintenanceMetrics: [],
    sourceRegistryId: "registry",
    ...overrides,
  };
}

function quoteBatchResponse(): FamePoolQuoteBatchResponse {
  return {
    sourceRegistryId: "registry",
    currentBlock: 121,
    producerMaxFreshnessBlocks: 120,
    effectiveMaxFreshnessBlocks: 120,
    quotes: [
      {
        status: "unavailable",
        requested: {
          poolId: "slipstream-basedflick-fame",
          tokenIn: ADDRESS_A,
          tokenOut: ADDRESS_B,
          amountIn: "1000",
        },
        reason: "producer-untrusted",
        poolId: "slipstream-basedflick-fame",
        chainId: 8453,
        poolAddress: ADDRESS_A,
        observedThroughBlock: 120,
        sourceRegistryId: "registry",
        maxFreshnessBlocks: 120,
        producerStatus: "warming",
        producerReason: "shadow-not-promoted",
      },
    ],
  };
}

describe("FAME pool-state Lambda logging", () => {
  test("writes structured log envelopes with level, event, and timestamp", () => {
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      writePoolStateLog("info", "fame-pool-state-api-batch", {
        sourceRegistryId: "registry",
        batchSize: 1,
      });

      expect(infoLog).toHaveBeenCalledTimes(1);
      const entry = parseLogLine(infoLog.mock.calls[0]?.[0]);
      expect(entry).toMatchObject({
        level: "info",
        event: "fame-pool-state-api-batch",
        sourceRegistryId: "registry",
        batchSize: 1,
      });
      expect(typeof entry.timestamp).toBe("string");
    } finally {
      infoLog.mockRestore();
    }
  });

  test("keeps envelope fields authoritative over payload fields", () => {
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      writePoolStateLog("info", "fame-pool-state-api-batch", {
        level: "error",
        event: "fame-pool-state-api-error",
        timestamp: "1970-01-01T00:00:00.000Z",
      });

      expect(infoLog).toHaveBeenCalledTimes(1);
      const entry = parseLogLine(infoLog.mock.calls[0]?.[0]);
      expect(entry).toMatchObject({
        level: "info",
        event: "fame-pool-state-api-batch",
      });
      expect(entry.timestamp).not.toBe("1970-01-01T00:00:00.000Z");
    } finally {
      infoLog.mockRestore();
    }
  });

  test("skips ordinary all-fresh non-replay API success logs", () => {
    const response = batchResponse([freshReservePool()]);
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      expect(shouldLogPoolStateApiBatch(response)).toBe(false);
      logPoolStateApiBatch(response);
      expect(infoLog).not.toHaveBeenCalled();
    } finally {
      infoLog.mockRestore();
    }
  });

  test("summarizes fresh replay API responses without raw tick payloads", () => {
    const response = batchResponse([freshReplayPool()]);
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      expect(shouldLogPoolStateApiBatch(response)).toBe(true);
      expect(poolStateApiBatchLogFields(response)).toMatchObject({
        clReplay: {
          returned: 1,
          fresh: 1,
          stale: 0,
          bitmapWordCount: 2,
          initializedTickCount: 3,
        },
      });

      logPoolStateApiBatch(response);

      expect(infoLog).toHaveBeenCalledTimes(1);
      const line = infoLog.mock.calls[0]?.[0];
      expect(line).not.toContain("bitmapWords");
      expect(line).not.toContain("initializedTicks");
      expect(parseLogLine(line)).toMatchObject({
        level: "info",
        event: "fame-pool-state-api-batch",
        statusCounts: {
          fresh: 1,
        },
      });
    } finally {
      infoLog.mockRestore();
    }
  });

  test("summarizes fresh V4 replay API responses without raw tick payloads", () => {
    const response = batchResponse([freshV4ReplayPool()]);
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      expect(shouldLogPoolStateApiBatch(response)).toBe(true);
      expect(poolStateApiBatchLogFields(response)).toMatchObject({
        v4ClReplay: {
          returned: 1,
          fresh: 1,
          stale: 0,
          bitmapWordCount: 4,
          initializedTickCount: 5,
        },
      });

      logPoolStateApiBatch(response);

      expect(infoLog).toHaveBeenCalledTimes(1);
      const line = infoLog.mock.calls[0]?.[0];
      expect(line).not.toContain("bitmapWords");
      expect(line).not.toContain("initializedTicks");
      expect(parseLogLine(line)).toMatchObject({
        level: "info",
        event: "fame-pool-state-api-batch",
        v4ClReplay: {
          returned: 1,
          fresh: 1,
          bitmapChunkCount: 2,
          tickChunkCount: 3,
        },
      });
    } finally {
      infoLog.mockRestore();
    }
  });

  test("keeps stale, unknown, and unsupported API responses visible", () => {
    const response = batchResponse([
      {
        status: "unsupported",
        poolId: "stable-pool",
        chainId: 8453,
        poolAddress: ADDRESS_A,
        unsupportedReason: "stable-pool",
      },
    ]);

    expect(shouldLogPoolStateApiBatch(response)).toBe(true);
    expect(poolStateApiBatchLogFields(response)).toMatchObject({
      statusCounts: {
        unsupported: 1,
      },
    });
  });

  test("logs indexer replay failures once at error level", () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      logPoolStateIndexerResult(
        indexerResult({
          clReplayFailedPools: 1,
          clReplayFailures: [
            {
              poolId: "slipstream-usdc-weth-100",
              message: "snapshot failed",
            },
          ],
        }),
      );

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(infoLog).not.toHaveBeenCalled();
      expect(parseLogLine(errorLog.mock.calls[0]?.[0])).toMatchObject({
        level: "error",
        event: "fame-pool-state-indexed",
        clReplayFailedPools: 1,
      });
    } finally {
      errorLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  test("summarizes selected candidate reducer metrics in indexer logs", () => {
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      logPoolStateIndexerResult(
        indexerResult({
          clReplayMetrics: [
            {
              poolId: "slipstream-basedflick-fame",
              bitmapWordCount: 4,
              initializedTickCount: 5,
              bitmapChunkCount: 2,
              tickChunkCount: 3,
              providerReadCount: 41,
              durationMs: 99,
              stateHash: HEX_32,
            },
          ],
          clReplayMaintenanceMetrics: [
            {
              poolId: "slipstream-basedflick-fame",
              status: "trusted",
              reason: null,
              fromBlock: 119,
              toBlock: 121,
              scannedLogCount: 7,
              appliedEventCount: 3,
              candidateWritten: true,
              stateHash: HEX_32,
            },
          ],
        }),
      );

      expect(infoLog).toHaveBeenCalledTimes(1);
      expect(parseLogLine(infoLog.mock.calls[0]?.[0])).toMatchObject({
        selectedClReplayCandidate: {
          poolId: "slipstream-basedflick-fame",
          providerReadCount: 41,
          bitmapWordCount: 4,
          initializedTickCount: 5,
          bitmapChunkCount: 2,
          tickChunkCount: 3,
          scannedLogCount: 7,
          appliedEventCount: 3,
          maintenanceStatus: "trusted",
          maintenanceReason: null,
          candidateWritten: true,
          stateHash: HEX_32,
        },
      });
    } finally {
      infoLog.mockRestore();
    }
  });

  test("logs V4 replay failures once at error level", () => {
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      logPoolStateIndexerResult(
        indexerResult({
          v4ClReplayFailedPools: 1,
          v4ClReplayFailures: [
            {
              poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
              message: "v4 snapshot failed",
            },
          ],
        }),
      );

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(infoLog).not.toHaveBeenCalled();
      expect(parseLogLine(errorLog.mock.calls[0]?.[0])).toMatchObject({
        level: "error",
        event: "fame-pool-state-indexed",
        v4ClReplayFailedPools: 1,
        v4ClReplayFailures: [
          {
            poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
            message: "v4 snapshot failed",
          },
        ],
      });
    } finally {
      errorLog.mockRestore();
      infoLog.mockRestore();
    }
  });

  test("summarizes selected V4 Zora replay metrics in indexer logs", () => {
    const infoLog = jest.spyOn(console, "log").mockImplementation(() => {
      return undefined;
    });

    try {
      logPoolStateIndexerResult(
        indexerResult({
          v4ClReplaySnapshots: 1,
          v4ClReplayWrittenPools: 1,
          v4ClReplayMetrics: [
            {
              poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
              bitmapWordCount: 4,
              initializedTickCount: 5,
              bitmapChunkCount: 2,
              tickChunkCount: 3,
              providerReadCount: 47,
              durationMs: 101,
              stateHash: HEX_32,
              lpFee: "30000",
              protocolFee: "0",
            },
          ],
        }),
      );

      expect(infoLog).toHaveBeenCalledTimes(1);
      const line = infoLog.mock.calls[0]?.[0];
      expect(line).not.toContain("bitmapWords");
      expect(line).not.toContain("initializedTicks");
      expect(parseLogLine(line)).toMatchObject({
        v4ClReplaySnapshots: 1,
        v4ClReplayWrittenPools: 1,
        selectedV4ZoraReplay: {
          poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
          providerReadCount: 47,
          bitmapWordCount: 4,
          initializedTickCount: 5,
          bitmapChunkCount: 2,
          tickChunkCount: 3,
          lpFee: "30000",
          protocolFee: "0",
          stateHash: HEX_32,
        },
      });
    } finally {
      infoLog.mockRestore();
    }
  });

  test("summarizes pool quote unavailable reasons without raw replay state", () => {
    expect(poolQuoteApiBatchLogFields(quoteBatchResponse())).toMatchObject({
      routeKind: "pool-quotes",
      statusCounts: {
        unavailable: 1,
      },
      reasonCounts: {
        "producer-untrusted": 1,
      },
      selectedClReplayCandidateQuote: {
        poolId: "slipstream-basedflick-fame",
        returned: 1,
        statusCounts: {
          unavailable: 1,
        },
        reasonCounts: {
          "producer-untrusted": 1,
        },
      },
    });
  });

  test("scopes selected candidate quote reasons within mixed batches", () => {
    const response = quoteBatchResponse();
    response.quotes.push({
      status: "unavailable",
      requested: {
        poolId: "uniswap-v4-basedflick-zora",
        tokenIn: ADDRESS_A,
        tokenOut: ADDRESS_B,
        amountIn: "1000",
      },
      reason: "unsupported-pool",
    });

    expect(poolQuoteApiBatchLogFields(response)).toMatchObject({
      statusCounts: {
        unavailable: 2,
      },
      reasonCounts: {
        "producer-untrusted": 1,
        "unsupported-pool": 1,
      },
      selectedClReplayCandidateQuote: {
        poolId: "slipstream-basedflick-fame",
        returned: 1,
        statusCounts: {
          unavailable: 1,
        },
        reasonCounts: {
          "producer-untrusted": 1,
        },
      },
      selectedV4ZoraQuote: {
        poolId: "uniswap-v4-basedflick-zora",
        returned: 1,
        statusCounts: {
          unavailable: 1,
        },
        reasonCounts: {
          "unsupported-pool": 1,
        },
      },
    });
  });
});
