import type { DecodedEvent } from "./decode.ts";
import { FAME_ADDRESS, type Pool, type Scope } from "./model.ts";
import {
  add,
  decimal,
  fraction,
  multiply,
  invert,
  type Fraction,
} from "./price-math.ts";
import {
  sampledPolicy,
  conversionFor,
  type SampledObservation,
  type PoolActivity,
} from "./sampled-market.ts";
export type ActivityType = "buy" | "sell" | "add" | "remove";
export interface NativeActivityEvent {
  id: string;
  poolId: string;
  type: ActivityType;
  eventName: string;
  timestamp: number;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  fameAtoms: string;
  quoteAtoms: string;
  quoteToken: string;
  sender: string | null;
  recipient: string | null;
  owner: string | null;
}
/** Economic actions only. Sync/Initialize and Collect/Fees are not additional liquidity changes. */
export function activityEvent(
  event: DecodedEvent,
  pool: Pool,
): NativeActivityEvent | null {
  const { raw, args: a } = event,
    baseIs0 = pool.token0 === FAME_ADDRESS;
  let type: ActivityType, base: string, quote: string;
  if (event.classification === "trade") {
    const signed =
      pool.venueFamily === "Slipstream"
        ? BigInt(baseIs0 ? a.amount0 : a.amount1)
        : BigInt(baseIs0 ? a.amount0In : a.amount1In) -
          BigInt(baseIs0 ? a.amount0Out : a.amount1Out);
    type = signed < 0n ? "buy" : "sell";
    base = event.baseAtoms!;
    quote = event.quoteAtoms!;
  } else if (event.eventName === "Mint" || event.eventName === "Burn") {
    if (pool.venueFamily === "Slipstream" && BigInt(a.amount) === 0n)
      return null; // fee-accounting poke
    base = baseIs0 ? a.amount0 : a.amount1;
    quote = baseIs0 ? a.amount1 : a.amount0;
    if (BigInt(base) === 0n && BigInt(quote) === 0n) return null;
    type = event.eventName === "Mint" ? "add" : "remove";
  } else return null;
  return {
    id: `8453:${raw.blockHash}:${raw.logIndex}`,
    poolId: pool.id,
    type,
    eventName: event.eventName!,
    timestamp: raw.blockTimestamp,
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash,
    transactionHash: raw.transactionHash,
    transactionIndex: raw.transactionIndex,
    logIndex: raw.logIndex,
    fameAtoms: base,
    quoteAtoms: quote,
    quoteToken: baseIs0 ? pool.token1 : pool.token0,
    sender: a.sender ?? null,
    recipient: a.to ?? a.recipient ?? null,
    owner: a.owner ?? null,
  };
}
export function valuedActivity(
  scope: Scope,
  observation: SampledObservation,
  rows: PoolActivity[],
) {
  const policy = sampledPolicy(scope);
  return rows
    .flatMap((row) =>
      (row.activityEvents ?? []).map((event) => {
        const pool = scope.pools.find((p) => p.id === event.poolId)!;
        const fd = observation.decimals[FAME_ADDRESS],
          qd = observation.decimals[event.quoteToken];
        if (fd === undefined || qd === undefined)
          throw new Error("Missing activity decimals");
        const fame = fraction(BigInt(event.fameAtoms), 10n ** BigInt(fd)),
          quote = fraction(BigInt(event.quoteAtoms), 10n ** BigInt(qd));
        const r = observation.rates[pool.id],
          mark = r ? (pool.token0 === FAME_ADDRESS ? r : invert(r)) : null;
        const values = Object.fromEntries(
          (["ETH", "USDC"] as const).map((currency) => {
            const fx = conversionFor(policy, pool, currency, observation);
            let size: Fraction | null = quote;
            if (event.type === "add" || event.type === "remove")
              size = mark ? add(multiply(fame, mark), quote) : null;
            return [currency, size && fx ? decimal(multiply(size, fx)) : null];
          }),
        ) as Record<"ETH" | "USDC", string | null>;
        return {
          ...event,
          fameDecimals: fd,
          quoteDecimals: qd,
          values,
          valuationTimestamp: observation.timestamp + 300,
          valuationMethod: "bucket-end-spot" as const,
        };
      }),
    )
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
}
export type ActivityRow = ReturnType<typeof valuedActivity>[number];
