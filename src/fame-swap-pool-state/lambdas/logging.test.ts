import { describe, expect, jest, test } from "@jest/globals";
import type { Address, Hex } from "viem";
import type {
  FamePoolStateBatchResponse,
  FamePoolStateResponseEntry,
} from "../api.ts";
import type { FamePoolStateIndexerResult } from "../indexer.ts";
import {
  logPoolStateApiBatch,
  logPoolStateIndexerResult,
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
    sourceRegistryId: "registry",
    ...overrides,
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
});
