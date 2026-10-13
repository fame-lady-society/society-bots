/** Verified creation receipts in docs/research/2026-10-10-pool-admission-origins.json.
 * Only isolated admission identities are affected; the production registry is unchanged. */
export const admissionOrigins: Record<
  string,
  { block: number; timestamp: number }
> = {
  "aerodrome-spx-fame": { block: 21194336, timestamp: 1729178019 },
  "aerodrome-cbbtc-fame": { block: 21374567, timestamp: 1729538481 },
  "uniswap-v3-usdc-cbbtc-5bps": { block: 19763050, timestamp: 1726315447 },
  "slipstream-spx-weth": { block: 20549217, timestamp: 1727887781 },
};
export const poolBorn = (
  id: string,
  block: number,
  origins = admissionOrigins,
) => !origins[id] || block >= origins[id].block;

// These origins are candidate-only: production and deployed early-job hashes stay fixed.
const remainingOrigins = {
  "scale-equalizer-scale-fame": {
    block: 22614190,
    timestamp: 1732017727,
  },
  "scale-equalizer-weth-fame": {
    block: 22613864,
    timestamp: 1732017075,
  },
  "slipstream-basedflick-fame": {
    block: 34552255,
    timestamp: 1755893857,
  },
  "scale-equalizer-frxusd-fame": {
    block: 43282547,
    timestamp: 1773354441,
  },
};
export function originsFor(scope: import("./model.ts").Scope) {
  return scope.registry.pools.some((p) => p.id === "aerodrome-cbbtc-fame")
    ? { ...admissionOrigins, ...remainingOrigins }
    : admissionOrigins;
}
