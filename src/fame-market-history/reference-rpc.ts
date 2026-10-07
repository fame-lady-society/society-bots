import {
  createPublicClient,
  parseAbi,
  multicall3Abi,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import type { Header, Scope } from "./model.ts";
import { FAME_ADDRESS } from "./model.ts";
import { ETH_USD_FEED, MAX_OBSERVATION_AGE } from "./valuation.ts";
import { reservePrice } from "./valuation-rpc.ts";
import {
  FAME_REFERENCE_POOL,
  ETH_REFERENCE_POOL,
  USDC,
  WETH,
  validateEvidence,
  valueFromRate,
  type ReferenceEvidence,
  type ReferencePoint,
} from "./reference.ts";
export const referenceAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint256,uint256,uint256)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const abi = referenceAbi;
const UNIT = 10n ** 18n;
export function referenceCalls(scope: Scope) {
  const fame = scope.registry.pools.find((p) => p.id === FAME_REFERENCE_POOL)!;
  const eth = scope.registry.pools.find((p) => p.id === ETH_REFERENCE_POOL)!;
  if (
    !fame?.poolAddress ||
    !eth?.poolAddress ||
    fame.venueFamily !== "Solidly" ||
    eth.venueFamily !== "UniswapV3" ||
    ![fame.token0, fame.token1].includes(FAME_ADDRESS) ||
    ![fame.token0, fame.token1].includes(WETH) ||
    ![eth.token0, eth.token1].includes(WETH) ||
    ![eth.token0, eth.token1].includes(USDC)
  )
    throw new Error("Unexpected reference identities");
  return [
    { address: FAME_ADDRESS, functionName: "decimals" },
    { address: WETH, functionName: "decimals" },
    { address: USDC, functionName: "decimals" },
    { address: fame.poolAddress, functionName: "token0" },
    { address: fame.poolAddress, functionName: "token1" },
    { address: fame.poolAddress, functionName: "getReserves" },
    { address: eth.poolAddress, functionName: "token0" },
    { address: eth.poolAddress, functionName: "token1" },
    { address: eth.poolAddress, functionName: "slot0" },
    { address: eth.poolAddress, functionName: "liquidity" },
    { address: ETH_USD_FEED, functionName: "decimals" },
    { address: ETH_USD_FEED, functionName: "latestRoundData" },
  ] as const;
}
export function referenceReader(scope: Scope, transport: Transport) {
  const client = createPublicClient({ chain: base, transport });
  const calls = referenceCalls(scope);
  return async (block: Header): Promise<ReferenceEvidence["results"]> => {
    const result = await client.readContract({
      address: base.contracts.multicall3.address,
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [
        calls.map((c) => ({
          target: c.address as Address,
          allowFailure: true,
          callData: encodeFunctionData({ abi, functionName: c.functionName }),
        })),
      ],
      blockNumber: BigInt(block.number),
    });
    return result.map((r) => ({
      success: r.success,
      returnData: r.returnData,
    }));
  };
}
/** Recompute solely from archived ABI results; no network or current state. */
export function deriveReference(
  e: ReferenceEvidence,
  scope: Scope,
): ReferencePoint {
  validateEvidence(e, scope);
  const calls = referenceCalls(scope);
  if (e.results.length !== calls.length)
    throw new Error("Reference result count mismatch");
  const v = e.results.map((r, i) =>
    r.success
      ? decodeFunctionResult({
          abi,
          functionName: calls[i].functionName,
          data: r.returnData,
        })
      : null,
  );
  for (const [index, expected] of [
    [0, 18],
    [1, 18],
    [2, 6],
    [10, 8],
  ] as const)
    if (v[index] !== null && v[index] !== expected)
      throw new Error("Reference decimals mismatch");
  const fame = scope.registry.pools.find((p) => p.id === FAME_REFERENCE_POOL)!;
  const eth = scope.registry.pools.find((p) => p.id === ETH_REFERENCE_POOL)!;
  for (const [index, expected] of [
    [3, fame.token0],
    [4, fame.token1],
    [6, eth.token0],
    [7, eth.token1],
  ] as const)
    if (v[index] !== null && String(v[index]).toLowerCase() !== expected)
      throw new Error("Reference token order mismatch");
  const fresh = e.timestamp + 299 - e.block.timestamp <= MAX_OBSERVATION_AGE;
  let fameEth: bigint | null = null,
    ethUsdc: bigint | null = null,
    ethUsd: bigint | null = null;
  const reserves = v[5];
  if (
    fresh &&
    v[0] !== null &&
    v[1] !== null &&
    v[3] !== null &&
    v[4] !== null &&
    Array.isArray(reserves)
  ) {
    const baseIs0 = fame.token0 === FAME_ADDRESS;
    fameEth = reservePrice(
      BigInt(reserves[baseIs0 ? 0 : 1]),
      BigInt(reserves[baseIs0 ? 1 : 0]),
      18,
      18,
      fame.stable === true,
    );
  }
  const slot = v[8];
  if (
    fresh &&
    v[1] !== null &&
    v[2] !== null &&
    v[6] !== null &&
    v[7] !== null &&
    typeof v[9] === "bigint" &&
    v[9] > 0n &&
    Array.isArray(slot)
  ) {
    const sqrt = BigInt(slot[0]);
    if (
      sqrt >= 4295128739n &&
      sqrt < 1461446703485210103287273052203988822378723970342n &&
      slot[6] === true
    )
      ethUsdc =
        eth.token0 === WETH
          ? (sqrt * sqrt * 10n ** 30n) / 2n ** 192n
          : (2n ** 192n * 10n ** 30n) / (sqrt * sqrt);
  }
  let oracle: ReferencePoint["oracle"] = null;
  const round = v[11];
  let staleOracle = false;
  if (v[10] !== null && Array.isArray(round)) {
    const [roundId, answer, , updatedAt, answeredInRound] = round.map(BigInt);
    if (
      roundId > 0n &&
      answer > 0n &&
      updatedAt > 0n &&
      updatedAt <= BigInt(e.block.timestamp) &&
      answeredInRound >= roundId
    ) {
      oracle = { roundId: String(roundId), updatedAt: Number(updatedAt) };
      staleOracle = e.timestamp + 299 - Number(updatedAt) > MAX_OBSERVATION_AGE;
      if (fresh && !staleOracle) ethUsd = answer * 10n ** 10n;
    }
  }
  const product = (a: bigint | null, b: bigint | null) =>
    a !== null && b !== null ? (a * b) / UNIT : null;
  const missing = fresh ? "source-unavailable" : "stale-source";
  return {
    method: "designated-pool-spot-with-asof-fx",
    policyRevision: e.policyRevision,
    sampledBlock: e.block.number,
    sampledBlockHash: e.block.hash,
    sampledAt: e.block.timestamp,
    oracle,
    values: {
      fameEth: valueFromRate(fameEth, missing),
      ethUsd: valueFromRate(ethUsd, staleOracle ? "stale-source" : missing),
      ethUsdc: valueFromRate(ethUsdc, missing),
      fameUsd: valueFromRate(
        product(fameEth, ethUsd),
        !fresh || staleOracle ? "stale-source" : missing,
      ),
      fameUsdc: valueFromRate(product(fameEth, ethUsdc), missing),
    },
  };
}
