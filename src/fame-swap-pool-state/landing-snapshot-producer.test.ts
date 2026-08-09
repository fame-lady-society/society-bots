import { describe, expect, test } from "@jest/globals";
import type { Address, Hex } from "viem";
import {
  produceFameLandingSnapshot,
  type FameLandingRuntimeQuoteRequest,
  type FameLandingSnapshotProducerDependencies,
} from "./landing-snapshot-producer.ts";
import {
  fameLandingAuthority,
  type FameLandingSnapshot,
} from "./landing-snapshot.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type { FamePoolLatestState } from "./dynamodb/pool-state.ts";

const SAFE_BLOCK = 45_884_844;
const SAFE_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const CONNECTOR_RESERVE0 = 1_000n * 10n ** 18n;
const CONNECTOR_RESERVE1 = 4_000_000n * 10n ** 6n;

function runtimeAmountOut(request: FameLandingRuntimeQuoteRequest): bigint {
  const pool = famePoolStateRegistry.pools.find(
    ({ id }) => id === request.poolId,
  );
  if (!pool || pool.fee.status !== "available") {
    throw new Error("Missing runtime pool fixture.");
  }
  const zeroForOne =
    request.tokenIn.toLowerCase() === pool.token0.toLowerCase();
  const reserveIn = zeroForOne ? CONNECTOR_RESERVE0 : CONNECTOR_RESERVE1;
  const reserveOut = zeroForOne ? CONNECTOR_RESERVE1 : CONNECTOR_RESERVE0;
  const fee = (request.amountIn * BigInt(pool.fee.feeBps)) / 10_000n;
  const netAmountIn = request.amountIn - fee;
  return (netAmountIn * reserveOut) / (reserveIn + netAmountIn);
}

function multiplyBeforeFeeDivisionAmountOut(
  request: FameLandingRuntimeQuoteRequest,
): bigint {
  const pool = famePoolStateRegistry.pools.find(
    ({ id }) => id === request.poolId,
  );
  if (!pool || pool.fee.status !== "available") {
    throw new Error("Missing runtime pool fixture.");
  }
  const zeroForOne =
    request.tokenIn.toLowerCase() === pool.token0.toLowerCase();
  const reserveIn = zeroForOne ? CONNECTOR_RESERVE0 : CONNECTOR_RESERVE1;
  const reserveOut = zeroForOne ? CONNECTOR_RESERVE1 : CONNECTOR_RESERVE0;
  const amountInWithFee = request.amountIn * BigInt(10_000 - pool.fee.feeBps);
  return (
    (amountInWithFee * reserveOut) / (reserveIn * 10_000n + amountInWithFee)
  );
}

function reserveState(
  poolId: string,
  reserve0: bigint,
  reserve1: bigint,
): FamePoolLatestState {
  const pool = famePoolStateRegistry.pools.find(({ id }) => id === poolId);
  if (!pool?.poolAddress) throw new Error(`Missing reserve pool ${poolId}.`);
  return {
    pk: `pool:${pool.chainId}:${pool.poolAddress.toLowerCase()}`,
    sk: "latest",
    poolId,
    chainId: pool.chainId,
    poolAddress: pool.poolAddress,
    token0: pool.token0,
    token1: pool.token1,
    reserve0: reserve0.toString(),
    reserve1: reserve1.toString(),
    k: (reserve0 * reserve1).toString(),
    lastReserveChangeBlock: SAFE_BLOCK,
    lastEventTransactionIndex: Number.MAX_SAFE_INTEGER,
    lastEventLogIndex: Number.MAX_SAFE_INTEGER,
    lastEventTransactionHash: null,
    observedThroughBlock: SAFE_BLOCK,
    source: "getReserves",
    sourceRegistryId: fameLandingAuthority.sourceRegistryId,
    updatedAt: "2026-08-09T12:00:00.000Z",
  };
}

function dependencies(
  overrides: Partial<FameLandingSnapshotProducerDependencies> = {},
): FameLandingSnapshotProducerDependencies {
  return {
    async readMarketplace() {
      return {
        unit: 1_000_000n * 10n ** 18n,
        premium: 50_000n * 10n ** 18n,
        totalSupply: 987_654_321n * 10n ** 18n,
        decimals: 18,
      };
    },
    async readReserveStates() {
      return [
        reserveState(
          "scale-equalizer-frxusd-fame",
          1_000_000n * 10n ** 18n,
          20_000_000n * 10n ** 18n,
        ),
        reserveState(
          "scale-equalizer-scale-fame",
          1_000_000n * 10n ** 18n,
          20_000_000n * 10n ** 18n,
        ),
        reserveState(
          "scale-equalizer-weth-fame",
          1_000n * 10n ** 18n,
          4_000_000_000n * 10n ** 18n,
        ),
        reserveState(
          "uniswap-v2-fame-direct",
          1_500n * 10n ** 18n,
          5_000_000_000n * 10n ** 18n,
        ),
      ];
    },
    async readConcentratedPoolBalances() {
      return {
        poolId: "slipstream-basedflick-fame",
        balances: {
          [fameLandingAuthority.fameToken.toLowerCase()]:
            50_000_000n * 10n ** 18n,
          ["0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926"]: 2_000n * 10n ** 18n,
        },
      };
    },
    async readRuntimePoolReserves() {
      return [
        {
          poolId: "aerodrome-v2-usdc-weth",
          blockNumber: BigInt(SAFE_BLOCK),
          reserve0: CONNECTOR_RESERVE0,
          reserve1: CONNECTOR_RESERVE1,
        },
      ];
    },
    async readRuntimePoolQuotes({ requests }) {
      return requests.map((request) => ({
        quoteDefinitionId: request.quoteDefinitionId,
        status: "available" as const,
        blockNumber: BigInt(SAFE_BLOCK),
        amountOut: runtimeAmountOut(request),
      }));
    },
    ...overrides,
  };
}

async function produce(
  deps = dependencies(),
  previousSnapshot: FameLandingSnapshot | null = null,
  leafTimeoutMs = 100,
) {
  return produceFameLandingSnapshot({
    chainId: 8453,
    safeBlockNumber: SAFE_BLOCK,
    safeBlockHash: SAFE_HASH,
    capturedAt: new Date("2026-08-09T12:00:00.000Z"),
    deps,
    previousSnapshot,
    leafTimeoutMs,
  });
}

describe("FAME landing snapshot producer", () => {
  test("quotes USDC at the safe block without adding its connector to indexed reserve reads", async () => {
    let reserveReads = 0;
    let indexedPoolIds: readonly string[] = [];
    let runtimePoolIds: readonly string[] = [];
    let runtimeBlock = 0n;
    let runtimeQuoteReads = 0;
    const snapshot = await produce(
      dependencies({
        async readReserveStates({ poolIds }) {
          reserveReads += 1;
          indexedPoolIds = poolIds;
          return dependencies().readReserveStates({ poolIds: [] });
        },
        async readRuntimePoolReserves({ blockNumber, pools }) {
          runtimeBlock = blockNumber;
          runtimePoolIds = pools.map(({ poolId }) => poolId);
          return dependencies().readRuntimePoolReserves({ blockNumber, pools });
        },
        async readRuntimePoolQuotes(options) {
          runtimeQuoteReads += 1;
          expect(options.blockNumber).toBe(BigInt(SAFE_BLOCK));
          expect(options.requests).toHaveLength(3);
          expect(
            options.requests.some(
              (request) =>
                runtimeAmountOut(request) !==
                multiplyBeforeFeeDivisionAmountOut(request),
            ),
          ).toBe(true);
          return dependencies().readRuntimePoolQuotes(options);
        },
      }),
    );

    expect(reserveReads).toBe(1);
    expect(indexedPoolIds).not.toContain("aerodrome-v2-usdc-weth");
    expect(runtimePoolIds).toEqual(["aerodrome-v2-usdc-weth"]);
    expect(runtimeBlock).toBe(BigInt(SAFE_BLOCK));
    expect(runtimeQuoteReads).toBe(1);
    expect(snapshot.fields.marketplace.status).toBe("available");
    expect(snapshot.fields.liquidity.status).toBe("available");
    expect(snapshot.fields.quotes.defiBuyEth.status).toBe("available");
    expect(snapshot.fields.quotes.defiSellEth.status).toBe("available");
    expect(snapshot.fields.quotes.nftBuyEth.status).toBe("available");
    expect(snapshot.fields.quotes.defiBuyUsdc.status).toBe("available");
    expect(snapshot.fields.quotes.defiSellUsdc.status).toBe("available");
    expect(snapshot.fields.quotes.nftBuyUsdc.status).toBe("available");
  });

  test("rejects connector reserves captured at a different block", async () => {
    const snapshot = await produce(
      dependencies({
        async readRuntimePoolReserves(options) {
          const reserves =
            await dependencies().readRuntimePoolReserves(options);
          return reserves.map((state) => ({
            ...state,
            blockNumber: BigInt(SAFE_BLOCK - 1),
          }));
        },
      }),
    );

    expect(snapshot.fields.quotes.defiBuyUsdc).toEqual({
      status: "unavailable",
      reason: "invalid-pool-state",
    });
    expect(snapshot.fields.quotes.defiSellUsdc).toEqual({
      status: "unavailable",
      reason: "invalid-pool-state",
    });
    expect(snapshot.fields.quotes.nftBuyUsdc).toEqual({
      status: "unavailable",
      reason: "invalid-pool-state",
    });
    expect(snapshot.fields.quotes.defiBuyEth.status).toBe("available");
  });

  test("isolates a runtime quote mismatch to its leaf", async () => {
    const snapshot = await produce(
      dependencies({
        async readRuntimePoolQuotes({ requests }) {
          return requests.map((request) => ({
            quoteDefinitionId: request.quoteDefinitionId,
            status: "available" as const,
            blockNumber: BigInt(SAFE_BLOCK),
            amountOut:
              runtimeAmountOut(request) +
              (request.quoteDefinitionId === "defi-buy-usdc-v1" ? 1n : 0n),
          }));
        },
      }),
    );

    expect(snapshot.fields.quotes.defiBuyUsdc).toEqual({
      status: "unavailable",
      reason: "runtime-quote-mismatch",
    });
    expect(snapshot.fields.quotes.defiSellUsdc.status).toBe("available");
    expect(snapshot.fields.quotes.nftBuyUsdc.status).toBe("available");
    expect(snapshot.fields.quotes.defiBuyEth.status).toBe("available");
  });

  test("isolates a runtime quote from a different block to its leaf", async () => {
    const snapshot = await produce(
      dependencies({
        async readRuntimePoolQuotes({ requests }) {
          return requests.map((request) => ({
            quoteDefinitionId: request.quoteDefinitionId,
            status: "available" as const,
            blockNumber:
              request.quoteDefinitionId === "defi-buy-usdc-v1"
                ? BigInt(SAFE_BLOCK - 1)
                : BigInt(SAFE_BLOCK),
            amountOut: runtimeAmountOut(request),
          }));
        },
      }),
    );

    expect(snapshot.fields.quotes.defiBuyUsdc).toEqual({
      status: "unavailable",
      reason: "runtime-quote-mismatch",
    });
    expect(snapshot.fields.quotes.defiSellUsdc.status).toBe("available");
    expect(snapshot.fields.quotes.nftBuyUsdc.status).toBe("available");
  });

  test("isolates an unavailable runtime validation result to its leaf", async () => {
    const snapshot = await produce(
      dependencies({
        async readRuntimePoolQuotes({ requests }) {
          return requests.map((request) =>
            request.quoteDefinitionId === "defi-buy-usdc-v1"
              ? {
                  quoteDefinitionId: request.quoteDefinitionId,
                  status: "unavailable" as const,
                }
              : {
                  quoteDefinitionId: request.quoteDefinitionId,
                  status: "available" as const,
                  blockNumber: BigInt(SAFE_BLOCK),
                  amountOut: runtimeAmountOut(request),
                },
          );
        },
      }),
    );

    expect(snapshot.fields.quotes.defiBuyUsdc).toEqual({
      status: "unavailable",
      reason: "dependency-unavailable",
    });
    expect(snapshot.fields.quotes.defiSellUsdc.status).toBe("available");
    expect(snapshot.fields.quotes.nftBuyUsdc.status).toBe("available");
  });

  test("keeps independent same-block leaves current when marketplace fails", async () => {
    const snapshot = await produce(
      dependencies({
        async readMarketplace() {
          throw new Error("RPC endpoint with secret should not escape");
        },
      }),
    );

    expect(snapshot.fields.marketplace).toEqual({
      status: "unavailable",
      reason: "dependency-unavailable",
    });
    expect(snapshot.fields.quotes.defiBuyEth.status).toBe("available");
    expect(snapshot.fields.quotes.defiSellEth.status).toBe("available");
    expect(snapshot.fields.quotes.nftBuyEth).toEqual({
      status: "unavailable",
      reason: "invalid-marketplace-state",
    });
  });

  test("validates and refines a prior exact-target route/input as a warm start", async () => {
    const cold = await produce();
    const warm = await produce(dependencies(), cold);
    const coldBuy = cold.fields.quotes.defiBuyEth;
    const warmBuy = warm.fields.quotes.defiBuyEth;
    expect(coldBuy.status).toBe("available");
    expect(warmBuy.status).toBe("available");
    if (coldBuy.status !== "available" || warmBuy.status !== "available") {
      throw new Error("Expected available ETH buy quotes.");
    }
    expect(warmBuy.value).toEqual(coldBuy.value);
    expect(warmBuy.value).not.toHaveProperty("evaluations");
    expect(warmBuy.value).not.toHaveProperty("warmStartUsed");
  });

  test("turns a leaf deadline into explicit unavailability without rejecting the snapshot", async () => {
    const snapshot = await produce(
      dependencies({
        readMarketplace: () => new Promise(() => undefined),
      }),
      null,
      5,
    );
    expect(snapshot.fields.marketplace).toEqual({
      status: "unavailable",
      reason: "deadline-exceeded",
    });
    expect(snapshot.fields.quotes.defiSellEth.status).toBe("available");
  });

  test("marks captured-state mismatches unavailable instead of reusing an old value", async () => {
    const previous = await produce();
    const snapshot = await produce(
      dependencies({
        async readReserveStates() {
          const states = await dependencies().readReserveStates({
            poolIds: [],
          });
          return states.filter(
            ({ poolId }) => poolId !== "uniswap-v2-fame-direct",
          );
        },
      }),
      previous,
    );
    expect(snapshot.fields.quotes.defiBuyEth).toEqual({
      status: "unavailable",
      reason: "invalid-pool-state",
    });
    expect(snapshot.fields.quotes.defiBuyEth).not.toEqual(
      previous.fields.quotes.defiBuyEth,
    );
  });
});
