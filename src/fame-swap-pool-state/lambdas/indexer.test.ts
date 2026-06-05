import { describe, expect, jest, test } from "@jest/globals";
import type { FamePoolStateIndexerResult } from "../indexer.ts";

function parseLogLine(line: unknown): Record<string, unknown> {
  if (typeof line !== "string") throw new Error("Expected a log string.");
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object log line.");
  }
  return parsed as Record<string, unknown>;
}

async function loadIndexerModule(): Promise<typeof import("./indexer.ts")> {
  jest.resetModules();
  process.env.FAME_POOL_STATE_TABLE_NAME = "PoolState";
  return import("./indexer.ts");
}

function indexerResult(
  overrides: Partial<FamePoolStateIndexerResult> = {},
): FamePoolStateIndexerResult {
  return {
    chainId: 8453,
    durationMs: 100,
    fromBlock: 100,
    observedThroughBlock: 120,
    syncEvents: 0,
    writtenEvents: 0,
    ignoredEvents: 0,
    seededPools: 0,
    reconciledPools: 0,
    observedPools: 0,
    clHeadSnapshots: 0,
    clHeadWrittenPools: 0,
    clHeadFailedPools: 0,
    clHeadFailures: [],
    clReplaySnapshots: 0,
    clReplayWrittenPools: 0,
    clReplayFailedPools: 0,
    clReplayFailures: [],
    clReplayMetrics: [],
    v4ClReplaySnapshots: 0,
    v4ClReplayWrittenPools: 0,
    v4ClReplayFailedPools: 0,
    v4ClReplayFailures: [],
    v4ClReplayMetrics: [],
    clReplayMaintenanceMetrics: [],
    sourceRegistryId: "registry",
    ...overrides,
  };
}

describe("FAME pool-state indexer Lambda", () => {
  test("sanitizes top-level indexer crashes before rethrowing", async () => {
    const { handleFamePoolStateIndexer } = await loadIndexerModule();
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });
    const providerError = new Error(
      'HTTP request failed. URL: https://base.example/super-secret-token Request body: {"method":"eth_getLogs"}',
    );
    providerError.name = "HttpRequestError";
    Object.defineProperty(providerError, "statusCode", {
      value: 429,
    });

    try {
      await expect(
        handleFamePoolStateIndexer({
          tableName: "PoolState",
          confirmationBlocks: 2,
          indexPools: async () => {
            throw providerError;
          },
        }),
      ).rejects.toThrow("FAME pool-state indexer failed");

      expect(errorLog).toHaveBeenCalledTimes(1);
      const line = errorLog.mock.calls[0]?.[0];
      expect(line).not.toContain("super-secret-token");
      expect(line).not.toContain("eth_getLogs");
      expect(parseLogLine(line)).toMatchObject({
        level: "error",
        event: "fame-pool-state-indexed",
        errorType: "indexer-crash",
        errorClass: "HttpRequestError",
        statusCode: 429,
      });
    } finally {
      errorLog.mockRestore();
    }
  });

  test("rejects when V4 replay snapshots fail after logging the result", async () => {
    const { handleFamePoolStateIndexer } = await loadIndexerModule();
    const errorLog = jest.spyOn(console, "error").mockImplementation(() => {
      return undefined;
    });

    try {
      await expect(
        handleFamePoolStateIndexer({
          tableName: "PoolState",
          confirmationBlocks: 2,
          indexPools: async () =>
            indexerResult({
              v4ClReplayFailedPools: 1,
              v4ClReplayFailures: [
                {
                  poolId: "uniswap-v4-basedflick-zora",
                  message: "StateView read failed",
                },
              ],
            }),
        }),
      ).rejects.toThrow("StateView read failed");

      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(parseLogLine(errorLog.mock.calls[0]?.[0])).toMatchObject({
        level: "error",
        event: "fame-pool-state-indexed",
        v4ClReplayFailedPools: 1,
        v4ClReplayFailures: [
          {
            poolId: "uniswap-v4-basedflick-zora",
            message: "StateView read failed",
          },
        ],
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});
