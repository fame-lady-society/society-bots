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
export const poolBorn = (id: string, block: number) =>
  !admissionOrigins[id] || block >= admissionOrigins[id].block;
