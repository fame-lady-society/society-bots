import {
  createPublicClient,
  parseAbi,
  multicall3Abi,
  encodeFunctionData,
  decodeFunctionResult,
  type Abi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import type { Scope, Header } from "./model.ts";
import {
  sampledPolicy,
  fraction,
  type SampledObservation,
} from "./sampled-market.ts";

const abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
  "function liquidity() view returns (uint128)",
  "function getLiquidity(bytes32) view returns (uint128)",
]);
const slip = parseAbi([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)",
]);
export function sampledCalls(scope: Scope) {
  const policy = sampledPolicy(scope);
  const calls: {
    key: string;
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }[] = [];
  const add = (
    key: string,
    address: Address,
    functionName: string,
    args?: readonly unknown[],
    callAbi: Abi = abi,
  ) => calls.push({ key, address, abi: callAbi, functionName, args });
  for (const t of new Set(policy.sources.flatMap((p) => [p.token0, p.token1])))
    add(`decimals:${t}`, t, "decimals");
  for (const p of policy.sources) {
    if (
      ![
        "AerodromeV2",
        "UniswapV2",
        "Solidly",
        "UniswapV3",
        "Slipstream",
        "UniswapV4",
      ].includes(p.venueFamily)
    )
      throw new Error("Unsupported sampled family");
    if (p.venueFamily === "UniswapV4") {
      if (!p.stateViewAddress || !p.poolKey)
        throw new Error("Missing V4 snapshot identity");
      add(`${p.id}:state`, p.stateViewAddress, "getSlot0", [p.poolKey]);
      add(`${p.id}:liquidity`, p.stateViewAddress, "getLiquidity", [p.poolKey]);
    } else {
      if (!p.poolAddress) throw new Error("Missing snapshot address");
      add(`${p.id}:token0`, p.poolAddress, "token0");
      add(`${p.id}:token1`, p.poolAddress, "token1");
      if (["Solidly", "UniswapV2", "AerodromeV2"].includes(p.venueFamily))
        add(`${p.id}:state`, p.poolAddress, "getReserves");
      else {
        add(
          `${p.id}:state`,
          p.poolAddress,
          "slot0",
          undefined,
          p.venueFamily === "Slipstream" ? slip : abi,
        );
        add(`${p.id}:liquidity`, p.poolAddress, "liquidity");
      }
    }
    if (scope.pools.some((d) => d.id === p.id)) {
      if (!p.poolAddress) throw new Error("Unsupported singleton inventory");
      add(`${p.id}:balance0`, p.token0, "balanceOf", [p.poolAddress]);
      add(`${p.id}:balance1`, p.token1, "balanceOf", [p.poolAddress]);
    }
  }
  return calls;
}
export interface SampledEvidence {
  version: "fame-market-sampled-evidence-v1";
  policyRevision: string;
  timestamp: number;
  block: Header;
  after: Header;
  results: { success: boolean; returnData: Hex }[];
}
/** One shared, block-pinned Multicall. Only used by bounded local rehearsal yet. */
export function sampledReader(scope: Scope, transport: Transport) {
  const client = createPublicClient({ chain: base, transport });
  const calls = sampledCalls(scope),
    policy = sampledPolicy(scope);
  return async (
    timestamp: number,
    block: Header,
    after: Header,
  ): Promise<SampledEvidence> => {
    const results = await client.readContract({
      address: base.contracts.multicall3.address,
      abi: multicall3Abi,
      functionName: "aggregate3",
      blockNumber: BigInt(block.number),
      args: [
        calls.map((c) => ({
          target: c.address,
          allowFailure: true,
          callData: encodeFunctionData(c),
        })),
      ],
    });
    return {
      version: "fame-market-sampled-evidence-v1",
      policyRevision: policy.revision,
      timestamp,
      block,
      after,
      results: [...results],
    };
  };
}
/** Deterministic decode from retained raw return data; no RPC or oracle dependency. */
export function deriveSampledObservation(
  scope: Scope,
  e: SampledEvidence,
): SampledObservation {
  const policy = sampledPolicy(scope),
    calls = sampledCalls(scope);
  if (
    e.version !== "fame-market-sampled-evidence-v1" ||
    e.policyRevision !== policy.revision ||
    calls.length !== e.results.length
  )
    throw new Error("Sampled evidence contract mismatch");
  const values = new Map(
    calls.map((c, i) => [
      c.key,
      e.results[i].success
        ? decodeFunctionResult({ ...c, data: e.results[i].returnData })
        : null,
    ]),
  );
  const decimals: Record<string, number> = {};
  for (const token of new Set(
    policy.sources.flatMap((p) => [p.token0, p.token1]),
  )) {
    const d = values.get(`decimals:${token}`);
    if (d !== null) {
      if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 36)
        throw new Error("Invalid sampled decimals");
      // Reviewed eight-decimal quote assets; never treat cbBTC or SPX as 18 decimals.
      const expected =
        token === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
          ? 6
          : [
                "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
                "0x50da645f148798f68ef2d7db7c1cb22a6819bb2c",
              ].includes(token)
            ? 8
            : 18;
      if (d !== expected) throw new Error("Unreviewed sampled token decimals");
      decimals[token] = d;
    }
  }
  const rates: SampledObservation["rates"] = {},
    balances: SampledObservation["balances"] = {};
  for (const p of policy.sources) {
    rates[p.id] = null;
    const state = values.get(`${p.id}:state`),
      d0 = decimals[p.token0],
      d1 = decimals[p.token1];
    let identity = true;
    if (p.poolAddress)
      for (const key of ["token0", "token1"] as const) {
        const actual = values.get(`${p.id}:${key}`);
        if (actual === null) identity = false;
        else if (String(actual).toLowerCase() !== p[key])
          throw new Error("Sampled pool identity mismatch");
      }
    if (
      identity &&
      Array.isArray(state) &&
      d0 !== undefined &&
      d1 !== undefined
    ) {
      if (["Solidly", "UniswapV2", "AerodromeV2"].includes(p.venueFamily)) {
        const x = BigInt(state[0]) * 10n ** BigInt(d1),
          y = BigInt(state[1]) * 10n ** BigInt(d0);
        if (x > 0n && y > 0n)
          rates[p.id] = p.stable
            ? fraction(y * (3n * x * x + y * y), x * (x * x + 3n * y * y))
            : fraction(y, x);
      } else if (
        typeof values.get(`${p.id}:liquidity`) === "bigint" &&
        (values.get(`${p.id}:liquidity`) as bigint) > 0n &&
        BigInt(state[0]) > 0n
      ) {
        rates[p.id] = fraction(
          BigInt(state[0]) ** 2n * 10n ** BigInt(d0),
          2n ** 192n * 10n ** BigInt(d1),
        );
      }
    }
    if (scope.pools.some((d) => d.id === p.id)) {
      const a = values.get(`${p.id}:balance0`),
        b = values.get(`${p.id}:balance1`);
      balances[p.id] =
        identity && typeof a === "bigint" && typeof b === "bigint"
          ? { balance0: String(a), balance1: String(b) }
          : null;
    }
  }
  return {
    version: "fame-market-observation-v1",
    policyRevision: policy.revision,
    timestamp: e.timestamp,
    block: e.block,
    after: e.after,
    rates,
    balances,
    decimals,
  };
}
