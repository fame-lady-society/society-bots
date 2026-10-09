import { decodeEventLog, parseAbi, toEventSelector, type AbiEvent } from "viem";
import {
  FAME_ADDRESS,
  integer,
  type ArchivedLog,
  type Pool,
  type Scope,
} from "./model.ts";

export const DECODER_VERSION = "fame-execution-v1";
export const PRICE_SCALE = 18;
const v2 = [
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "event Mint(address indexed sender,uint256 amount0,uint256 amount1)",
  "event Burn(address indexed sender,uint256 amount0,uint256 amount1,address indexed to)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
] as const;
// Uniswap V3 and Slipstream share these event layouts (not their slot0 ABI).
const concentrated = parseAbi([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  "event Initialize(uint160 sqrtPriceX96,int24 tick)",
  "event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Burn(address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "event Collect(address indexed owner,address recipient,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount0,uint128 amount1)",
]);
export const EVENT_ABIS = {
  UniswapV2: parseAbi([...v2, "event Sync(uint112 reserve0,uint112 reserve1)"]),
  Solidly: parseAbi([
    ...v2,
    "event Sync(uint256 reserve0,uint256 reserve1)",
    "event Fees(address indexed sender,uint256 amount0,uint256 amount1)",
    "event Claim(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1)",
  ]),
  Slipstream: concentrated,
  UniswapV3: [
    ...concentrated,
    ...parseAbi([
      "event CollectProtocol(address indexed sender,address indexed recipient,uint128 amount0,uint128 amount1)",
      "event Flash(address indexed sender,address indexed recipient,uint256 amount0,uint256 amount1,uint256 paid0,uint256 paid1)",
      "event IncreaseObservationCardinalityNext(uint16 observationCardinalityNextOld,uint16 observationCardinalityNextNew)",
      "event SetFeeProtocol(uint8 feeProtocol0Old,uint8 feeProtocol1Old,uint8 feeProtocol0New,uint8 feeProtocol1New)",
    ]),
  ],
};
export interface TokenMetadata {
  chainId: 8453;
  blockNumber: number;
  blockHash: string;
  decimals: Record<string, number>;
  poolTokens: Record<string, { token0: string; token1: string }>;
  /** Family sources + live samples are not full deployed bytecode verification. */
  decoderReview: "provisional";
}
export interface DecodedEvent {
  raw: ArchivedLog;
  eventName: string | null;
  classification:
    | "trade"
    | "liquidity"
    | "auxiliary"
    | "unknown"
    | "invalid-trade";
  args: Record<string, string>;
  baseAtoms: string | null;
  quoteAtoms: string | null;
  priceX18: string | null;
}

export function validateMetadata(scope: Scope, metadata: TokenMetadata) {
  if (
    metadata.chainId !== 8453 ||
    !/^0x[0-9a-f]{64}$/.test(metadata.blockHash) ||
    metadata.decoderReview !== "provisional"
  )
    throw new Error("Invalid token metadata provenance");
  integer(metadata.blockNumber, "metadata block", 1);
  for (const pool of scope.pools) {
    const tokens = metadata.poolTokens[pool.id];
    if (
      !tokens ||
      tokens.token0 !== pool.token0 ||
      tokens.token1 !== pool.token1
    )
      throw new Error("On-chain token order differs from registry");
    for (const token of [pool.token0, pool.token1]) {
      if (integer(metadata.decimals[token], "token decimals") > 36)
        throw new Error("Token decimals exceed supported precision");
    }
    if (!(pool.venueFamily in EVENT_ABIS))
      throw new Error("Unsupported history decoder family");
  }
}

export function decode(
  log: ArchivedLog,
  pool: Pool,
  metadata: TokenMetadata,
): DecodedEvent {
  const result: DecodedEvent = {
    raw: log,
    eventName: null,
    classification: "unknown",
    args: {},
    baseAtoms: null,
    quoteAtoms: null,
    priceX18: null,
  };
  const abi = EVENT_ABIS[pool.venueFamily as keyof typeof EVENT_ABIS];
  const event = (abi as readonly AbiEvent[]).find(
    (item) => toEventSelector(item) === log.topics[0],
  );
  if (!event) return result;
  // These supported events contain only static ABI words. Reject extensions or
  // malformed layouts instead of letting a permissive decoder ignore bytes.
  const indexed = event.inputs.filter((input) => input.indexed).length;
  if (
    log.topics.length !== indexed + 1 ||
    log.data.length !== 2 + (event.inputs.length - indexed) * 64
  )
    throw new Error("Known event has an unexpected ABI layout");
  const decoded = decodeEventLog({
    abi: [event],
    topics: log.topics as [(typeof log.topics)[0], ...typeof log.topics],
    data: log.data,
    strict: true,
  });
  result.eventName = event.name;
  result.args = Object.fromEntries(
    Object.entries(decoded.args ?? {}).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
  if (event.name !== "Swap") {
    result.classification = [
      "Transfer",
      "Approval",
      "Claim",
      "Fees",
      "CollectProtocol",
      "Flash",
      "IncreaseObservationCardinalityNext",
      "SetFeeProtocol",
    ].includes(event.name)
      ? "auxiliary"
      : "liquidity";
    return result;
  }
  const a = result.args;
  let amount0: bigint, amount1: bigint;
  if (["Slipstream", "UniswapV3"].includes(pool.venueFamily)) {
    amount0 = BigInt(a.amount0);
    amount1 = BigInt(a.amount1);
  } else {
    const [in0, in1, out0, out1] = [
      a.amount0In,
      a.amount1In,
      a.amount0Out,
      a.amount1Out,
    ].map(BigInt);
    // Multi-leg flash accounting is ambiguous for a single execution price.
    if (
      !(
        (in0 > 0n && out1 > 0n && in1 === 0n && out0 === 0n) ||
        (in1 > 0n && out0 > 0n && in0 === 0n && out1 === 0n)
      )
    )
      return { ...result, classification: "invalid-trade" };
    amount0 = in0 - out0;
    amount1 = in1 - out1;
  }
  if (amount0 * amount1 >= 0n)
    return { ...result, classification: "invalid-trade" };
  const absolute = (n: bigint) => (n < 0n ? -n : n);
  const baseIs0 = pool.token0 === FAME_ADDRESS;
  const baseAtoms = absolute(baseIs0 ? amount0 : amount1),
    quoteAtoms = absolute(baseIs0 ? amount1 : amount0);
  const baseDecimals = metadata.decimals[FAME_ADDRESS];
  const quoteDecimals = metadata.decimals[baseIs0 ? pool.token1 : pool.token0];
  // Integer division: explicitly round down to 18 price decimals, never DOUBLE.
  const scaled =
    (quoteAtoms * 10n ** BigInt(baseDecimals + PRICE_SCALE)) /
    (baseAtoms * 10n ** BigInt(quoteDecimals));
  if (scaled === 0n || scaled >= 10n ** 38n)
    return { ...result, classification: "invalid-trade" };
  return {
    ...result,
    classification: "trade",
    baseAtoms: String(baseAtoms),
    quoteAtoms: String(quoteAtoms),
    priceX18: String(scaled),
  };
}
