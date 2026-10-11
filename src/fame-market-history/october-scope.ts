/** Candidate-only registry. Never imported by production collection. */
import additions from "./isolated-pools.json" with { type: "json" };
import { parseFamePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { launchScope } from "./local-backfill.ts";
import { historyScope } from "./model.ts";
import type { TokenMetadata } from "./decode.ts";
export function octoberScope() {
  const source = launchScope();
  return historyScope(
    parseFamePoolStateRegistry({
      ...source.registry,
      pools: [...source.registry.pools, ...additions],
    }),
  );
}
export function octoberMetadata(source: TokenMetadata): TokenMetadata {
  return {
    ...source,
    decimals: {
      ...source.decimals,
      "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": 8,
      "0x50da645f148798f68ef2d7db7c1cb22a6819bb2c": 8,
    },
    poolTokens: Object.fromEntries(
      octoberScope().pools.map((p) => [
        p.id,
        { token0: p.token0, token1: p.token1 },
      ]),
    ),
  };
}
