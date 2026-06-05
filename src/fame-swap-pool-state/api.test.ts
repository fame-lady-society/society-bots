import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "@jest/globals";
import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { isAddress, type Address } from "viem";
import { handleFamePoolStateBatchRequest } from "./api.ts";
import { poolStateRequestAuthorized } from "./auth.ts";
import {
  handleFamePoolQuoteBatchRequest,
  type FamePoolQuoteRequest,
} from "./cl-quote.ts";
import {
  clReplayCandidateStateRowsFromSnapshot,
  clReplayStateRowsFromSnapshot,
  v4ClReplayStateRowsFromSnapshot,
  latestClHeadStateFromSnapshot,
  latestClReplayMaintenanceStateKey,
  latestPoolStateKey,
  latestStateFromReserves,
  sourceRegistryIdFor,
  type FameClHeadLatestState,
  type FameClHeadSnapshotRegistryEntry,
  type FameClReplayBitmapChunkState,
  type FameClReplayCandidateBitmapChunkState,
  type FameClReplayCandidateLatestState,
  type FameClReplayCandidateTickChunkState,
  type FameClReplayLatestState,
  type FameClReplayMaintenanceState,
  type FameClReplayRegistryEntry,
  type FameClReplayTickChunkState,
  type FameV4ClReplayBitmapChunkState,
  type FameV4ClReplayLatestState,
  type FameV4ClReplayRegistryEntry,
  type FameV4ClReplayTickChunkState,
  type FameV4ZoraVerifiedProvenance,
  type FamePoolLatestState,
  type PoolStateDocumentClient,
  type PoolStateDynamoResponse,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type { FamePoolStateRegistryEntry } from "./types.ts";

type SentCommand = Parameters<PoolStateDocumentClient["send"]>[0];

const ADDRESS_A = "0x0000000000000000000000000000000000000001" as Address;
const POOL_QUOTES_V1_FIXTURE_SHA256 =
  "1167e7daf16ed8c90c01b053dce24bb08579aef88a24a1ae1a756b290c34237d";

class BatchStateDb implements PoolStateDocumentClient {
  public readCount = 0;
  private readonly items = new Map<string, Record<string, unknown>>();

  constructor(
    states: readonly (
      | FameClHeadLatestState
      | FameClReplayBitmapChunkState
      | FameClReplayCandidateBitmapChunkState
      | FameClReplayCandidateLatestState
      | FameClReplayCandidateTickChunkState
      | FameClReplayLatestState
      | FameClReplayMaintenanceState
      | FameClReplayTickChunkState
      | FameV4ClReplayBitmapChunkState
      | FameV4ClReplayLatestState
      | FameV4ClReplayTickChunkState
      | FamePoolLatestState
    )[],
  ) {
    for (const state of states) {
      const record = recordFromState(state);
      this.items.set(keyFromRecord(record), record);
    }
  }

  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    if (!(command instanceof BatchGetCommand)) {
      throw new Error(`Unexpected command ${command.constructor.name}.`);
    }
    this.readCount += 1;
    const requestItems = parseObject(command.input.RequestItems);
    const responses: Record<string, Record<string, unknown>[]> = {};
    for (const [tableName, request] of Object.entries(requestItems)) {
      const keys = parseObject(request).Keys;
      if (!Array.isArray(keys)) {
        throw new Error("BatchGetCommand keys must be an array.");
      }
      responses[tableName] = keys
        .map((key) => this.items.get(keyFromRecord(parseObject(key))))
        .filter((item): item is Record<string, unknown> => item !== undefined);
    }
    return {
      Responses: responses,
    };
  }
}

class IncompleteBatchStateDb implements PoolStateDocumentClient {
  async send(command: SentCommand): Promise<PoolStateDynamoResponse> {
    if (command.constructor.name !== "BatchGetCommand") {
      throw new Error(`Unexpected command ${command.constructor.name}.`);
    }
    return {
      Responses: {
        PoolState: [],
      },
      UnprocessedKeys: {
        PoolState: {
          Keys: [
            {
              pk: "pool:8453:0x0000000000000000000000000000000000000001",
              sk: "latest",
            },
          ],
        },
      },
    };
  }
}

function recordFromState(
  state:
    | FameClHeadLatestState
    | FameClReplayBitmapChunkState
    | FameClReplayCandidateBitmapChunkState
    | FameClReplayCandidateLatestState
    | FameClReplayCandidateTickChunkState
    | FameClReplayLatestState
    | FameClReplayMaintenanceState
    | FameClReplayTickChunkState
    | FameV4ClReplayBitmapChunkState
    | FameV4ClReplayLatestState
    | FameV4ClReplayTickChunkState
    | FamePoolLatestState,
): Record<string, unknown> {
  return { ...state };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object.");
  }
  return value as Record<string, unknown>;
}

function keyFromRecord(record: Record<string, unknown>): string {
  const pk = record.pk;
  const sk = record.sk;
  if (typeof pk !== "string" || typeof sk !== "string") {
    throw new Error("Expected DynamoDB item key.");
  }
  return `${pk}\u0000${sk}`;
}

function quotePool(
  id: string,
): FamePoolStateRegistryEntry & { poolAddress: Address } {
  const entry = famePoolStateRegistry.pools.find((pool) => pool.id === id);
  if (!entry || entry.poolAddress === null) {
    throw new Error(`Missing quote pool ${id}.`);
  }
  return {
    ...entry,
    poolAddress: entry.poolAddress,
  };
}

function quoteModelPools(): (FamePoolStateRegistryEntry & {
  poolAddress: Address;
})[] {
  return famePoolStateRegistry.pools.filter(
    (pool): pool is FamePoolStateRegistryEntry & { poolAddress: Address } =>
      pool.capability === "quote-model" && pool.poolAddress !== null,
  );
}

function clHeadPool(id: string): FameClHeadSnapshotRegistryEntry {
  const entry = famePoolStateRegistry.pools.find((pool) => pool.id === id);
  if (
    !entry ||
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.tickSpacing === null
  ) {
    throw new Error(`Missing CL head pool ${id}.`);
  }
  return {
    ...entry,
    stateSurface: entry.stateSurface,
    tickSpacing: entry.tickSpacing,
  };
}

function clReplayPool(): FameClReplayRegistryEntry {
  const entry = famePoolStateRegistry.pools.find(
    (pool) => pool.id === "slipstream-usdc-weth-100",
  );
  if (
    !entry ||
    entry.replaySurface !== "cl-replay-v1" ||
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.poolAddress === null ||
    entry.tickSpacing === null ||
    entry.venue !== "aerodrome-slipstream"
  ) {
    throw new Error("Missing CL replay pool.");
  }
  return {
    ...entry,
    replaySurface: entry.replaySurface,
    stateSurface: entry.stateSurface,
    poolAddress: entry.poolAddress,
    tickSpacing: entry.tickSpacing,
    venue: entry.venue,
  };
}

function clReplayCandidatePool(): FameClReplayRegistryEntry {
  const entry = famePoolStateRegistry.pools.find(
    (pool) => pool.id === "slipstream-basedflick-fame",
  );
  if (
    !entry ||
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.poolAddress === null ||
    entry.tickSpacing === null ||
    entry.venue !== "aerodrome-slipstream"
  ) {
    throw new Error("Missing CL replay candidate pool.");
  }
  return {
    ...entry,
    activationStatus: "cl-replay-candidate",
    replaySurface: null,
    stateSurface: entry.stateSurface,
    poolAddress: entry.poolAddress,
    tickSpacing: entry.tickSpacing,
    venue: entry.venue,
  };
}

function v4ClReplayPool(): FameV4ClReplayRegistryEntry {
  const entry = famePoolStateRegistry.pools.find(
    (pool) => pool.id === "uniswap-v4-basedflick-zora",
  );
  if (
    !entry ||
    entry.venue !== "uniswap-v4" ||
    entry.venueFamily !== "UniswapV4" ||
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.poolAddress !== null ||
    entry.poolKey === null ||
    entry.stateViewAddress === null ||
    entry.tickSpacing === null
  ) {
    throw new Error("Missing V4 replay pool.");
  }
  return {
    ...entry,
    venue: entry.venue,
    venueFamily: entry.venueFamily,
    stateSurface: entry.stateSurface,
    poolAddress: entry.poolAddress,
    poolKey: entry.poolKey,
    stateViewAddress: entry.stateViewAddress,
    tickSpacing: entry.tickSpacing,
  };
}

function verifiedV4ZoraProvenance(
  pool: FameV4ClReplayRegistryEntry,
): FameV4ZoraVerifiedProvenance {
  return {
    status: "verified",
    source: "zora-factory-event",
    chainId: 8453,
    factoryAddress: "0x0000000000000000000000000000000000000003",
    coinAddress: pool.token1,
    poolKey: pool.poolKey,
    poolId: pool.poolKey,
    transactionHash:
      "0x7777777777777777777777777777777777777777777777777777777777777777",
    eventName: "CoinCreatedV4",
  };
}

function selectedActiveClReplayPool(): FameClReplayRegistryEntry {
  const entry = famePoolStateRegistry.pools.find(
    (pool) => pool.id === "slipstream-basedflick-fame",
  );
  if (
    !entry ||
    entry.activationStatus !== "cl-compact-quote-active" ||
    entry.replaySurface !== "cl-replay-v1" ||
    entry.stateSurface !== "cl-head-snapshot" ||
    entry.poolAddress === null ||
    entry.tickSpacing === null ||
    entry.venue !== "aerodrome-slipstream"
  ) {
    throw new Error("Missing active selected CL replay pool.");
  }
  return {
    ...entry,
    replaySurface: entry.replaySurface,
    stateSurface: entry.stateSurface,
    poolAddress: entry.poolAddress,
    tickSpacing: entry.tickSpacing,
    venue: entry.venue,
  };
}

function stateForPool(
  pool: FamePoolStateRegistryEntry & { poolAddress: Address },
  observedThroughBlock: number,
  options: {
    reserve0?: bigint;
    reserve1?: bigint;
    source?: FamePoolLatestState["source"];
    sourceRegistryId?: string;
  } = {},
): FamePoolLatestState {
  return latestStateFromReserves({
    pool,
    reserve0: options.reserve0 ?? 100n,
    reserve1: options.reserve1 ?? 250n,
    observedThroughBlock,
    version: {
      blockNumber: observedThroughBlock - 1,
      transactionIndex: 0,
      logIndex: 0,
    },
    transactionHash: null,
    source: options.source ?? "getReserves",
    sourceRegistryId: options.sourceRegistryId ?? "unit",
    updatedAt: "2026-05-17T00:00:00.000Z",
  });
}

function clHeadStateForPool(
  pool: FameClHeadSnapshotRegistryEntry,
  observedThroughBlock: number,
  sourceRegistryId = sourceRegistryIdFor(famePoolStateRegistry.source),
): FameClHeadLatestState {
  return latestClHeadStateFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: -11,
    liquidity: 555n,
    observedThroughBlock,
    source:
      pool.venue === "uniswap-v4" ? "v4-state-view" : "pool-slot0-liquidity",
    sourceRegistryId,
    updatedAt: "2026-05-19T00:00:00.000Z",
  });
}

function clReplayRowsForPool(pool: FameClReplayRegistryEntry) {
  return clReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: 199_900,
    liquidity: 1_000n,
    fee: 100n,
    observedThroughBlock: 120,
    blockHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    parentHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    snapshotId: "unit-cl-replay",
    stateHash:
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
    updatedAt: "2026-05-20T00:00:00.000Z",
    bitmapWords: [
      { wordPosition: 7, bitmap: 1n },
      { wordPosition: 8, bitmap: 2n },
    ],
    initializedTicks: [
      { tick: 199_900, liquidityGross: 25n, liquidityNet: 15n },
      { tick: 200_000, liquidityGross: 50n, liquidityNet: -15n },
    ],
    bitmapChunkSize: 1,
    tickChunkSize: 1,
  });
}

function v4ClReplayRowsForPool(pool: FameV4ClReplayRegistryEntry) {
  return v4ClReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: -17_400,
    liquidity: 8_888n,
    lpFee: 30_000n,
    protocolFee: 0n,
    observedThroughBlock: 120,
    blockHash:
      "0x4444444444444444444444444444444444444444444444444444444444444444",
    parentHash:
      "0x5555555555555555555555555555555555555555555555555555555555555555",
    snapshotId: "unit-v4-cl-replay",
    stateHash:
      "0x6666666666666666666666666666666666666666666666666666666666666666",
    zoraProvenance: verifiedV4ZoraProvenance(pool),
    sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
    updatedAt: "2026-05-21T00:00:00.000Z",
    bitmapWords: [{ wordPosition: -1, bitmap: 1n << 169n }],
    initializedTicks: [
      { tick: -17_400, liquidityGross: 30n, liquidityNet: 10n },
    ],
    bitmapChunkSize: 1,
    tickChunkSize: 1,
  });
}

function quoteClReplayRowsForPool(pool: FameClReplayRegistryEntry) {
  return clReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: 0,
    liquidity: 1_000_000_000_000_000_000n,
    fee: 100n,
    observedThroughBlock: 120,
    blockHash:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    parentHash:
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    snapshotId: "unit-cl-quote",
    stateHash:
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
    updatedAt: "2026-05-20T00:00:00.000Z",
    bitmapWords: [
      { wordPosition: -1, bitmap: 1n << 255n },
      { wordPosition: 0, bitmap: 2n },
    ],
    initializedTicks: [
      { tick: -100, liquidityGross: 1_000n, liquidityNet: -1_000n },
      { tick: 100, liquidityGross: 1_000n, liquidityNet: 1_000n },
    ],
    bitmapChunkSize: 1,
    tickChunkSize: 1,
  });
}

function quoteV4ClReplayRowsForPool(
  pool: FameV4ClReplayRegistryEntry,
  options: {
    protocolFee?: bigint;
    zoraProvenance?: FameV4ZoraVerifiedProvenance;
  } = {},
) {
  return v4ClReplayStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: 0,
    liquidity: 1_000_000_000_000_000_000n,
    lpFee: 30_000n,
    protocolFee: options.protocolFee ?? 0n,
    observedThroughBlock: 120,
    blockHash:
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    parentHash:
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    snapshotId: "unit-v4-cl-quote",
    stateHash:
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    zoraProvenance: options.zoraProvenance ?? verifiedV4ZoraProvenance(pool),
    sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
    updatedAt: "2026-05-21T00:00:00.000Z",
    bitmapWords: [
      { wordPosition: -1, bitmap: 1n << 255n },
      { wordPosition: 0, bitmap: 2n },
    ],
    initializedTicks: [
      { tick: -100, liquidityGross: 1_000n, liquidityNet: -1_000n },
      { tick: 100, liquidityGross: 1_000n, liquidityNet: 1_000n },
    ],
    bitmapChunkSize: 1,
    tickChunkSize: 1,
  });
}

function quoteClReplayCandidateRowsForPool(pool: FameClReplayRegistryEntry) {
  return clReplayCandidateStateRowsFromSnapshot({
    pool,
    sqrtPriceX96: 2n ** 96n,
    tick: 0,
    liquidity: 1_000_000_000_000_000_000n,
    fee: 100n,
    observedThroughBlock: 120,
    blockHash:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    parentHash:
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    candidateId: "unit-cl-candidate",
    stateHash:
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
    updatedAt: "2026-05-20T00:00:00.000Z",
    bitmapWords: [
      { wordPosition: -1, bitmap: 1n << 255n },
      { wordPosition: 0, bitmap: 2n },
    ],
    initializedTicks: [
      { tick: -100, liquidityGross: 1_000n, liquidityNet: -1_000n },
      { tick: 100, liquidityGross: 1_000n, liquidityNet: 1_000n },
    ],
    bitmapChunkSize: 1,
    tickChunkSize: 1,
  });
}

function trustedMaintenanceForReplayRows(
  pool: FameClReplayRegistryEntry,
  rows: ReturnType<typeof clReplayStateRowsFromSnapshot>,
): FameClReplayMaintenanceState {
  return {
    ...latestClReplayMaintenanceStateKey(pool),
    stateKind: "cl-replay-maintenance-v1",
    poolId: pool.id,
    chainId: pool.chainId,
    poolAddress: pool.poolAddress,
    status: "trusted",
    cursorBlock: rows.latest.observedThroughBlock,
    cursorBlockHash: rows.latest.blockHash,
    cursorTransactionIndex: Number.MAX_SAFE_INTEGER,
    cursorLogIndex: Number.MAX_SAFE_INTEGER,
    targetBlock: rows.latest.observedThroughBlock,
    targetBlockHash: rows.latest.blockHash,
    stateHash: rows.latest.stateHash,
    sourceRegistryId: rows.latest.sourceRegistryId,
    updatedAt: "2026-05-20T00:00:00.000Z",
    lastCheckpointBlock: rows.latest.observedThroughBlock,
    lastCheckpointBlockHash: rows.latest.blockHash,
    reason: null,
    candidateId: rows.latest.snapshotId,
  };
}

function trustedMaintenanceForReplayCandidateRows(
  pool: FameClReplayRegistryEntry,
  rows: ReturnType<typeof clReplayCandidateStateRowsFromSnapshot>,
): FameClReplayMaintenanceState {
  return {
    ...latestClReplayMaintenanceStateKey(pool),
    stateKind: "cl-replay-maintenance-v1",
    poolId: pool.id,
    chainId: pool.chainId,
    poolAddress: pool.poolAddress,
    status: "trusted",
    cursorBlock: rows.latest.observedThroughBlock,
    cursorBlockHash: rows.latest.blockHash,
    cursorTransactionIndex: Number.MAX_SAFE_INTEGER,
    cursorLogIndex: Number.MAX_SAFE_INTEGER,
    targetBlock: rows.latest.observedThroughBlock,
    targetBlockHash: rows.latest.blockHash,
    stateHash: rows.latest.stateHash,
    sourceRegistryId: rows.latest.sourceRegistryId,
    updatedAt: "2026-05-20T00:00:00.000Z",
    lastCheckpointBlock: rows.latest.observedThroughBlock,
    lastCheckpointBlockHash: rows.latest.blockHash,
    reason: null,
    candidateId: rows.latest.candidateId,
  };
}

function warmingMaintenanceForReplayRows(
  pool: FameClReplayRegistryEntry,
  rows: ReturnType<typeof clReplayStateRowsFromSnapshot>,
): FameClReplayMaintenanceState {
  return {
    ...trustedMaintenanceForReplayRows(pool, rows),
    status: "warming",
    reason: "shadow-not-promoted",
  };
}

function warmingMaintenanceForReplayCandidateRows(
  pool: FameClReplayRegistryEntry,
  rows: ReturnType<typeof clReplayCandidateStateRowsFromSnapshot>,
): FameClReplayMaintenanceState {
  return {
    ...trustedMaintenanceForReplayCandidateRows(pool, rows),
    status: "warming",
    reason: "shadow-not-promoted",
  };
}

function parseFixtureObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected fixture object at ${path}.`);
  }
  return value as Record<string, unknown>;
}

function parseFixtureString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected fixture string at ${path}.`);
  }
  return value;
}

function parseFixtureNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Expected fixture integer at ${path}.`);
  }
  return value;
}

function parseFixtureAddress(value: unknown, path: string): Address {
  const parsed = parseFixtureString(value, path);
  if (!isAddress(parsed, { strict: false })) {
    throw new Error(`Expected fixture address at ${path}.`);
  }
  return parsed as Address;
}

function parseFixtureQuotes(
  value: unknown,
  path: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected fixture quote array at ${path}.`);
  }
  return value.map((quote, index) =>
    parseFixtureObject(quote, `${path}[${index.toString()}]`),
  );
}

function poolQuotesFixtureResponse(): Record<string, unknown> {
  const fixtureUrl = new URL("./fixtures/pool-quotes-v1.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  const fixture = parseFixtureObject(parsed, "$");
  return parseFixtureObject(fixture.response, "$.response");
}

function poolQuotesFixtureUnavailableExamples(): Record<string, unknown>[] {
  const fixtureUrl = new URL("./fixtures/pool-quotes-v1.json", import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  const fixture = parseFixtureObject(parsed, "$");
  return parseFixtureQuotes(
    fixture.unavailableExamples,
    "$.unavailableExamples",
  );
}

function fixtureQuoteRequests(
  response: Record<string, unknown>,
): FamePoolQuoteRequest[] {
  const quotes = parseFixtureQuotes(response.quotes, "$.response.quotes");
  return quotes.map((quote, index) => ({
    poolId: parseFixtureString(
      quote.poolId,
      `$.response.quotes[${index.toString()}].poolId`,
    ),
    tokenIn: parseFixtureAddress(
      quote.tokenIn,
      `$.response.quotes[${index.toString()}].tokenIn`,
    ),
    tokenOut: parseFixtureAddress(
      quote.tokenOut,
      `$.response.quotes[${index.toString()}].tokenOut`,
    ),
    amountIn: parseFixtureString(
      quote.amountIn,
      `$.response.quotes[${index.toString()}].amountIn`,
    ),
  }));
}

function fixtureReserveStates(): FamePoolLatestState[] {
  const sourceRegistryId = sourceRegistryIdFor(famePoolStateRegistry.source);
  return quoteModelPools().map((pool) =>
    stateForPool(pool, 120, {
      reserve0: 1000n,
      reserve1: 2500n,
      sourceRegistryId,
    }),
  );
}

describe("FAME pool-state API contract", () => {
  test("authorizes bearer tokens from the Authorization header", () => {
    expect(
      poolStateRequestAuthorized(
        { authorization: "Bearer unit-token" },
        "unit-token",
      ),
    ).toBe(true);
    expect(
      poolStateRequestAuthorized(
        { Authorization: "Bearer unit-token" },
        "unit-token",
      ),
    ).toBe(true);
    expect(
      poolStateRequestAuthorized(
        { "x-fame-pool-state-token": "unit-token" },
        "unit-token",
      ),
    ).toBe(false);
    expect(poolStateRequestAuthorized({}, "unit-token")).toBe(false);
  });

  test("returns fresh indexed reserve state for quote-model pools", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 120)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      poolId: pool.id,
      reserve0: "100",
      reserve1: "250",
      k: "25000",
      observedThroughBlock: 120,
      maxFreshnessBlocks: 120,
    });
  });

  test("returns unsupported for tracked-only stable and concentrated pools", async () => {
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [
          { poolId: "scale-equalizer-usdc-frxusd" },
          { poolId: "uniswap-v4-usdc-eth" },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([]),
    });

    expect(response.pools).toEqual([
      expect.objectContaining({
        status: "unsupported",
        poolId: "scale-equalizer-usdc-frxusd",
        unsupportedReason: "stable-pool",
      }),
      expect.objectContaining({
        status: "unsupported",
        poolId: "uniswap-v4-usdc-eth",
        unsupportedReason: "concentrated-liquidity",
      }),
    ]);
  });

  test("returns fresh CL head state for CL-capable requests", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([clHeadStateForPool(pool, 120)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      stateKind: "cl-head-snapshot",
      poolId: pool.id,
      poolAddress: pool.poolAddress,
      poolKey: null,
      sqrtPriceX96: (2n ** 96n).toString(),
      tick: -11,
      liquidity: "555",
      observedThroughBlock: 120,
      source: "pool-slot0-liquidity",
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      maxFreshnessBlocks: 120,
    });
  });

  test("returns fresh CL replay state only when explicitly requested", async () => {
    const pool = clReplayPool();
    const rows = clReplayRowsForPool(pool);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        trustedMaintenanceForReplayRows(pool, rows),
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      stateKind: "cl-replay-v1",
      poolId: pool.id,
      poolAddress: pool.poolAddress,
      sqrtPriceX96: (2n ** 96n).toString(),
      tick: 199_900,
      liquidity: "1000",
      fee: "100",
      blockHash:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      snapshotId: "unit-cl-replay",
      stateHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      bitmapWordCount: 2,
      initializedTickCount: 2,
      bitmapChunkCount: 2,
      tickChunkCount: 2,
      maxFreshnessBlocks: 120,
    });
    expect(response.pools[0]).toMatchObject({
      bitmapWords: [
        {
          wordPosition: 7,
          bitmap:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
        {
          wordPosition: 8,
          bitmap:
            "0x0000000000000000000000000000000000000000000000000000000000000002",
        },
      ],
      initializedTicks: [
        { tick: 199_900, liquidityGross: "25", liquidityNet: "15" },
        { tick: 200_000, liquidityGross: "50", liquidityNet: "-15" },
      ],
    });
  });

  test("returns selected active CL replay state for indexed route-lab requests", async () => {
    const pool = selectedActiveClReplayPool();
    const rows = clReplayRowsForPool(pool);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        trustedMaintenanceForReplayRows(pool, rows),
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      stateKind: "cl-replay-v1",
      poolId: pool.id,
      poolAddress: pool.poolAddress,
      snapshotId: "unit-cl-replay",
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      bitmapWordCount: 2,
      initializedTickCount: 2,
    });
  });

  test("returns compact CL quotes without raw replay arrays", async () => {
    const pool = clReplayPool();
    const rows = quoteClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
          {
            poolId: pool.id,
            tokenIn: pool.token1,
            tokenOut: pool.token0,
            amountIn: "1000000",
          },
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "10000000000000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        trustedMaintenanceForReplayRows(pool, rows),
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes).toHaveLength(3);
    const [directQuote, reverseQuote, crossingQuote] = response.quotes.map(
      (quote) => {
        expect(quote).toMatchObject({
          status: "quoted",
          quoteKind: "cl-quote-v1",
          poolId: pool.id,
          poolAddress: pool.poolAddress,
          sqrtPriceX96: (2n ** 96n).toString(),
          observedThroughBlock: 120,
          snapshotId: "unit-cl-quote",
          sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
          maxFreshnessBlocks: 120,
        });
        expect(quote).not.toHaveProperty("bitmapWords");
        expect(quote).not.toHaveProperty("initializedTicks");
        if (quote.status !== "quoted") {
          throw new Error("Expected quoted CL quote.");
        }
        return quote;
      },
    );
    expect(directQuote).toMatchObject({
      tokenIn: pool.token0,
      tokenOut: pool.token1,
      amountIn: "1000000",
      amountOut: "999899",
      sqrtPriceX96After: "79228162514185117353846016638",
    });
    expect(reverseQuote).toMatchObject({
      tokenIn: pool.token1,
      tokenOut: pool.token0,
      amountIn: "1000000",
      amountOut: "999899",
      sqrtPriceX96After: "79228162514343557833241963247",
    });
    expect(crossingQuote).toMatchObject({
      tokenIn: pool.token0,
      tokenOut: pool.token1,
      amountIn: "10000000000000000",
      amountOut: "9900009801989901",
      sqrtPriceX96After: "78443802928779472160203450183",
    });
  });

  test("returns selected compact CL quotes from trusted replay state", async () => {
    const pool = selectedActiveClReplayPool();
    const rows = quoteClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
          {
            poolId: pool.id,
            tokenIn: pool.token1,
            tokenOut: pool.token0,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        trustedMaintenanceForReplayRows(pool, rows),
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes).toEqual([
      expect.objectContaining({
        status: "quoted",
        quoteKind: "cl-quote-v1",
        poolId: pool.id,
        poolAddress: pool.poolAddress,
        tokenIn: pool.token0,
        tokenOut: pool.token1,
        amountIn: "1000000",
        amountOut: "999899",
        snapshotId: "unit-cl-quote",
        stateHash:
          "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      }),
      expect.objectContaining({
        status: "quoted",
        quoteKind: "cl-quote-v1",
        poolId: pool.id,
        tokenIn: pool.token1,
        tokenOut: pool.token0,
        amountIn: "1000000",
        amountOut: "999899",
        snapshotId: "unit-cl-quote",
      }),
    ]);
    for (const quote of response.quotes) {
      expect(quote).not.toHaveProperty("bitmapWords");
      expect(quote).not.toHaveProperty("initializedTicks");
    }
  });

  test("returns targeted V4 compact CL quotes with PoolKey evidence", async () => {
    const pool = v4ClReplayPool();
    const rows = quoteV4ClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
          {
            poolId: pool.id,
            tokenIn: pool.token1,
            tokenOut: pool.token0,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes).toHaveLength(2);
    for (const quote of response.quotes) {
      expect(quote).toMatchObject({
        status: "quoted",
        quoteKind: "cl-quote-v1",
        poolId: pool.id,
        poolAddress: null,
        poolKey: pool.poolKey,
        stateViewAddress: pool.stateViewAddress,
        venueFamily: "UniswapV4",
        source: "uniswap-v4-state-view",
        fee: "30000",
        lpFee: "30000",
        protocolFee: "0",
        protocolFeeStatus: "zero",
        staticFee: "30000",
        feeSource: "v4-slot0",
        hookData: "0x",
        hookDataStatus: "empty",
        observedThroughBlock: 120,
        snapshotId: "unit-v4-cl-quote",
        sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
        maxFreshnessBlocks: 120,
        zoraProvenance: expect.objectContaining({
          status: "verified",
          coinAddress: pool.token1,
          poolKey: pool.poolKey,
        }),
      });
      expect(quote).not.toHaveProperty("bitmapWords");
      expect(quote).not.toHaveProperty("initializedTicks");
      if (quote.status !== "quoted") {
        throw new Error("Expected quoted V4 CL quote.");
      }
      expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
    }
  });

  test("returns V4 source-registry mismatch unavailable rows with PoolKey metadata", async () => {
    const pool = v4ClReplayPool();
    const rows = quoteV4ClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        {
          ...rows.latest,
          sourceRegistryId: "stale-registry",
        },
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "source-registry-mismatch",
      poolId: pool.id,
      poolAddress: null,
      poolKey: pool.poolKey,
      stateViewAddress: pool.stateViewAddress,
      observedThroughBlock: 120,
      sourceRegistryId: "stale-registry",
      maxFreshnessBlocks: 120,
    });
  });

  test("returns stale V4 unavailable rows with PoolKey metadata", async () => {
    const pool = v4ClReplayPool();
    const rows = quoteV4ClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        maxFreshnessBlocks: 10,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        {
          ...rows.latest,
          observedThroughBlock: 100,
        },
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "stale-indexed-state",
      poolId: pool.id,
      poolAddress: null,
      poolKey: pool.poolKey,
      stateViewAddress: pool.stateViewAddress,
      observedThroughBlock: 100,
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      maxFreshnessBlocks: 10,
    });
  });

  test("returns future V4 unavailable rows as stale with PoolKey metadata", async () => {
    const pool = v4ClReplayPool();
    const rows = quoteV4ClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        {
          ...rows.latest,
          observedThroughBlock: 130,
        },
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "stale-indexed-state",
      poolId: pool.id,
      poolAddress: null,
      poolKey: pool.poolKey,
      stateViewAddress: pool.stateViewAddress,
      observedThroughBlock: 130,
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      maxFreshnessBlocks: 120,
    });
  });

  test("returns V4 token-direction mismatch unavailable rows with PoolKey metadata", async () => {
    const pool = v4ClReplayPool();
    const rows = quoteV4ClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: ADDRESS_A,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "token-direction-mismatch",
      poolId: pool.id,
      poolAddress: null,
      poolKey: pool.poolKey,
      stateViewAddress: pool.stateViewAddress,
      observedThroughBlock: 120,
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      maxFreshnessBlocks: 120,
    });
  });

  test("returns row-scoped V4 fee-model unavailability without blocking reserve quotes", async () => {
    const reservePool = quotePool("uniswap-v2-fame-direct");
    const v4Pool = v4ClReplayPool();
    const v4Rows = quoteV4ClReplayRowsForPool(v4Pool, { protocolFee: 1n });
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: reservePool.id,
            tokenIn: reservePool.token0,
            tokenOut: reservePool.token1,
            amountIn: "500",
          },
          {
            poolId: v4Pool.id,
            tokenIn: v4Pool.token0,
            tokenOut: v4Pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        stateForPool(reservePool, 120, {
          reserve0: 1000n,
          reserve1: 2500n,
          sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
        }),
        v4Rows.latest,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes).toEqual([
      expect.objectContaining({
        status: "quoted",
        quoteKind: "constant-product-quote-v1",
        poolId: reservePool.id,
        amountOut: "831",
      }),
      expect.objectContaining({
        status: "unavailable",
        reason: "fee-model-mismatch",
        poolId: v4Pool.id,
        poolAddress: null,
        poolKey: v4Pool.poolKey,
        stateViewAddress: v4Pool.stateViewAddress,
        observedThroughBlock: 120,
      }),
    ]);
  });

  test("returns V4 shape mismatch unavailable rows for PoolKey drift", async () => {
    const pool = v4ClReplayPool();
    const rows = quoteV4ClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        {
          ...rows.latest,
          poolKey:
            "0x8888888888888888888888888888888888888888888888888888888888888888",
        },
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "v4-shape-mismatch",
      poolId: pool.id,
      poolAddress: null,
      poolKey:
        "0x8888888888888888888888888888888888888888888888888888888888888888",
      stateViewAddress: pool.stateViewAddress,
      observedThroughBlock: 120,
    });
  });

  test("returns V4 missing-provenance unavailable rows for unbound provenance", async () => {
    const pool = v4ClReplayPool();
    const rows = quoteV4ClReplayRowsForPool(pool, {
      zoraProvenance: {
        ...verifiedV4ZoraProvenance(pool),
        coinAddress: ADDRESS_A,
      },
    });
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([rows.latest]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "missing-provenance",
      poolId: pool.id,
      poolAddress: null,
      poolKey: pool.poolKey,
      stateViewAddress: pool.stateViewAddress,
      observedThroughBlock: 120,
    });
  });

  test("does not serve compact CL quotes from candidate-only replay state", async () => {
    const pool = clReplayCandidatePool();
    const rows = quoteClReplayCandidateRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      registry: {
        ...famePoolStateRegistry,
        pools: famePoolStateRegistry.pools.map((entry) =>
          entry.id === pool.id ? pool : entry,
        ),
      },
      db: new BatchStateDb([
        trustedMaintenanceForReplayCandidateRows(pool, rows),
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "unsupported-pool",
      poolId: pool.id,
      poolAddress: pool.poolAddress,
    });
  });

  test("returns unavailable selected quotes before seed or trusted maintenance", async () => {
    const pool = selectedActiveClReplayPool();
    const rows = quoteClReplayRowsForPool(pool);
    const missingResponse = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([]),
      producerMaxFreshnessBlocks: 120,
    });
    const untrustedResponse = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        warmingMaintenanceForReplayRows(pool, rows),
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(missingResponse.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "missing-indexed-state",
      poolId: pool.id,
      poolAddress: pool.poolAddress,
    });
    expect(untrustedResponse.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "producer-untrusted",
      poolId: pool.id,
      observedThroughBlock: 120,
      producerStatus: "warming",
      producerReason: "shadow-not-promoted",
    });
  });

  test("matches the golden compact reserve quote fixture for every quote-model pool", async () => {
    const fixtureBytes = readFileSync(
      new URL("./fixtures/pool-quotes-v1.json", import.meta.url),
    );
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      POOL_QUOTES_V1_FIXTURE_SHA256,
    );

    const fixtureResponse = poolQuotesFixtureResponse();
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: parseFixtureNumber(
          fixtureResponse.currentBlock,
          "$.response.currentBlock",
        ),
        quotes: fixtureQuoteRequests(fixtureResponse),
      },
      tableName: "PoolState",
      db: new BatchStateDb(fixtureReserveStates()),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response).toEqual(fixtureResponse);
    expect(response.quotes).toHaveLength(quoteModelPools().length * 2);
    for (const quote of response.quotes) {
      expect(quote).toMatchObject({
        status: "quoted",
        quoteKind: "constant-product-quote-v1",
        quoteModel: "constant-product-reserves",
        quoteModelVersion: 1,
        source: "reserve-pool-state",
      });
      expect(quote).not.toHaveProperty("reserve0");
      expect(quote).not.toHaveProperty("reserve1");
      expect(quote).not.toHaveProperty("k");
    }
  });

  test("documents producer-untrusted compact quote fixture examples", () => {
    const [baselineProducerUntrusted, candidateProducerUntrusted] =
      poolQuotesFixtureUnavailableExamples();

    expect(baselineProducerUntrusted).toMatchObject({
      status: "unavailable",
      reason: "producer-untrusted",
      poolId: "slipstream-usdc-weth-100",
      producerStatus: "trusted",
      producerReason: null,
    });
    expect(candidateProducerUntrusted).toMatchObject({
      status: "unavailable",
      reason: "producer-untrusted",
      poolId: "slipstream-basedflick-fame",
      producerStatus: "warming",
      producerReason: "shadow-not-promoted",
    });
  });

  test("quotes reserve and Slipstream compact rows in one batch", async () => {
    const reservePool = quotePool("uniswap-v2-fame-direct");
    const clPool = clReplayPool();
    const clRows = quoteClReplayRowsForPool(clPool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: reservePool.id,
            tokenIn: reservePool.token0,
            tokenOut: reservePool.token1,
            amountIn: "500",
          },
          {
            poolId: clPool.id,
            tokenIn: clPool.token0,
            tokenOut: clPool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        stateForPool(reservePool, 120, {
          reserve0: 1000n,
          reserve1: 2500n,
          sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
        }),
        trustedMaintenanceForReplayRows(clPool, clRows),
        clRows.latest,
        ...clRows.bitmapChunks,
        ...clRows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes).toEqual([
      expect.objectContaining({
        status: "quoted",
        quoteKind: "constant-product-quote-v1",
        poolId: reservePool.id,
        amountIn: "500",
        amountOut: "831",
      }),
      expect.objectContaining({
        status: "quoted",
        quoteKind: "cl-quote-v1",
        poolId: clPool.id,
        amountIn: "1000000",
        amountOut: "999899",
      }),
    ]);
  });

  test("returns unavailable reserve quotes for token direction mismatch", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: ADDRESS_A,
            amountIn: "500",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        stateForPool(pool, 120, {
          sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
        }),
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "token-direction-mismatch",
      poolId: pool.id,
      chainId: pool.chainId,
      poolAddress: pool.poolAddress,
      observedThroughBlock: 120,
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      maxFreshnessBlocks: 120,
    });
  });

  test("returns unavailable reserve quotes for stale reserve state", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 500,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "500",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        stateForPool(pool, 120, {
          sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
        }),
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "stale-indexed-state",
      requested: {
        poolId: pool.id,
        tokenIn: pool.token0,
        tokenOut: pool.token1,
        amountIn: "500",
      },
      observedThroughBlock: 120,
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      maxFreshnessBlocks: 120,
    });
  });

  test("returns unavailable reserve quotes for source registry mismatch", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "500",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        stateForPool(pool, 120, {
          sourceRegistryId: "stale-registry",
        }),
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "source-registry-mismatch",
      poolId: pool.id,
      observedThroughBlock: 120,
      sourceRegistryId: "stale-registry",
      maxFreshnessBlocks: 120,
    });
  });

  test("returns unavailable reserve quotes for malformed reserve state", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "500",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        stateForPool(pool, 120, {
          reserve0: 0n,
          reserve1: 2500n,
          sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
        }),
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "malformed-reserve-state",
      poolId: pool.id,
      observedThroughBlock: 120,
      sourceRegistryId: sourceRegistryIdFor(famePoolStateRegistry.source),
      maxFreshnessBlocks: 120,
    });
  });

  test("returns unavailable CL quotes for stale replay state without loading chunks", async () => {
    const pool = clReplayPool();
    const rows = quoteClReplayRowsForPool(pool);
    const db = new BatchStateDb([rows.latest]);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 500,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db,
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "stale-indexed-state",
      requested: {
        poolId: pool.id,
        tokenIn: pool.token0,
        tokenOut: pool.token1,
        amountIn: "1000000",
      },
      observedThroughBlock: 120,
      maxFreshnessBlocks: 120,
    });
    expect(db.readCount).toBe(2);
  });

  test("returns unavailable CL quotes for incomplete replay capsules", async () => {
    const pool = clReplayPool();
    const rows = quoteClReplayRowsForPool(pool);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        trustedMaintenanceForReplayRows(pool, rows),
        rows.latest,
        ...rows.bitmapChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "missing-indexed-state",
      poolId: pool.id,
      observedThroughBlock: 120,
    });
  });

  test("returns unavailable CL quotes for untrusted producer maintenance without loading chunks", async () => {
    const pool = clReplayPool();
    const rows = quoteClReplayRowsForPool(pool);
    const maintenance = warmingMaintenanceForReplayRows(pool, rows);
    maintenance.reason =
      'response body {"token":"unit-secret"} https://rpc.example/raw';
    const db = new BatchStateDb([
      maintenance,
      rows.latest,
      ...rows.bitmapChunks,
      ...rows.tickChunks,
    ]);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db,
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes[0]).toMatchObject({
      status: "unavailable",
      reason: "producer-untrusted",
      poolId: pool.id,
      observedThroughBlock: 120,
      producerStatus: "warming",
      producerReason: "redacted-reason",
    });
    expect(JSON.stringify(response)).not.toContain("unit-secret");
    expect(JSON.stringify(response)).not.toContain("rpc.example");
    expect(db.readCount).toBe(2);
  });

  test("returns unavailable compact quotes for unsupported or unknown pools", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const db = new BatchStateDb([]);
    const response = await handleFamePoolQuoteBatchRequest({
      request: {
        currentBlock: 125,
        quotes: [
          {
            poolId: pool.id,
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
          {
            poolId: "missing-pool",
            tokenIn: pool.token0,
            tokenOut: pool.token1,
            amountIn: "1000000",
          },
        ],
      },
      tableName: "PoolState",
      db,
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.quotes).toEqual([
      expect.objectContaining({
        status: "unavailable",
        reason: "unsupported-pool",
        poolId: pool.id,
      }),
      expect.objectContaining({
        status: "unavailable",
        reason: "missing-registry-entry",
      }),
    ]);
    expect(db.readCount).toBe(0);
  });

  test("rejects zero and oversized CL quote amount strings before DynamoDB access", async () => {
    const pool = clReplayPool();
    const db = new BatchStateDb([]);

    await expect(
      handleFamePoolQuoteBatchRequest({
        request: {
          currentBlock: 125,
          quotes: [
            {
              poolId: pool.id,
              tokenIn: pool.token0,
              tokenOut: pool.token1,
              amountIn: "1".repeat(79),
            },
          ],
        },
        tableName: "PoolState",
        db,
        producerMaxFreshnessBlocks: 120,
      }),
    ).rejects.toThrow(/uint256 decimal string/);
    expect(db.readCount).toBe(0);

    await expect(
      handleFamePoolQuoteBatchRequest({
        request: {
          currentBlock: 125,
          quotes: [
            {
              poolId: pool.id,
              tokenIn: pool.token0,
              tokenOut: pool.token1,
              amountIn: "0",
            },
          ],
        },
        tableName: "PoolState",
        db,
        producerMaxFreshnessBlocks: 120,
      }),
    ).rejects.toThrow(/positive uint256 decimal string/);
    expect(db.readCount).toBe(0);
  });

  test("rejects CL quote batches larger than the configured maximum before parsing entries", async () => {
    const pool = clReplayPool();
    const db = new BatchStateDb([]);

    await expect(
      handleFamePoolQuoteBatchRequest({
        request: {
          currentBlock: 125,
          quotes: [
            {
              poolId: pool.id,
              tokenIn: pool.token0,
              tokenOut: pool.token1,
              amountIn: "1",
            },
            {
              poolId: pool.id,
              tokenIn: pool.token0,
              tokenOut: pool.token1,
              amountIn: "1".repeat(79),
            },
          ],
        },
        tableName: "PoolState",
        db,
        producerMaxFreshnessBlocks: 120,
        maxBatchSize: 1,
      }),
    ).rejects.toThrow(/expected at most 1 quotes/);
    expect(db.readCount).toBe(0);
  });

  test("returns unknown for incomplete CL replay capsules", async () => {
    const pool = clReplayPool();
    const rows = clReplayRowsForPool(pool);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([rows.latest, ...rows.bitmapChunks]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toEqual({
      status: "unknown",
      requested: { poolId: pool.id },
      reason: "missing-indexed-state",
    });
  });

  test("returns stale CL replay metadata without loading tick chunks", async () => {
    const pool = clReplayPool();
    const rows = clReplayRowsForPool(pool);
    const db = new BatchStateDb([rows.latest]);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 500,
        stateSurfaces: ["cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db,
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "stale",
      stateKind: "cl-replay-v1",
      poolId: pool.id,
      observedThroughBlock: 120,
      bitmapWordCount: 2,
      initializedTickCount: 2,
    });
    expect(response.pools[0]).not.toHaveProperty("bitmapWords");
    expect(response.pools[0]).not.toHaveProperty("initializedTicks");
    expect(db.readCount).toBe(1);
  });

  test("returns future CL replay metadata as stale without loading tick chunks", async () => {
    const pool = clReplayPool();
    const rows = clReplayRowsForPool(pool);
    const db = new BatchStateDb([
      { ...rows.latest, observedThroughBlock: 130 },
    ]);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db,
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "stale",
      stateKind: "cl-replay-v1",
      poolId: pool.id,
      observedThroughBlock: 130,
    });
    expect(response.pools[0]).not.toHaveProperty("bitmapWords");
    expect(response.pools[0]).not.toHaveProperty("initializedTicks");
    expect(db.readCount).toBe(1);
  });

  test("returns fresh V4 replay state only through the V4 replay surface", async () => {
    const pool = v4ClReplayPool();
    const rows = v4ClReplayRowsForPool(pool);
    const db = new BatchStateDb([
      rows.latest,
      ...rows.bitmapChunks,
      ...rows.tickChunks,
    ]);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["v4-cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db,
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      stateKind: "v4-cl-replay-v1",
      poolId: pool.id,
      poolKey: pool.poolKey,
      stateViewAddress: pool.stateViewAddress,
      venueFamily: "UniswapV4",
      tick: -17_400,
      liquidity: "8888",
      lpFee: "30000",
      protocolFee: "0",
      feeSource: "v4-slot0",
      source: "uniswap-v4-state-view",
      zoraProvenance: verifiedV4ZoraProvenance(pool),
      observedThroughBlock: 120,
      bitmapWordCount: 1,
      initializedTickCount: 1,
      bitmapWords: [{ wordPosition: -1, bitmap: expect.any(String) }],
      initializedTicks: [
        { tick: -17_400, liquidityGross: "30", liquidityNet: "10" },
      ],
    });
    expect(response.pools[0]).not.toHaveProperty("poolAddress");
    expect(db.readCount).toBe(2);

    const slipstreamSurfaceResponse = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db,
      producerMaxFreshnessBlocks: 120,
    });
    expect(slipstreamSurfaceResponse.pools[0]).toEqual({
      status: "unsupported",
      poolId: pool.id,
      chainId: pool.chainId,
      poolAddress: null,
      unsupportedReason: "concentrated-liquidity",
    });
  });

  test("returns unknown for V4 replay rows with mismatched provenance", async () => {
    const pool = v4ClReplayPool();
    const rows = v4ClReplayRowsForPool(pool);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["v4-cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        {
          ...rows.latest,
          zoraProvenance: {
            ...rows.latest.zoraProvenance,
            coinAddress: pool.token0,
          },
        },
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toEqual({
      status: "unknown",
      requested: { poolId: pool.id },
      reason: "missing-indexed-state",
    });
  });

  test("returns stale V4 replay metadata without loading tick chunks", async () => {
    const pool = v4ClReplayPool();
    const rows = v4ClReplayRowsForPool(pool);
    const db = new BatchStateDb([rows.latest]);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 500,
        stateSurfaces: ["v4-cl-replay-v1"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db,
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "stale",
      stateKind: "v4-cl-replay-v1",
      poolId: pool.id,
      poolKey: pool.poolKey,
      stateViewAddress: pool.stateViewAddress,
      observedThroughBlock: 120,
      bitmapWordCount: 1,
      initializedTickCount: 1,
    });
    expect(response.pools[0]).not.toHaveProperty("bitmapWords");
    expect(response.pools[0]).not.toHaveProperty("initializedTicks");
    expect(response.pools[0]).not.toHaveProperty("poolAddress");
    expect(db.readCount).toBe(1);
  });

  test("does not expose CL replay arrays without replay opt-in", async () => {
    const pool = clReplayPool();
    const rows = clReplayRowsForPool(pool);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        clHeadStateForPool(pool, 120),
        rows.latest,
        ...rows.bitmapChunks,
        ...rows.tickChunks,
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      stateKind: "cl-head-snapshot",
      poolId: pool.id,
    });
    expect(response.pools[0]).not.toHaveProperty("bitmapWords");
    expect(response.pools[0]).not.toHaveProperty("initializedTicks");
  });

  test("returns unknown for CL head state from a different registry source", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([clHeadStateForPool(pool, 120, "stale-registry")]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toEqual({
      status: "unknown",
      requested: { poolId: pool.id },
      reason: "missing-indexed-state",
    });
  });

  test("returns unknown for CL head state whose metadata no longer matches the registry", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([
        {
          ...clHeadStateForPool(pool, 120),
          token1: pool.token0,
        },
      ]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toEqual({
      status: "unknown",
      requested: { poolId: pool.id },
      reason: "missing-indexed-state",
    });
  });

  test("treats future CL head state as stale", async () => {
    const pool = clHeadPool("uniswap-v3-usdc-weth-5bps");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        stateSurfaces: ["cl-head-snapshot"],
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([clHeadStateForPool(pool, 130)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "stale",
      stateKind: "cl-head-snapshot",
      observedThroughBlock: 130,
    });
  });

  test("honors stricter caller freshness without loosening producer freshness", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        maxFreshnessBlocks: 3,
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 120)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.effectiveMaxFreshnessBlocks).toBe(3);
    expect(response.pools[0]).toMatchObject({
      status: "stale",
      maxFreshnessBlocks: 3,
    });
  });

  test("treats future observed-through state as stale", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [{ poolId: pool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 130)]),
      producerMaxFreshnessBlocks: 120,
    });

    expect(response.pools[0]).toMatchObject({
      status: "stale",
      observedThroughBlock: 130,
    });
  });

  test("rejects mixed poolId and chain-address request key shapes", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new BatchStateDb([]);

    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [
            {
              poolId: pool.id,
              chainId: pool.chainId,
              poolAddress: pool.poolAddress,
            },
          ],
        },
        tableName: "PoolState",
        db,
      }),
    ).rejects.toThrow(/expected exactly one key shape/);
    expect(db.readCount).toBe(0);
  });

  test("rejects extra fields on otherwise valid request key shapes", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new BatchStateDb([]);

    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [{ poolId: pool.id, extra: true }],
        },
        tableName: "PoolState",
        db,
      }),
    ).rejects.toThrow(/expected exactly one key shape/);
    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [
            {
              chainId: pool.chainId,
              poolAddress: pool.poolAddress,
              extra: true,
            },
          ],
        },
        tableName: "PoolState",
        db,
      }),
    ).rejects.toThrow(/expected exactly one key shape/);
    expect(db.readCount).toBe(0);
  });

  test("returns unknown for absent registry coverage or missing indexed state", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [
          { poolId: "missing-pool" },
          {
            chainId: pool.chainId,
            poolAddress: pool.poolAddress,
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([]),
    });

    expect(response.pools).toEqual([
      expect.objectContaining({
        status: "unknown",
        reason: "missing-registry-entry",
      }),
      expect.objectContaining({
        status: "unknown",
        reason: "missing-indexed-state",
      }),
    ]);
  });

  test("rejects batches larger than the configured maximum before DynamoDB access", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const db = new BatchStateDb([stateForPool(pool, 120)]);

    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [{ poolId: pool.id }, { poolId: "uniswap-v2-usdc-weth" }],
        },
        tableName: "PoolState",
        db,
        maxBatchSize: 1,
      }),
    ).rejects.toThrow(/expected at most 1 pools/);
    expect(db.readCount).toBe(0);
  });

  test("can look up a quote-model pool by chain address", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [
          {
            chainId: pool.chainId,
            poolAddress: pool.poolAddress,
          },
        ],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 120)]),
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      poolId: pool.id,
    });
    expect(latestPoolStateKey(pool.chainId, pool.poolAddress).sk).toBe(
      "latest",
    );
  });

  test("matches fetched states by address when registry pool ids change", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");
    const renamedPool = {
      ...pool,
      id: "renamed-uniswap-v2-fame-direct",
    };
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [{ poolId: renamedPool.id }],
      },
      tableName: "PoolState",
      db: new BatchStateDb([stateForPool(pool, 120)]),
      registry: {
        ...famePoolStateRegistry,
        pools: [renamedPool],
      },
    });

    expect(response.pools[0]).toMatchObject({
      status: "fresh",
      poolId: renamedPool.id,
    });
  });

  test("rejects incomplete DynamoDB batch reads instead of returning missing state", async () => {
    const pool = quotePool("uniswap-v2-fame-direct");

    await expect(
      handleFamePoolStateBatchRequest({
        request: {
          currentBlock: 125,
          pools: [{ poolId: pool.id }],
        },
        tableName: "PoolState",
        db: new IncompleteBatchStateDb(),
      }),
    ).rejects.toThrow(/unprocessed keys/);
  });

  test("returns an empty response batch without reading DynamoDB", async () => {
    const db = new BatchStateDb([]);
    const response = await handleFamePoolStateBatchRequest({
      request: {
        currentBlock: 125,
        pools: [],
      },
      tableName: "PoolState",
      db,
    });

    expect(response.pools).toEqual([]);
    expect(db.readCount).toBe(0);
  });
});
