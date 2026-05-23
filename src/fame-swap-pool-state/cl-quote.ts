import { isAddress, type Address, type Hex } from "viem";
import { FamePoolStateRequestError } from "./api.ts";
import {
  batchGetClReplayStateCapsules,
  batchGetLatestClReplayPointers,
  sourceRegistryIdFor,
  type FameClReplayLatestState,
  type FameClReplayRegistryEntry,
  type FameClReplayStateCapsule,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
  FamePoolStateVenueFamily,
} from "./types.ts";

export interface FamePoolQuoteRequest {
  poolId: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
}

export interface FamePoolQuoteBatchRequest {
  currentBlock: number;
  maxFreshnessBlocks?: number;
  quotes: FamePoolQuoteRequest[];
}

export type FamePoolQuoteUnavailableReason =
  | "missing-registry-entry"
  | "unsupported-pool"
  | "missing-indexed-state"
  | "stale-indexed-state"
  | "source-registry-mismatch"
  | "token-direction-mismatch"
  | "malformed-replay-state"
  | "outside-indexed-tick-range"
  | "replay-failed";

interface FamePoolQuoteUnavailableEntry {
  status: "unavailable";
  requested: FamePoolQuoteRequest;
  reason: FamePoolQuoteUnavailableReason;
  poolId?: string;
  chainId?: number;
  poolAddress?: Address | null;
  observedThroughBlock?: number;
  sourceRegistryId?: string;
  maxFreshnessBlocks?: number;
}

interface FameSlipstreamClQuoteEntry {
  status: "quoted";
  quoteKind: "cl-quote-v1";
  poolId: string;
  chainId: number;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  tokenIn: Address;
  tokenOut: Address;
  venueFamily: FamePoolStateVenueFamily;
  tickSpacing: number;
  amountIn: string;
  amountOut: string;
  sqrtPriceX96: string;
  sqrtPriceX96After: string;
  tick: number;
  liquidity: string;
  fee: string;
  feeSource: "pool-fee";
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  source: "slipstream-pool-state";
  sourceRegistryId: string;
  maxFreshnessBlocks: number;
}

export type FamePoolQuoteResponseEntry =
  | FameSlipstreamClQuoteEntry
  | FamePoolQuoteUnavailableEntry;

export interface FamePoolQuoteBatchResponse {
  sourceRegistryId: string;
  currentBlock: number;
  producerMaxFreshnessBlocks: number;
  effectiveMaxFreshnessBlocks: number;
  quotes: FamePoolQuoteResponseEntry[];
}

interface ReplayTick {
  tick: number;
  liquidityGross: bigint;
  liquidityNet: bigint;
}

type ClReplayPool = FameClReplayRegistryEntry;
type ReplayFailureReason = Extract<
  FamePoolQuoteUnavailableReason,
  "malformed-replay-state" | "outside-indexed-tick-range" | "replay-failed"
>;

const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const MIN_SQRT_RATIO = 4_295_128_739n;
const MAX_SQRT_RATIO =
  1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;
const Q96 = 2n ** 96n;
const FEE_DENOMINATOR = 1_000_000n;
const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT256_DECIMAL_LENGTH = MAX_UINT256.toString().length;

function quoteApiError(path: string, message: string): never {
  throw new FamePoolStateRequestError(
    `FAME pool-quotes request invalid at ${path}: ${message}.`,
  );
}

function parseObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    quoteApiError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    quoteApiError(path, "expected a non-empty string");
  }
  return value;
}

function parseInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    quoteApiError(path, "expected a non-negative safe integer");
  }
  return value;
}

function parseAddress(value: unknown, path: string): Address {
  const parsed = parseString(value, path);
  if (!isAddress(parsed, { strict: false })) {
    quoteApiError(path, "expected an EVM address");
  }
  return parsed as Address;
}

function parseUint256Decimal(value: unknown, path: string): string {
  const parsed = parseString(value, path);
  if (parsed.length > MAX_UINT256_DECIMAL_LENGTH) {
    quoteApiError(path, "expected a uint256 decimal string");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(parsed)) {
    quoteApiError(path, "expected a canonical uint256 decimal string");
  }
  if (BigInt(parsed) > MAX_UINT256) {
    quoteApiError(path, "expected a uint256 decimal string");
  }
  return parsed;
}

function optionalField(
  record: Record<string, unknown>,
  key: string,
): unknown | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function parseQuoteRequest(value: unknown, path: string): FamePoolQuoteRequest {
  const record = parseObject(value, path);
  if (
    !Object.keys(record).every((key) =>
      ["poolId", "tokenIn", "tokenOut", "amountIn"].includes(key),
    )
  ) {
    quoteApiError(path, "expected only poolId, tokenIn, tokenOut, and amountIn");
  }
  return {
    poolId: parseString(optionalField(record, "poolId"), `${path}.poolId`),
    tokenIn: parseAddress(optionalField(record, "tokenIn"), `${path}.tokenIn`),
    tokenOut: parseAddress(
      optionalField(record, "tokenOut"),
      `${path}.tokenOut`,
    ),
    amountIn: parseUint256Decimal(
      optionalField(record, "amountIn"),
      `${path}.amountIn`,
    ),
  };
}

export function parseFamePoolQuoteBatchRequest(
  value: unknown,
  maxBatchSize = Number.MAX_SAFE_INTEGER,
): FamePoolQuoteBatchRequest {
  const record = parseObject(value, "$");
  if (
    !Object.keys(record).every((key) =>
      ["currentBlock", "maxFreshnessBlocks", "quotes"].includes(key),
    )
  ) {
    quoteApiError("$", "expected only currentBlock, maxFreshnessBlocks, and quotes");
  }
  const quotesValue = optionalField(record, "quotes");
  if (!Array.isArray(quotesValue)) {
    quoteApiError("$.quotes", "expected an array");
  }
  if (quotesValue.length > maxBatchSize) {
    quoteApiError("$.quotes", `expected at most ${maxBatchSize.toString()} quotes`);
  }

  const maxFreshnessBlocks = optionalField(record, "maxFreshnessBlocks");
  return {
    currentBlock: parseInteger(
      optionalField(record, "currentBlock"),
      "$.currentBlock",
    ),
    ...(maxFreshnessBlocks === undefined
      ? {}
      : {
          maxFreshnessBlocks: parseInteger(
            maxFreshnessBlocks,
            "$.maxFreshnessBlocks",
          ),
        }),
    quotes: quotesValue.map((quote, index) =>
      parseQuoteRequest(quote, `$.quotes[${index.toString()}]`),
    ),
  };
}

function registryMaps(registry: FamePoolStateRegistryFile) {
  return new Map(registry.pools.map((pool) => [pool.id, pool]));
}

function isClReplayPool(
  pool: FamePoolStateRegistryEntry,
): pool is ClReplayPool {
  return (
    pool.replaySurface === "cl-replay-v1" &&
    pool.stateSurface === "cl-head-snapshot" &&
    pool.tickSpacing !== null &&
    pool.poolAddress !== null &&
    pool.venue === "aerodrome-slipstream"
  );
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function freshnessStatus(options: {
  state: { observedThroughBlock: number };
  currentBlock: number;
  maxFreshnessBlocks: number;
}): "fresh" | "stale" {
  if (options.state.observedThroughBlock > options.currentBlock) {
    return "stale";
  }
  return options.currentBlock - options.state.observedThroughBlock <=
    options.maxFreshnessBlocks
    ? "fresh"
    : "stale";
}

function clReplayLatestStateMatchesRegistry({
  latest,
  entry,
  sourceRegistryId,
}: {
  latest: FameClReplayLatestState;
  entry: ClReplayPool;
  sourceRegistryId: string;
}): boolean {
  return (
    latest.sourceRegistryId === sourceRegistryId &&
    latest.poolId === entry.id &&
    latest.chainId === entry.chainId &&
    sameAddress(latest.poolAddress, entry.poolAddress) &&
    sameAddress(latest.token0, entry.token0) &&
    sameAddress(latest.token1, entry.token1) &&
    latest.venueFamily === entry.venueFamily &&
    latest.tickSpacing === entry.tickSpacing
  );
}

function clReplayStateMatchesRegistry({
  state,
  entry,
  sourceRegistryId,
}: {
  state: FameClReplayStateCapsule;
  entry: ClReplayPool;
  sourceRegistryId: string;
}): boolean {
  const latest = state.latest;
  return (
    clReplayLatestStateMatchesRegistry({ latest, entry, sourceRegistryId }) &&
    latest.bitmapWordCount === state.bitmapWords.length &&
    latest.initializedTickCount === state.initializedTicks.length
  );
}

function parseUnsignedDecimal(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}

function parseSignedDecimal(value: string): bigint | null {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value) || value === "-0") return null;
  return BigInt(value);
}

function divRoundingUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator === 0n ? quotient : quotient + 1n;
}

function mulDivRoundingUp(
  left: bigint,
  right: bigint,
  denominator: bigint,
): bigint {
  return divRoundingUp(left * right, denominator);
}

function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error("Tick is outside the supported CL range.");
  }
  const absTick = tick < 0 ? -tick : tick;
  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return ratio % (2n ** 32n) === 0n
    ? ratio >> 32n
    : (ratio >> 32n) + 1n;
}

function amount0Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const lower = sqrtA < sqrtB ? sqrtA : sqrtB;
  const upper = sqrtA < sqrtB ? sqrtB : sqrtA;
  const numerator1 = liquidity << 96n;
  const numerator2 = upper - lower;
  if (roundUp) {
    return divRoundingUp(
      mulDivRoundingUp(numerator1, numerator2, upper),
      lower,
    );
  }
  return ((numerator1 * numerator2) / upper) / lower;
}

function amount1Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const lower = sqrtA < sqrtB ? sqrtA : sqrtB;
  const upper = sqrtA < sqrtB ? sqrtB : sqrtA;
  return roundUp
    ? mulDivRoundingUp(liquidity, upper - lower, Q96)
    : (liquidity * (upper - lower)) / Q96;
}

function nextSqrtPriceFromInput(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (amountIn === 0n) return sqrtPriceX96;
  if (zeroForOne) {
    const numerator1 = liquidity << 96n;
    return mulDivRoundingUp(
      numerator1,
      sqrtPriceX96,
      numerator1 + amountIn * sqrtPriceX96,
    );
  }
  return sqrtPriceX96 + (amountIn * Q96) / liquidity;
}

function computeSwapStep(options: {
  sqrtPriceX96: bigint;
  sqrtTargetX96: bigint;
  liquidity: bigint;
  amountRemaining: bigint;
  feePips: bigint;
  zeroForOne: boolean;
}): {
  sqrtNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
} {
  const amountRemainingLessFee =
    (options.amountRemaining * (FEE_DENOMINATOR - options.feePips)) /
    FEE_DENOMINATOR;
  const amountInAtTarget = options.zeroForOne
    ? amount0Delta(
        options.sqrtTargetX96,
        options.sqrtPriceX96,
        options.liquidity,
        true,
      )
    : amount1Delta(
        options.sqrtPriceX96,
        options.sqrtTargetX96,
        options.liquidity,
        true,
      );
  const reachesTarget = amountRemainingLessFee >= amountInAtTarget;
  const sqrtNextX96 = reachesTarget
    ? options.sqrtTargetX96
    : nextSqrtPriceFromInput(
        options.sqrtPriceX96,
        options.liquidity,
        amountRemainingLessFee,
        options.zeroForOne,
      );
  const amountIn = reachesTarget
    ? amountInAtTarget
    : options.zeroForOne
      ? amount0Delta(sqrtNextX96, options.sqrtPriceX96, options.liquidity, true)
      : amount1Delta(options.sqrtPriceX96, sqrtNextX96, options.liquidity, true);
  const amountOut = options.zeroForOne
    ? amount1Delta(sqrtNextX96, options.sqrtPriceX96, options.liquidity, false)
    : amount0Delta(options.sqrtPriceX96, sqrtNextX96, options.liquidity, false);
  const feeAmount = reachesTarget
    ? mulDivRoundingUp(
        amountIn,
        options.feePips,
        FEE_DENOMINATOR - options.feePips,
      )
    : options.amountRemaining - amountIn;
  return { sqrtNextX96, amountIn, amountOut, feeAmount };
}

function nextInitializedTick(
  ticks: readonly ReplayTick[],
  currentTick: number,
  zeroForOne: boolean,
): ReplayTick | null {
  if (zeroForOne) {
    for (let index = ticks.length - 1; index >= 0; index -= 1) {
      const tick = ticks[index];
      if (tick && tick.tick <= currentTick) return tick;
    }
    return null;
  }
  return ticks.find((tick) => tick.tick > currentTick) ?? null;
}

function replayTicks(state: FameClReplayStateCapsule): ReplayTick[] | null {
  const ticks = state.initializedTicks.map((tick) => {
    const liquidityGross = parseUnsignedDecimal(tick.liquidityGross);
    const liquidityNet = parseSignedDecimal(tick.liquidityNet);
    if (liquidityGross === null || liquidityNet === null) return null;
    return {
      tick: tick.tick,
      liquidityGross,
      liquidityNet,
    };
  });
  if (ticks.some((tick) => tick === null)) return null;
  return ticks
    .filter((tick): tick is ReplayTick => tick !== null)
    .sort((left, right) => left.tick - right.tick);
}

function replaySlipstreamExactInput(options: {
  state: FameClReplayStateCapsule;
  zeroForOne: boolean;
  amountIn: bigint;
}): { amountOut: bigint; sqrtPriceX96After: bigint } | ReplayFailureReason {
  const sqrtPriceX96 = parseUnsignedDecimal(options.state.latest.sqrtPriceX96);
  const liquidityStart = parseUnsignedDecimal(options.state.latest.liquidity);
  const feePips = parseUnsignedDecimal(options.state.latest.fee);
  const ticks = replayTicks(options.state);
  if (
    sqrtPriceX96 === null ||
    liquidityStart === null ||
    feePips === null ||
    feePips >= FEE_DENOMINATOR ||
    ticks === null ||
    options.state.latest.tick < MIN_TICK ||
    options.state.latest.tick > MAX_TICK ||
    sqrtPriceX96 < MIN_SQRT_RATIO ||
    sqrtPriceX96 > MAX_SQRT_RATIO
  ) {
    return "malformed-replay-state";
  }

  let sqrt = sqrtPriceX96;
  let tick = options.state.latest.tick;
  let liquidity = liquidityStart;
  let amountRemaining = options.amountIn;
  let amountOut = 0n;

  while (amountRemaining > 0n) {
    if (liquidity <= 0n) return "outside-indexed-tick-range";
    const nextTick = nextInitializedTick(ticks, tick, options.zeroForOne);
    const targetTick = nextTick?.tick ?? (options.zeroForOne ? MIN_TICK : MAX_TICK);
    const sqrtTarget = getSqrtRatioAtTick(targetTick);
    const step = computeSwapStep({
      sqrtPriceX96: sqrt,
      sqrtTargetX96: sqrtTarget,
      liquidity,
      amountRemaining,
      feePips,
      zeroForOne: options.zeroForOne,
    });
    if (
      step.amountIn === 0n &&
      step.amountOut === 0n &&
      step.sqrtNextX96 !== sqrtTarget
    ) {
      return "replay-failed";
    }
    amountRemaining -= step.amountIn + step.feeAmount;
    amountOut += step.amountOut;
    sqrt = step.sqrtNextX96;
    if (sqrt !== sqrtTarget) break;
    if (!nextTick) {
      return amountRemaining > 0n
        ? "outside-indexed-tick-range"
        : { amountOut, sqrtPriceX96After: sqrt };
    }
    liquidity = options.zeroForOne
      ? liquidity - nextTick.liquidityNet
      : liquidity + nextTick.liquidityNet;
    tick = options.zeroForOne ? nextTick.tick - 1 : nextTick.tick;
  }

  return amountOut > 0n
    ? { amountOut, sqrtPriceX96After: sqrt }
    : "replay-failed";
}

function unavailable(
  requested: FamePoolQuoteRequest,
  reason: FamePoolQuoteUnavailableReason,
  metadata: Omit<
    FamePoolQuoteUnavailableEntry,
    "status" | "requested" | "reason"
  > = {},
): FamePoolQuoteUnavailableEntry {
  return {
    status: "unavailable",
    requested,
    reason,
    ...metadata,
  };
}

function quoteFromReplayState(options: {
  request: FamePoolQuoteRequest;
  state: FameClReplayStateCapsule;
  maxFreshnessBlocks: number;
}): FamePoolQuoteResponseEntry {
  const { request, state } = options;
  const latest = state.latest;
  const direct =
    sameAddress(request.tokenIn, latest.token0) &&
    sameAddress(request.tokenOut, latest.token1);
  const reverse =
    sameAddress(request.tokenIn, latest.token1) &&
    sameAddress(request.tokenOut, latest.token0);
  if (!direct && !reverse) {
    return unavailable(request, "token-direction-mismatch", {
      poolId: latest.poolId,
      chainId: latest.chainId,
      poolAddress: latest.poolAddress,
      observedThroughBlock: latest.observedThroughBlock,
      sourceRegistryId: latest.sourceRegistryId,
      maxFreshnessBlocks: options.maxFreshnessBlocks,
    });
  }

  const replay = replaySlipstreamExactInput({
    state,
    zeroForOne: direct,
    amountIn: BigInt(request.amountIn),
  });
  if (typeof replay === "string") {
    return unavailable(request, replay, {
      poolId: latest.poolId,
      chainId: latest.chainId,
      poolAddress: latest.poolAddress,
      observedThroughBlock: latest.observedThroughBlock,
      sourceRegistryId: latest.sourceRegistryId,
      maxFreshnessBlocks: options.maxFreshnessBlocks,
    });
  }

  return {
    status: "quoted",
    quoteKind: "cl-quote-v1",
    poolId: latest.poolId,
    chainId: latest.chainId,
    poolAddress: latest.poolAddress,
    token0: latest.token0,
    token1: latest.token1,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    venueFamily: latest.venueFamily,
    tickSpacing: latest.tickSpacing,
    amountIn: request.amountIn,
    amountOut: replay.amountOut.toString(),
    sqrtPriceX96: latest.sqrtPriceX96,
    sqrtPriceX96After: replay.sqrtPriceX96After.toString(),
    tick: latest.tick,
    liquidity: latest.liquidity,
    fee: latest.fee,
    feeSource: latest.feeSource,
    observedThroughBlock: latest.observedThroughBlock,
    blockHash: latest.blockHash,
    parentHash: latest.parentHash,
    snapshotId: latest.snapshotId,
    stateHash: latest.stateHash,
    source: latest.source,
    sourceRegistryId: latest.sourceRegistryId,
    maxFreshnessBlocks: options.maxFreshnessBlocks,
  };
}

export async function handleFamePoolQuoteBatchRequest({
  request,
  tableName,
  db,
  registry = famePoolStateRegistry,
  producerMaxFreshnessBlocks = 120,
  maxBatchSize = 64,
}: {
  request: unknown;
  tableName: string;
  db?: PoolStateDocumentClient;
  registry?: FamePoolStateRegistryFile;
  producerMaxFreshnessBlocks?: number;
  maxBatchSize?: number;
}): Promise<FamePoolQuoteBatchResponse> {
  const parsed = parseFamePoolQuoteBatchRequest(request, maxBatchSize);

  const effectiveMaxFreshnessBlocks = Math.min(
    parsed.maxFreshnessBlocks ?? producerMaxFreshnessBlocks,
    producerMaxFreshnessBlocks,
  );
  const sourceRegistryId = sourceRegistryIdFor(registry.source);
  const registryById = registryMaps(registry);
  const entries = parsed.quotes.map((quote) => ({
    request: quote,
    entry: registryById.get(quote.poolId),
  }));
  const clReplayPoolsById = new Map(
    entries
      .map(({ entry }) => entry)
      .filter(
        (entry): entry is ClReplayPool =>
          entry !== undefined && isClReplayPool(entry),
      )
      .map((entry) => [entry.id, entry]),
  );
  const latestStates = await batchGetLatestClReplayPointers({
    db,
    tableName,
    pools: [...clReplayPoolsById.values()],
  });
  const freshLatestStates = latestStates.filter((latest) => {
    const entry = clReplayPoolsById.get(latest.poolId);
    return (
      entry !== undefined &&
      clReplayLatestStateMatchesRegistry({ latest, entry, sourceRegistryId }) &&
      freshnessStatus({
        state: latest,
        currentBlock: parsed.currentBlock,
        maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
      }) === "fresh"
    );
  });
  const clReplayStates = await batchGetClReplayStateCapsules({
    db,
    tableName,
    latestStates: freshLatestStates,
  });
  const latestStatesByPoolId = new Map(
    latestStates.map((state) => [state.poolId, state]),
  );
  const clReplayStatesByPoolId = new Map(
    clReplayStates.map((state) => [state.latest.poolId, state]),
  );

  return {
    sourceRegistryId,
    currentBlock: parsed.currentBlock,
    producerMaxFreshnessBlocks,
    effectiveMaxFreshnessBlocks,
    quotes: entries.map(({ request: requested, entry }) => {
      if (!entry) {
        return unavailable(requested, "missing-registry-entry");
      }
      if (!isClReplayPool(entry)) {
        return unavailable(requested, "unsupported-pool", {
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
        });
      }

      const latest = latestStatesByPoolId.get(entry.id);
      if (!latest) {
        return unavailable(requested, "missing-indexed-state", {
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
        });
      }
      if (latest.sourceRegistryId !== sourceRegistryId) {
        return unavailable(requested, "source-registry-mismatch", {
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
          observedThroughBlock: latest.observedThroughBlock,
          sourceRegistryId: latest.sourceRegistryId,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });
      }
      if (!clReplayLatestStateMatchesRegistry({ latest, entry, sourceRegistryId })) {
        return unavailable(requested, "missing-indexed-state", {
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
          observedThroughBlock: latest.observedThroughBlock,
          sourceRegistryId: latest.sourceRegistryId,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });
      }
      if (
        freshnessStatus({
          state: latest,
          currentBlock: parsed.currentBlock,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        }) === "stale"
      ) {
        return unavailable(requested, "stale-indexed-state", {
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
          observedThroughBlock: latest.observedThroughBlock,
          sourceRegistryId: latest.sourceRegistryId,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });
      }

      const state = clReplayStatesByPoolId.get(entry.id);
      if (
        !state ||
        !clReplayStateMatchesRegistry({ state, entry, sourceRegistryId })
      ) {
        return unavailable(requested, "missing-indexed-state", {
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
          observedThroughBlock: latest.observedThroughBlock,
          sourceRegistryId: latest.sourceRegistryId,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });
      }

      return quoteFromReplayState({
        request: requested,
        state,
        maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
      });
    }),
  };
}
