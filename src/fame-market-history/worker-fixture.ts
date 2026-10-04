/** Deterministic collector-produced evidence for crash/retry rehearsals. No RPC. */
import {
  encodeAbiParameters,
  parseAbiParameters,
  padHex,
  toEventSelector,
  type Hex,
} from "viem";
import { famePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { collect } from "./collector.ts";
import { historyScope, FAME_ADDRESS, type Manifest } from "./model.ts";
import { EVENT_ABIS, type TokenMetadata } from "./decode.ts";

export const scope = historyScope(famePoolStateRegistry);
export const pool = scope.pools.find((p) => p.venueFamily === "Solidly")!;
export const epoch = 1800000000;
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
) {
  let bytes!: Uint8Array, manifest!: Manifest;
  const base = 10n ** 18n,
    quote = price * base;
  await collect({
    scope,
    startBlock: from,
    maxBlocks: to - from + 1,
    maxEvents: 10,
    chain: {
      finalized: async () => header(to),
      header: async (n) => header(n),
      logs: async () =>
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
    },
    store: {
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
