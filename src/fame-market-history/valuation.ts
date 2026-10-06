import type { Header, Scope } from "./model.ts";
import type { DecodedEvent, TokenMetadata } from "./decode.ts";
import { FAME_ADDRESS } from "./model.ts";

export const VALUATION_VERSION = "fame-valuation-v1";
export const WETH = "0x4200000000000000000000000000000000000006";
export const ETH_USD_FEED = "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70";
export const MAX_OBSERVATION_AGE = 1800;
const UNIT = 10n ** 18n;
export const decimal18 = (n: bigint) => {
  const s = n.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18)}`;
};
export const ROUTES: Record<string, string[]> = {
  [WETH]: [],
  "0xe5020a6d073a794b6e7f05678707de47986fb0b6": [
    "scale-equalizer-usdc-frxusd",
    "uniswap-v3-usdc-weth-5bps",
  ],
  "0x54016a4848a38f257b6e96331f7404073fd9c32c": [
    "scale-equalizer-usdc-scale",
    "uniswap-v3-usdc-weth-5bps",
  ],
  "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926": [
    "uniswap-v4-basedflick-zora",
    "uniswap-v3-zora-weth",
  ],
};
export interface ValuationSnapshot {
  version: typeof VALUATION_VERSION;
  block: Header;
  ethUsd: {
    feed: typeof ETH_USD_FEED;
    roundId: string;
    updatedAt: number;
    priceX18: string;
  } | null;
  quotes: Record<string, { ethX18: string; route: string[] } | null>;
  pools: Record<
    string,
    { balance0: string; balance1: string; quotePerFameX18: string } | null
  >;
}
export interface ConvertedCandle {
  currency: "ETH" | "USD";
  status: "complete" | "partial" | "unavailable";
  method: "execution-price-with-asof-fx";
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
  vwap: string | null;
  pricedBaseVolumeAtoms: string;
  unpricedBaseVolumeAtoms: string;
  pricedTradeCount: number;
  unpricedTradeCount: number;
  observationBlocks: number[];
}
export interface MarketLiquidity {
  method: "pool-custody-balances-at-pool-spot";
  status: "complete" | "partial" | "unavailable";
  eth: string | null;
  usd: string | null;
  pools: {
    poolId: string;
    blockNumber: number | null;
    timestamp: number | null;
    eth: string | null;
    usd: string | null;
  }[];
}
export function validateSnapshots(
  snapshots: ValuationSnapshot[],
  scope: Scope,
) {
  const unsigned = (n: unknown) =>
    typeof n === "string" && /^(0|[1-9][0-9]*)$/.test(n);
  const positive = (n: unknown) => unsigned(n) && n !== "0";
  for (const s of snapshots) {
    if (
      s.version !== VALUATION_VERSION ||
      !Number.isSafeInteger(s.block.number) ||
      s.block.number < 0 ||
      !Number.isSafeInteger(s.block.timestamp) ||
      s.block.timestamp < 0 ||
      !/^0x[0-9a-f]{64}$/.test(s.block.hash)
    )
      throw new Error("Invalid valuation snapshot");
    for (const [token, q] of Object.entries(s.quotes)) {
      if (
        !ROUTES[token] ||
        (q &&
          (JSON.stringify(q.route) !== JSON.stringify(ROUTES[token]) ||
            !positive(q.ethX18)))
      )
        throw new Error("Invalid valuation route");
    }
    if (
      s.ethUsd &&
      (s.ethUsd.feed !== ETH_USD_FEED ||
        !positive(s.ethUsd.priceX18) ||
        !positive(s.ethUsd.roundId) ||
        !Number.isSafeInteger(s.ethUsd.updatedAt) ||
        s.ethUsd.updatedAt <= 0 ||
        s.ethUsd.updatedAt > s.block.timestamp)
    )
      throw new Error("Invalid oracle observation");
    for (const [id, p] of Object.entries(s.pools))
      if (
        !scope.pools.some((p) => p.id === id) ||
        (p &&
          (![p.balance0, p.balance1].every(unsigned) ||
            !positive(p.quotePerFameX18)))
      )
        throw new Error("Invalid liquidity observation");
  }
}
export function valueBucket(
  scope: Scope,
  metadata: TokenMetadata,
  timestamp: number,
  trades: DecodedEvent[],
  snapshots: ValuationSnapshot[],
) {
  const ordered = [...snapshots].sort(
    (a, b) => b.block.number - a.block.number,
  );
  const asof = (time: number, beforeBlock = Number.MAX_SAFE_INTEGER) =>
    ordered.find(
      (s) =>
        s.block.number < beforeBlock &&
        s.block.timestamp <= time &&
        time - s.block.timestamp <= MAX_OBSERVATION_AGE,
    );
  const rate = (
    s: ValuationSnapshot | undefined,
    token: string,
    currency: "ETH" | "USD",
    time: number,
  ) => {
    const eth =
      token === WETH
        ? UNIT
        : s?.quotes[token]
          ? BigInt(s.quotes[token]!.ethX18)
          : null;
    if (currency === "ETH") return eth;
    return eth !== null &&
      s?.ethUsd &&
      time - s.ethUsd.updatedAt <= MAX_OBSERVATION_AGE
      ? (eth * BigInt(s.ethUsd.priceX18)) / UNIT
      : null;
  };
  const currencies = ["ETH", "USD"] as const;
  const prices: ConvertedCandle[] = currencies.map((currency) => {
    let open: bigint | null = null,
      high: bigint | null = null,
      low: bigint | null = null,
      close: bigint | null = null;
    let volume = 0n,
      priced = 0n,
      unpriced = 0n,
      pricedCount = 0,
      unpricedCount = 0;
    const blocks = new Set<number>();
    for (const e of trades) {
      const pool = scope.pools.find((p) => p.id === e.raw.poolId)!;
      const token = pool.token0 === FAME_ADDRESS ? pool.token1 : pool.token0;
      const sample = asof(e.raw.blockTimestamp, e.raw.blockNumber);
      const fx = rate(sample, token, currency, e.raw.blockTimestamp);
      if (fx === null || fx === 0n) {
        unpriced += BigInt(e.baseAtoms!);
        unpricedCount++;
        continue;
      }
      const p = (BigInt(e.priceX18!) * fx) / UNIT;
      if (p === 0n) {
        unpriced += BigInt(e.baseAtoms!);
        unpricedCount++;
        continue;
      }
      open ??= p;
      close = p;
      high = high === null || p > high ? p : high;
      low = low === null || p < low ? p : low;
      volume +=
        (BigInt(e.quoteAtoms!) * fx) / 10n ** BigInt(metadata.decimals[token]);
      priced += BigInt(e.baseAtoms!);
      pricedCount++;
      if (sample) blocks.add(sample.block.number);
    }
    return {
      currency,
      status: unpricedCount
        ? pricedCount
          ? "partial"
          : "unavailable"
        : "complete",
      method: "execution-price-with-asof-fx",
      open: open === null ? null : decimal18(open),
      high: high === null ? null : decimal18(high),
      low: low === null ? null : decimal18(low),
      close: close === null ? null : decimal18(close),
      volume: pricedCount || !unpricedCount ? decimal18(volume) : null,
      vwap: priced
        ? decimal18(
            (volume * 10n ** BigInt(metadata.decimals[FAME_ADDRESS])) / priced,
          )
        : null,
      pricedBaseVolumeAtoms: priced.toString(),
      unpricedBaseVolumeAtoms: unpriced.toString(),
      pricedTradeCount: pricedCount,
      unpricedTradeCount: unpricedCount,
      observationBlocks: [...blocks].sort((a, b) => a - b),
    };
  });
  const end = timestamp + 299,
    sample = asof(end);
  const pools = scope.pools.map((pool) => {
    const state = sample?.pools[pool.id];
    const token = pool.token0 === FAME_ADDRESS ? pool.token1 : pool.token0;
    const total = (currency: "ETH" | "USD") => {
      const fx = rate(sample, token, currency, end);
      if (!state || fx === null) return null;
      const base = BigInt(
        pool.token0 === FAME_ADDRESS ? state.balance0 : state.balance1,
      );
      const quote = BigInt(
        pool.token0 === FAME_ADDRESS ? state.balance1 : state.balance0,
      );
      const value =
        (quote * fx) / 10n ** BigInt(metadata.decimals[token]) +
        (base * BigInt(state.quotePerFameX18) * fx) /
          UNIT /
          10n ** BigInt(metadata.decimals[FAME_ADDRESS]);
      return decimal18(value);
    };
    return {
      poolId: pool.id,
      blockNumber: state ? sample!.block.number : null,
      timestamp: state ? sample!.block.timestamp : null,
      eth: total("ETH"),
      usd: total("USD"),
    };
  });
  const sum = (field: "eth" | "usd") => {
    const values = pools
      .map((p) => p[field])
      .filter((v): v is string => v !== null);
    return values.length
      ? decimal18(
          values.reduce((sum, v) => sum + BigInt(v.replace(".", "")), 0n),
        )
      : null;
  };
  const liquidity: MarketLiquidity = {
    method: "pool-custody-balances-at-pool-spot",
    status: pools.every((p) => p.eth !== null && p.usd !== null)
      ? "complete"
      : pools.some((p) => p.eth !== null || p.usd !== null)
        ? "partial"
        : "unavailable",
    eth: sum("eth"),
    usd: sum("usd"),
    pools,
  };
  return { prices, liquidity };
}
