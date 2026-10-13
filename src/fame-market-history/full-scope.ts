/** Candidate-only extension; existing registry entries retain their identities. */
import { octoberScope, octoberMetadata } from "./october-scope.ts";
import { fameHistoryRegistry } from "./registry.ts";
import { historyScope } from "./model.ts";
import type { TokenMetadata } from "./decode.ts";
export function fullScope() {
  const source = octoberScope();
  return historyScope({
    ...source.registry,
    pools: [
      ...source.registry.pools,
      ...fameHistoryRegistry.pools.filter(
        (p) => !source.registry.pools.some((s) => s.id === p.id),
      ),
    ],
  });
}
export function fullMetadata(source: TokenMetadata): TokenMetadata {
  const scope = fullScope();
  return {
    ...octoberMetadata(source),
    poolTokens: Object.fromEntries(
      scope.pools.map((p) => [p.id, { token0: p.token0, token1: p.token1 }]),
    ),
  };
}
