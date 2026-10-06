import { digest, type Scope } from "./model.ts";
import { DECODER_VERSION, type TokenMetadata } from "./decode.ts";
import { MARKET_VERSION } from "./market.ts";
import {
  VALUATION_VERSION,
  ROUTES,
  ETH_USD_FEED,
  MAX_OBSERVATION_AGE,
} from "./valuation.ts";
export function servingRevision(scope: Scope, metadata: TokenMetadata) {
  const ids = new Set([
    ...scope.pools.map((p) => p.id),
    ...Object.values(ROUTES).flat(),
  ]);
  return digest(
    JSON.stringify({
      decoder: DECODER_VERSION,
      market: MARKET_VERSION,
      valuation: VALUATION_VERSION,
      metadata,
      oracle: ETH_USD_FEED,
      maxObservationAge: MAX_OBSERVATION_AGE,
      routes: ROUTES,
      sources: scope.registry.pools
        .filter((p) => ids.has(p.id))
        .map((p) => ({
          id: p.id,
          token0: p.token0,
          token1: p.token1,
          poolAddress: p.poolAddress,
          poolKey: p.poolKey,
          stateViewAddress: p.stateViewAddress,
          stable: p.stable,
          venueFamily: p.venueFamily,
        })),
    }),
  );
}
