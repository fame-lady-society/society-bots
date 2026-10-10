/** Deterministic collector-produced evidence for crash/retry rehearsals. No RPC. */
import {
  encodeAbiParameters,
  parseAbiParameters,
  padHex,
  toEventSelector,
  type Hex,
} from "viem";
import { fameHistoryRegistry } from "./registry.ts";
import { collect } from "./collector.ts";
import { historyScope, FAME_ADDRESS, type Manifest } from "./model.ts";
import { EVENT_ABIS, type TokenMetadata } from "./decode.ts";
import {
  VALUATION_VERSION,
  ETH_USD_FEED,
  ROUTES,
  WETH,
  type ValuationSnapshot,
} from "./valuation.ts";

export const scope = historyScope(fameHistoryRegistry);
export const pool = scope.pools.find((p) => p.venueFamily === "Solidly")!;
export const epoch = 1700000100;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const header = (n: number) => ({
  number: n,
  hash: h(n),
  parentHash: h(n - 1),
  timestamp: epoch + (n - 100) * 60,
});
export const metadata: TokenMetadata = {
  chainId: 8453,
  blockNumber: 100,
  blockHash: h(100),
  decoderReview: "provisional",
  decimals: Object.fromEntries(
    scope.pools.flatMap((p) => [p.token0, p.token1]).map((t) => [t, 18]),
  ),
  poolTokens: Object.fromEntries(
    scope.pools.map((p) => [p.id, { token0: p.token0, token1: p.token1 }]),
  ),
};

export async function fixtureRange(
  from: number,
  to: number,
  tradeBlock?: number,
  price = 2n,
  timeShift = 0,
  withValuation = false,
) {
  let bytes!: Uint8Array, manifest!: Manifest;
  const shiftedHeader = (n: number) => ({
    ...header(n),
    timestamp: header(n).timestamp + timeShift,
  });
  const base = 10n ** 18n,
    quote = price * base;
  await collect({
    scope,
    startBlock: from,
    maxBlocks: to - from + 1,
    maxEvents: 10,
    chain: {
      ...(withValuation
        ? {
            valuation: async (
              block: ValuationSnapshot["block"],
            ): Promise<ValuationSnapshot> => ({
              version: VALUATION_VERSION,
              block,
              ethUsd: {
                feed: ETH_USD_FEED,
                roundId: "1",
                updatedAt: block.timestamp - 10,
                priceX18: (2000n * 10n ** 18n).toString(),
              },
              quotes: Object.fromEntries(
                Object.entries(ROUTES).map(([token, route]) => [
                  token,
                  {
                    route,
                    ethX18: (token === WETH
                      ? 10n ** 18n
                      : 5n * 10n ** 14n
                    ).toString(),
                  },
                ]),
              ),
              pools: Object.fromEntries(
                scope.pools.map((p) => [
                  p.id,
                  {
                    balance0: (10n ** 18n).toString(),
                    balance1: (10n ** 18n).toString(),
                    quotePerFameX18: (2n * 10n ** 18n).toString(),
                  },
                ]),
              ),
            }),
          }
        : {}),
      finalized: async () => shiftedHeader(to),
      header: async (n) => shiftedHeader(n),
      logs: async () => ({
        throughBlock: to,
        logs:
          tradeBlock === undefined
            ? []
            : [
                {
                  address: pool.address,
                  blockNumber: tradeBlock,
                  blockHash: h(tradeBlock),
                  transactionHash: h(1000 + tradeBlock),
                  transactionIndex: 0,
                  logIndex: 0,
                  removed: false,
                  topics: [
                    toEventSelector(
                      EVENT_ABIS.Solidly.find((e) => e.name === "Swap")!,
                    ),
                    padHex(pool.address, { size: 32 }),
                    padHex(pool.address, { size: 32 }),
                  ],
                  data: encodeAbiParameters(
                    parseAbiParameters("uint256,uint256,uint256,uint256"),
                    pool.token0 === FAME_ADDRESS
                      ? [base, 0n, 0n, quote]
                      : [quote, 0n, 0n, base],
                  ),
                },
              ],
      }),
    },
    store: {
      reduceRange: async () => {
        throw new Error("Unexpected capacity yield in fixture");
      },
      cursor: async () => ({
        startBlock: from,
        nextBlock: from,
        previousHash: null,
      }),
      upload: async (_, value) => {
        bytes = value;
      },
      commit: async (value) => {
        manifest = value;
      },
    },
  });
  return { manifest, bytes };
}
