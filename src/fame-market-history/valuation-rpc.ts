import {
  createPublicClient,
  parseAbi,
  multicall3Abi,
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
  type Address,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import { FAME_ADDRESS, type Header, type Scope } from "./model.ts";
import {
  ETH_USD_FEED,
  ROUTES,
  VALUATION_VERSION,
  WETH,
  type ValuationSnapshot,
} from "./valuation.ts";

const abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
  "function liquidity() view returns (uint128)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const slipAbi = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)",
]);
type Contract = {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
};
const UNIT = 10n ** 18n;
/** Stable x^3*y+x*y^3 invariant's marginal quote, not the reserve ratio. */
export function reservePrice(
  r0: bigint,
  r1: bigint,
  d0: number,
  d1: number,
  stable: boolean,
) {
  const x = (r0 * UNIT) / 10n ** BigInt(d0),
    y = (r1 * UNIT) / 10n ** BigInt(d1);
  if (!x || !y) return 0n;
  return stable
    ? (y * (3n * x * x + y * y) * UNIT) / (x * (x * x + 3n * y * y))
    : (y * UNIT) / x;
}

/** All connector and custody reads share one Multicall at one finalized block.
 * Reverts are explicit missing observations; transport failures propagate. */
export function valuationReader(scope: Scope, transport: Transport) {
  const client = createPublicClient({ chain: base, transport });
  const ids = new Set([
    ...scope.pools.map((p) => p.id),
    ...Object.values(ROUTES).flat(),
  ]);
  const pools = [...ids].map((id) => {
    const pool = scope.registry.pools.find((p) => p.id === id);
    if (!pool || (!pool.poolAddress && !pool.stateViewAddress))
      throw new Error("Valuation route is absent from registry");
    return pool;
  });
  for (const [token, route] of Object.entries(ROUTES)) {
    let current = token;
    for (const id of route) {
      const p = pools.find((p) => p.id === id)!;
      if (
        [p.token0, p.token1].includes(FAME_ADDRESS) ||
        ![p.token0, p.token1].includes(current as Address)
      )
        throw new Error("Circular or disconnected valuation route");
      current = p.token0 === current ? p.token1 : p.token0;
    }
    if (current !== WETH || route.length > 2)
      throw new Error("Invalid ETH valuation route");
  }
  return async (block: Header): Promise<ValuationSnapshot> => {
    const calls: { key: string; contract: Contract }[] = [];
    const add = (
      key: string,
      address: Address,
      functionName: string,
      args?: readonly unknown[],
      callAbi: Abi = abi,
    ) =>
      calls.push({
        key,
        contract: {
          address,
          abi: callAbi,
          functionName,
          ...(args ? { args } : {}),
        },
      });
    const tokens = [...new Set(pools.flatMap((p) => [p.token0, p.token1]))];
    tokens.forEach((t) => add(`decimals:${t}`, t, "decimals"));
    for (const p of pools) {
      if (p.poolAddress) {
        add(`${p.id}:token0`, p.poolAddress, "token0");
        add(`${p.id}:token1`, p.poolAddress, "token1");
      }
      if (p.venueFamily === "Solidly" || p.venueFamily === "UniswapV2")
        add(p.id, p.poolAddress!, "getReserves");
      else if (p.venueFamily === "UniswapV4")
        add(p.id, p.stateViewAddress!, "getSlot0", [p.poolKey]);
      else
        add(
          p.id,
          p.poolAddress!,
          "slot0",
          undefined,
          p.venueFamily === "Slipstream" ? slipAbi : abi,
        );
      if (scope.pools.some((d) => d.id === p.id)) {
        add(`${p.id}:balance0`, p.token0, "balanceOf", [p.poolAddress]);
        add(`${p.id}:balance1`, p.token1, "balanceOf", [p.poolAddress]);
      }
      if (p.venueFamily === "UniswapV4")
        add(`${p.id}:liquidity`, p.stateViewAddress!, "getLiquidity", [
          p.poolKey,
        ]);
      else if (p.venueFamily === "UniswapV3" || p.venueFamily === "Slipstream")
        add(`${p.id}:liquidity`, p.poolAddress!, "liquidity");
    }
    add("oracle", ETH_USD_FEED, "latestRoundData");
    add("oracleDecimals", ETH_USD_FEED, "decimals");
    const results = await client.readContract({
      address: base.contracts.multicall3.address,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [
        calls.map(({ contract: c }) => ({
          target: c.address,
          allowFailure: true,
          callData: encodeFunctionData(c),
        })),
      ],
      blockNumber: BigInt(block.number),
    });
    const values = new Map(
      calls.map((c, i) => [
        c.key,
        results[i].success
          ? decodeFunctionResult({ ...c.contract, data: results[i].returnData })
          : null,
      ]),
    );
    const decimals = (token: string) => {
      const d = values.get(`decimals:${token}`);
      if (
        d !== null &&
        d !== (token === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ? 6 : 18)
      )
        throw new Error(
          "Valuation token decimals differ from reviewed metadata",
        );
      return typeof d === "number" && d >= 0 && d <= 36 ? d : null;
    };
    const rates = new Map<string, bigint>();
    for (const p of pools) {
      const state = values.get(p.id),
        d0 = decimals(p.token0),
        d1 = decimals(p.token1);
      if (!Array.isArray(state) || d0 === null || d1 === null) continue;
      if (
        ["UniswapV4", "UniswapV3", "Slipstream"].includes(p.venueFamily) &&
        !(
          typeof values.get(`${p.id}:liquidity`) === "bigint" &&
          (values.get(`${p.id}:liquidity`) as bigint) > 0n
        )
      )
        continue;
      if (
        p.poolAddress &&
        (values.get(`${p.id}:token0`) === null ||
          values.get(`${p.id}:token1`) === null)
      )
        continue;
      if (
        p.poolAddress &&
        (String(values.get(`${p.id}:token0`)).toLowerCase() !== p.token0 ||
          String(values.get(`${p.id}:token1`)).toLowerCase() !== p.token1)
      )
        throw new Error("Valuation pool identity differs from registry");
      const rate =
        p.venueFamily === "Solidly" || p.venueFamily === "UniswapV2"
          ? reservePrice(
              BigInt(state[0]),
              BigInt(state[1]),
              d0,
              d1,
              p.stable === true,
            )
          : (BigInt(state[0]) ** 2n * 10n ** BigInt(d0) * UNIT) /
            (2n ** 192n * 10n ** BigInt(d1));
      if (rate > 0n) rates.set(p.id, rate);
    }
    const quotes: ValuationSnapshot["quotes"] = {};
    for (const [token, route] of Object.entries(ROUTES)) {
      let current = token,
        rate = UNIT;
      for (const id of route) {
        const p = pools.find((p) => p.id === id)!,
          r = rates.get(id);
        if (!r) {
          rate = 0n;
          break;
        }
        rate = (rate * (p.token0 === current ? r : (UNIT * UNIT) / r)) / UNIT;
        current = p.token0 === current ? p.token1 : p.token0;
      }
      quotes[token] = rate > 0n ? { ethX18: rate.toString(), route } : null;
    }
    const liquidity: ValuationSnapshot["pools"] = {};
    for (const pool of scope.pools) {
      const r = rates.get(pool.id),
        b0 = values.get(`${pool.id}:balance0`),
        b1 = values.get(`${pool.id}:balance1`);
      const mark = r
        ? pool.token0 === FAME_ADDRESS
          ? r
          : (UNIT * UNIT) / r
        : 0n;
      liquidity[pool.id] =
        mark > 0n && typeof b0 === "bigint" && typeof b1 === "bigint"
          ? {
              balance0: b0.toString(),
              balance1: b1.toString(),
              quotePerFameX18: mark.toString(),
            }
          : null;
    }
    const oracle = values.get("oracle");
    const ethUsd: ValuationSnapshot["ethUsd"] =
      Array.isArray(oracle) &&
      values.get("oracleDecimals") === 8 &&
      oracle[1] > 0n &&
      oracle[3] > 0n &&
      oracle[3] <= BigInt(block.timestamp) &&
      oracle[4] >= oracle[0]
        ? {
            feed: ETH_USD_FEED,
            roundId: String(oracle[0]),
            updatedAt: Number(oracle[3]),
            priceX18: (BigInt(oracle[1]) * 10n ** 10n).toString(),
          }
        : null;
    return {
      version: VALUATION_VERSION,
      block,
      ethUsd,
      quotes,
      pools: liquidity,
    };
  };
}
