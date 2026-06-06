import { isAddress, type Address, type Hex } from "viem";
import { FamePoolStateRequestError } from "./api.ts";
import {
  batchGetClReplayStateCapsules,
  batchGetLatestClReplayMaintenanceStates,
  batchGetLatestClReplayPointers,
  batchGetLatestPoolStates,
  batchGetLatestV4ClReplayMaintenanceStates,
  batchGetLatestV4ClReplayPointers,
  batchGetV4ClReplayStateCapsules,
  sourceRegistryIdFor,
  type FameClReplayLatestState,
  type FameClReplayMaintenanceState,
  type FameClReplayMaintenanceStatus,
  type FameClReplayRegistryEntry,
  type FameClReplayStateCapsule,
  type FamePoolLatestState,
  type FameV4ClReplayLatestState,
  type FameV4ClReplayMaintenanceState,
  type FameV4ClReplayRegistryEntry,
  type FameV4ClReplayStateCapsule,
  type FameV4ZoraVerifiedProvenance,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateFeeDescriptor,
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
  FamePoolStateVenueFamily,
} from "./types.ts";
import {
  classifyV4ZoraQuoteLane,
  FAME_V4_ZORA_QUOTE_LANE_MANIFEST,
  FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
} from "./v4-zora-manifests.ts";

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
  | "malformed-reserve-state"
  | "reserve-quote-failed"
  | "malformed-replay-state"
  | "outside-indexed-tick-range"
  | "replay-failed"
  | "missing-provenance"
  | "v4-shape-mismatch"
  | "fee-model-mismatch"
  | "producer-untrusted";

interface FamePoolQuoteUnavailableEntry {
  status: "unavailable";
  requested: FamePoolQuoteRequest;
  reason: FamePoolQuoteUnavailableReason;
  poolId?: string;
  chainId?: number;
  poolAddress?: Address | null;
  poolKey?: Hex | null;
  stateViewAddress?: Address | null;
  observedThroughBlock?: number;
  sourceRegistryId?: string;
  maxFreshnessBlocks?: number;
  producerStatus?: FameClReplayMaintenanceStatus;
  producerReason?: string | null;
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

interface FameV4ClQuoteEntry {
  status: "quoted";
  quoteKind: "cl-quote-v1";
  poolId: string;
  chainId: number;
  poolAddress: null;
  poolKey: Hex;
  poolManager: Address;
  stateViewAddress: Address;
  token0: Address;
  token1: Address;
  tokenIn: Address;
  tokenOut: Address;
  venueFamily: "UniswapV4";
  tickSpacing: number;
  amountIn: string;
  amountOut: string;
  sqrtPriceX96: string;
  sqrtPriceX96After: string;
  tick: number;
  liquidity: string;
  fee: string;
  lpFee: string;
  protocolFee: string;
  protocolFeeStatus: "zero";
  staticFee: string;
  feeSource: "v4-slot0";
  observedThroughBlock: number;
  blockHash: Hex;
  parentHash: Hex;
  snapshotId: string;
  stateHash: Hex;
  source: "uniswap-v4-state-view";
  sourceRegistryId: string;
  maxFreshnessBlocks: number;
  hookAddress: Address;
  hookData: Hex;
  hookDataStatus: "empty";
  zoraProvenance: FameV4ZoraVerifiedProvenance;
}

interface FamePriceImpactEstimate {
  preSwapPriceX18: string;
  postSwapPriceX18: string;
  executionPriceX18: string;
  marketImpactBps: number | null;
  method: "constant-product-reserves";
}

interface FameProtocolEvidenceItem {
  status: "available" | "unavailable" | "not_applicable";
  source: string;
  value?: string;
  reason?: string;
}

interface FameProtocolEvidence {
  quote: FameProtocolEvidenceItem;
  prePrice: FameProtocolEvidenceItem;
  postPrice: FameProtocolEvidenceItem;
  marketImpact: FameProtocolEvidenceItem;
  activeLiquidity: FameProtocolEvidenceItem;
}

interface FameConstantProductQuoteEntry {
  status: "quoted";
  quoteKind: "constant-product-quote-v1";
  quoteModel: "constant-product-reserves";
  quoteModelVersion: 1;
  poolId: string;
  chainId: number;
  poolAddress: Address;
  token0: Address;
  token1: Address;
  tokenIn: Address;
  tokenOut: Address;
  venueFamily: FamePoolStateVenueFamily;
  feeBps: number;
  feeSource: "registry-fee";
  source: "reserve-pool-state";
  stateSource: FamePoolLatestState["source"];
  amountIn: string;
  amountOut: string;
  observedThroughBlock: number;
  sourceRegistryId: string;
  maxFreshnessBlocks: number;
  priceImpact: FamePriceImpactEstimate;
  protocolEvidence: FameProtocolEvidence;
}

export type FamePoolQuoteResponseEntry =
  | FameSlipstreamClQuoteEntry
  | FameV4ClQuoteEntry
  | FameConstantProductQuoteEntry
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

interface ReplayQuoteStateCapsule {
  latest: {
    sqrtPriceX96: string;
    tick: number;
    liquidity: string;
  };
  initializedTicks: readonly {
    tick: number;
    liquidityGross: string;
    liquidityNet: string;
  }[];
}

type ReserveQuotePool = FamePoolStateRegistryEntry & {
  capability: "quote-model";
  stateSurface: "constant-product-reserves";
  quoteModel: "constant-product-reserves";
  poolAddress: Address;
  fee: Extract<FamePoolStateFeeDescriptor, { status: "available" }>;
};
type ClReplayPool = FameClReplayRegistryEntry;
type V4ClReplayPool = FameV4ClReplayRegistryEntry;
type ClReplayQuoteLatestState = FameClReplayLatestState;
type ClReplayQuoteStateCapsule = FameClReplayStateCapsule;
type V4ClReplayQuoteLatestState = FameV4ClReplayLatestState;
type V4ClReplayQuoteStateCapsule = FameV4ClReplayStateCapsule;
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
const RESERVE_FEE_DENOMINATOR = 10_000n;
const PRICE_SCALE = 1_000_000_000_000_000_000n;
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
  const parsedValue = BigInt(parsed);
  if (parsedValue === 0n || parsedValue > MAX_UINT256) {
    quoteApiError(path, "expected a positive uint256 decimal string");
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
    quoteApiError(
      path,
      "expected only poolId, tokenIn, tokenOut, and amountIn",
    );
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
    quoteApiError(
      "$",
      "expected only currentBlock, maxFreshnessBlocks, and quotes",
    );
  }
  const quotesValue = optionalField(record, "quotes");
  if (!Array.isArray(quotesValue)) {
    quoteApiError("$.quotes", "expected an array");
  }
  if (quotesValue.length > maxBatchSize) {
    quoteApiError(
      "$.quotes",
      `expected at most ${maxBatchSize.toString()} quotes`,
    );
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

function isV4ClReplayPool(
  pool: FamePoolStateRegistryEntry,
): pool is V4ClReplayPool {
  return (
    pool.id === FAME_V4_ZORA_QUOTE_LANE_POOL_ID &&
    pool.venue === "uniswap-v4" &&
    pool.venueFamily === "UniswapV4" &&
    pool.poolAddress === null &&
    pool.poolKey !== null &&
    pool.stateViewAddress !== null &&
    pool.stateSurface === "cl-head-snapshot" &&
    pool.tickSpacing !== null
  );
}

function isReserveQuotePool(
  pool: FamePoolStateRegistryEntry,
): pool is ReserveQuotePool {
  return (
    pool.capability === "quote-model" &&
    pool.stateSurface === "constant-product-reserves" &&
    pool.quoteModel === "constant-product-reserves" &&
    pool.poolAddress !== null &&
    pool.fee.status === "available"
  );
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function addressStateKey(chainId: number, poolAddress: Address): string {
  return `${chainId.toString()}:${poolAddress.toLowerCase()}`;
}

function poolKeyStateKey(chainId: number, poolKey: Hex): string {
  return `${chainId.toString()}:${poolKey.toLowerCase()}`;
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
  latest: ClReplayQuoteLatestState;
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
  state: ClReplayQuoteStateCapsule;
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

function v4ClReplayLatestStateMatchesRegistry({
  latest,
  entry,
  sourceRegistryId,
}: {
  latest: V4ClReplayQuoteLatestState;
  entry: V4ClReplayPool;
  sourceRegistryId: string;
}): boolean {
  return (
    v4ClReplayLatestUnavailableReason({
      latest,
      entry,
      sourceRegistryId,
    }) === null
  );
}

function v4ClReplayLatestUnavailableReason({
  latest,
  entry,
  sourceRegistryId,
}: {
  latest: V4ClReplayQuoteLatestState;
  entry: V4ClReplayPool;
  sourceRegistryId: string;
}): Extract<
  FamePoolQuoteUnavailableReason,
  "source-registry-mismatch" | "v4-shape-mismatch" | "missing-provenance"
> | null {
  if (latest.sourceRegistryId !== sourceRegistryId) {
    return "source-registry-mismatch";
  }
  const shapeMatches =
    latest.poolId === entry.id &&
    latest.chainId === entry.chainId &&
    latest.poolKey.toLowerCase() === entry.poolKey.toLowerCase() &&
    latest.stateViewAddress.toLowerCase() ===
      entry.stateViewAddress.toLowerCase() &&
    latest.token0.toLowerCase() === entry.token0.toLowerCase() &&
    latest.token1.toLowerCase() === entry.token1.toLowerCase() &&
    latest.venueFamily === entry.venueFamily &&
    latest.tickSpacing === entry.tickSpacing;
  if (!shapeMatches) return "v4-shape-mismatch";

  const provenance = latest.zoraProvenance;
  const provenanceMatches =
    provenance.status === "verified" &&
    provenance.chainId === entry.chainId &&
    provenance.coinAddress.toLowerCase() === entry.token1.toLowerCase() &&
    provenance.poolKey.toLowerCase() === entry.poolKey.toLowerCase() &&
    provenance.poolId.toLowerCase() === entry.poolKey.toLowerCase();
  return provenanceMatches ? null : "missing-provenance";
}

function v4ClReplayStateMatchesRegistry({
  state,
  entry,
  sourceRegistryId,
}: {
  state: V4ClReplayQuoteStateCapsule;
  entry: V4ClReplayPool;
  sourceRegistryId: string;
}): boolean {
  const latest = state.latest;
  return (
    v4ClReplayLatestStateMatchesRegistry({
      latest,
      entry,
      sourceRegistryId,
    }) &&
    latest.bitmapWordCount === state.bitmapWords.length &&
    latest.initializedTickCount === state.initializedTicks.length
  );
}

function clReplayMaintenanceCompatible({
  maintenance,
  latest,
  sourceRegistryId,
}: {
  maintenance: FameClReplayMaintenanceState | undefined;
  latest: ClReplayQuoteLatestState;
  sourceRegistryId: string;
}): boolean {
  return (
    maintenance !== undefined &&
    maintenance.status === "trusted" &&
    maintenance.sourceRegistryId === sourceRegistryId &&
    maintenance.poolId === latest.poolId &&
    maintenance.chainId === latest.chainId &&
    sameAddress(maintenance.poolAddress, latest.poolAddress) &&
    maintenance.cursorBlock === latest.observedThroughBlock &&
    maintenance.cursorBlockHash === latest.blockHash &&
    maintenance.targetBlock === latest.observedThroughBlock &&
    maintenance.targetBlockHash === latest.blockHash &&
    maintenance.stateHash === latest.stateHash
  );
}

function v4ClReplayMaintenanceCompatible({
  maintenance,
  latest,
  sourceRegistryId,
}: {
  maintenance: FameV4ClReplayMaintenanceState | undefined;
  latest: V4ClReplayQuoteLatestState;
  sourceRegistryId: string;
}): boolean {
  return (
    maintenance !== undefined &&
    maintenance.status === "trusted" &&
    maintenance.sourceRegistryId === sourceRegistryId &&
    maintenance.poolId === latest.poolId &&
    maintenance.chainId === latest.chainId &&
    maintenance.poolKey.toLowerCase() === latest.poolKey.toLowerCase() &&
    maintenance.stateViewAddress.toLowerCase() ===
      latest.stateViewAddress.toLowerCase() &&
    maintenance.cursorBlock === latest.observedThroughBlock &&
    maintenance.cursorBlockHash === latest.blockHash &&
    maintenance.targetBlock === latest.observedThroughBlock &&
    maintenance.targetBlockHash === latest.blockHash &&
    maintenance.stateHash === latest.stateHash
  );
}

function clReplaySnapshotId(latest: ClReplayQuoteLatestState): string {
  return latest.snapshotId;
}

function reserveStateMatchesRegistry({
  state,
  entry,
  sourceRegistryId,
}: {
  state: FamePoolLatestState;
  entry: ReserveQuotePool;
  sourceRegistryId: string;
}): boolean {
  return (
    state.sourceRegistryId === sourceRegistryId &&
    state.poolId === entry.id &&
    state.chainId === entry.chainId &&
    sameAddress(state.poolAddress, entry.poolAddress) &&
    sameAddress(state.token0, entry.token0) &&
    sameAddress(state.token1, entry.token1)
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
  if ((absTick & 0x2) !== 0)
    ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0)
    ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0)
    ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0)
    ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0)
    ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0)
    ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0)
    ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0)
    ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0)
    ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0)
    ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0)
    ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0)
    ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0)
    ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0)
    ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0)
    ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0)
    ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0)
    ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0)
    ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0)
    ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return ratio % 2n ** 32n === 0n ? ratio >> 32n : (ratio >> 32n) + 1n;
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
  return (numerator1 * numerator2) / upper / lower;
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
      : amount1Delta(
          options.sqrtPriceX96,
          sqrtNextX96,
          options.liquidity,
          true,
        );
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

function replayTicks(state: ReplayQuoteStateCapsule): ReplayTick[] | null {
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

function replayClExactInput(options: {
  state: ReplayQuoteStateCapsule;
  feePips: string;
  zeroForOne: boolean;
  amountIn: bigint;
}): { amountOut: bigint; sqrtPriceX96After: bigint } | ReplayFailureReason {
  const sqrtPriceX96 = parseUnsignedDecimal(options.state.latest.sqrtPriceX96);
  const liquidityStart = parseUnsignedDecimal(options.state.latest.liquidity);
  const feePips = parseUnsignedDecimal(options.feePips);
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
    const targetTick =
      nextTick?.tick ?? (options.zeroForOne ? MIN_TICK : MAX_TICK);
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

function safeProducerReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (/^[a-z0-9][a-z0-9-]{0,79}$/u.test(trimmed)) return trimmed;
  return "redacted-reason";
}

function constantProductAmountOut(options: {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: number;
}): bigint | "malformed-reserve-state" {
  if (
    options.amountIn <= 0n ||
    options.reserveIn <= 0n ||
    options.reserveOut <= 0n ||
    !Number.isSafeInteger(options.feeBps)
  ) {
    return "malformed-reserve-state";
  }

  const feeNumerator = RESERVE_FEE_DENOMINATOR - BigInt(options.feeBps);
  if (feeNumerator <= 0n) return "malformed-reserve-state";

  const amountInWithFee = options.amountIn * feeNumerator;
  return (
    (amountInWithFee * options.reserveOut) /
    (options.reserveIn * RESERVE_FEE_DENOMINATOR + amountInWithFee)
  );
}

function priceX18(amountOut: bigint, amountIn: bigint): bigint | null {
  if (amountIn <= 0n || amountOut < 0n) return null;
  return (amountOut * PRICE_SCALE) / amountIn;
}

function marketImpactBps(
  preSwapPriceX18: bigint,
  executionPriceX18: bigint,
): number | null {
  if (preSwapPriceX18 <= 0n || executionPriceX18 <= 0n) return null;
  if (executionPriceX18 >= preSwapPriceX18) return 0;
  return Number(
    ((preSwapPriceX18 - executionPriceX18) * 10_000n) / preSwapPriceX18,
  );
}

function constantProductPriceImpact(options: {
  amountIn: bigint;
  amountOut: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
}): FamePriceImpactEstimate | null {
  const preSwapPrice = priceX18(options.reserveOut, options.reserveIn);
  const executionPrice = priceX18(options.amountOut, options.amountIn);
  if (preSwapPrice === null || executionPrice === null) return null;

  const nextReserveIn = options.reserveIn + options.amountIn;
  const nextReserveOut = options.reserveOut - options.amountOut;
  const postSwapPrice =
    nextReserveOut > 0n ? priceX18(nextReserveOut, nextReserveIn) : null;
  if (postSwapPrice === null) return null;

  return {
    preSwapPriceX18: preSwapPrice.toString(),
    postSwapPriceX18: postSwapPrice.toString(),
    executionPriceX18: executionPrice.toString(),
    marketImpactBps: marketImpactBps(preSwapPrice, executionPrice),
    method: "constant-product-reserves",
  };
}

function availableEvidence(
  source: string,
  value: bigint | number | string,
): FameProtocolEvidenceItem {
  return {
    status: "available",
    source,
    value: value.toString(),
  };
}

function unavailableEvidence(
  source: string,
  reason: string,
): FameProtocolEvidenceItem {
  return {
    status: "unavailable",
    source,
    reason,
  };
}

function notApplicableEvidence(
  source: string,
  reason: string,
): FameProtocolEvidenceItem {
  return {
    status: "not_applicable",
    source,
    reason,
  };
}

function protocolEvidenceFromPriceImpact(options: {
  poolId: string;
  amountOut: bigint;
  priceImpact: FamePriceImpactEstimate;
}): FameProtocolEvidence {
  const source = `reserve-pool-state quote for ${options.poolId}`;
  return {
    quote: availableEvidence(source, options.amountOut),
    prePrice: availableEvidence(source, options.priceImpact.preSwapPriceX18),
    postPrice: availableEvidence(source, options.priceImpact.postSwapPriceX18),
    marketImpact:
      options.priceImpact.marketImpactBps === null
        ? unavailableEvidence(
            source,
            "Constant-product reserve quote did not produce market-impact evidence.",
          )
        : availableEvidence(source, options.priceImpact.marketImpactBps),
    activeLiquidity: notApplicableEvidence(
      source,
      "Constant-product reserve quote uses reserves, not active liquidity.",
    ),
  };
}

function reserveQuoteMetadata(
  state: FamePoolLatestState,
  maxFreshnessBlocks: number,
): Omit<FamePoolQuoteUnavailableEntry, "status" | "requested" | "reason"> {
  return {
    poolId: state.poolId,
    chainId: state.chainId,
    poolAddress: state.poolAddress,
    observedThroughBlock: state.observedThroughBlock,
    sourceRegistryId: state.sourceRegistryId,
    maxFreshnessBlocks,
  };
}

function v4QuoteMetadata(
  latest: V4ClReplayQuoteLatestState,
  maxFreshnessBlocks: number,
): Omit<FamePoolQuoteUnavailableEntry, "status" | "requested" | "reason"> {
  return {
    poolId: latest.poolId,
    chainId: latest.chainId,
    poolAddress: null,
    poolKey: latest.poolKey,
    stateViewAddress: latest.stateViewAddress,
    observedThroughBlock: latest.observedThroughBlock,
    sourceRegistryId: latest.sourceRegistryId,
    maxFreshnessBlocks,
  };
}

function v4PoolMetadata(
  entry: V4ClReplayPool,
): Omit<FamePoolQuoteUnavailableEntry, "status" | "requested" | "reason"> {
  return {
    poolId: entry.id,
    chainId: entry.chainId,
    poolAddress: null,
    poolKey: entry.poolKey,
    stateViewAddress: entry.stateViewAddress,
  };
}

function v4AdmissionUnavailableReason({
  entry,
  latest,
}: {
  entry: V4ClReplayPool;
  latest: V4ClReplayQuoteLatestState;
}): FamePoolQuoteUnavailableReason | null {
  const classification = classifyV4ZoraQuoteLane(entry, latest.zoraProvenance);
  if (classification.status !== "target-eligible") {
    if (
      classification.status === "not-uniswap-v4" ||
      classification.status === "non-target-v4-unsupported"
    ) {
      return "unsupported-pool";
    }
    if (
      "reason" in classification &&
      classification.reason === "missing-provenance"
    ) {
      return "missing-provenance";
    }
    return "v4-shape-mismatch";
  }

  const lpFee = parseUnsignedDecimal(latest.lpFee);
  const protocolFee = parseUnsignedDecimal(latest.protocolFee);
  if (
    latest.source !== "uniswap-v4-state-view" ||
    latest.feeSource !== "v4-slot0" ||
    lpFee === null ||
    protocolFee === null
  ) {
    return "v4-shape-mismatch";
  }
  if (
    lpFee !== BigInt(classification.manifest.reviewedPoolShape.fee) ||
    protocolFee !== 0n
  ) {
    return "fee-model-mismatch";
  }
  return null;
}

function quoteFromReserveState(options: {
  request: FamePoolQuoteRequest;
  state: FamePoolLatestState;
  entry: ReserveQuotePool;
  maxFreshnessBlocks: number;
}): FamePoolQuoteResponseEntry {
  const { request, state, entry } = options;
  const reserve0 = parseUnsignedDecimal(state.reserve0);
  const reserve1 = parseUnsignedDecimal(state.reserve1);
  if (reserve0 === null || reserve1 === null) {
    return unavailable(
      request,
      "malformed-reserve-state",
      reserveQuoteMetadata(state, options.maxFreshnessBlocks),
    );
  }

  const direct =
    sameAddress(request.tokenIn, state.token0) &&
    sameAddress(request.tokenOut, state.token1);
  const reverse =
    sameAddress(request.tokenIn, state.token1) &&
    sameAddress(request.tokenOut, state.token0);
  if (!direct && !reverse) {
    return unavailable(
      request,
      "token-direction-mismatch",
      reserveQuoteMetadata(state, options.maxFreshnessBlocks),
    );
  }

  const amountIn = BigInt(request.amountIn);
  const reserveIn = direct ? reserve0 : reserve1;
  const reserveOut = direct ? reserve1 : reserve0;
  const amountOut = constantProductAmountOut({
    amountIn,
    reserveIn,
    reserveOut,
    feeBps: entry.fee.feeBps,
  });
  if (amountOut === "malformed-reserve-state") {
    return unavailable(
      request,
      amountOut,
      reserveQuoteMetadata(state, options.maxFreshnessBlocks),
    );
  }
  if (amountOut <= 0n) {
    return unavailable(
      request,
      "reserve-quote-failed",
      reserveQuoteMetadata(state, options.maxFreshnessBlocks),
    );
  }

  const priceImpact = constantProductPriceImpact({
    amountIn,
    amountOut,
    reserveIn,
    reserveOut,
  });
  if (priceImpact === null) {
    return unavailable(
      request,
      "reserve-quote-failed",
      reserveQuoteMetadata(state, options.maxFreshnessBlocks),
    );
  }

  return {
    status: "quoted",
    quoteKind: "constant-product-quote-v1",
    quoteModel: "constant-product-reserves",
    quoteModelVersion: 1,
    poolId: entry.id,
    chainId: entry.chainId,
    poolAddress: entry.poolAddress,
    token0: entry.token0,
    token1: entry.token1,
    tokenIn: request.tokenIn,
    tokenOut: request.tokenOut,
    venueFamily: entry.venueFamily,
    feeBps: entry.fee.feeBps,
    feeSource: "registry-fee",
    source: "reserve-pool-state",
    stateSource: state.source,
    amountIn: request.amountIn,
    amountOut: amountOut.toString(),
    observedThroughBlock: state.observedThroughBlock,
    sourceRegistryId: state.sourceRegistryId,
    maxFreshnessBlocks: options.maxFreshnessBlocks,
    priceImpact,
    protocolEvidence: protocolEvidenceFromPriceImpact({
      poolId: entry.id,
      amountOut,
      priceImpact,
    }),
  };
}

function quoteFromReplayState(options: {
  request: FamePoolQuoteRequest;
  state: ClReplayQuoteStateCapsule;
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

  const replay = replayClExactInput({
    state,
    feePips: latest.fee,
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
    snapshotId: clReplaySnapshotId(latest),
    stateHash: latest.stateHash,
    source: latest.source,
    sourceRegistryId: latest.sourceRegistryId,
    maxFreshnessBlocks: options.maxFreshnessBlocks,
  };
}

function quoteFromV4ReplayState(options: {
  request: FamePoolQuoteRequest;
  state: V4ClReplayQuoteStateCapsule;
  entry: V4ClReplayPool;
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
    return unavailable(
      request,
      "token-direction-mismatch",
      v4QuoteMetadata(latest, options.maxFreshnessBlocks),
    );
  }

  const admissionReason = v4AdmissionUnavailableReason({
    entry: options.entry,
    latest,
  });
  if (admissionReason !== null) {
    return unavailable(
      request,
      admissionReason,
      v4QuoteMetadata(latest, options.maxFreshnessBlocks),
    );
  }

  const replay = replayClExactInput({
    state,
    feePips: latest.lpFee,
    zeroForOne: direct,
    amountIn: BigInt(request.amountIn),
  });
  if (typeof replay === "string") {
    return unavailable(
      request,
      replay,
      v4QuoteMetadata(latest, options.maxFreshnessBlocks),
    );
  }

  const reviewedShape =
    FAME_V4_ZORA_QUOTE_LANE_MANIFEST.reviewedPoolShape;
  return {
    status: "quoted",
    quoteKind: "cl-quote-v1",
    poolId: latest.poolId,
    chainId: latest.chainId,
    poolAddress: null,
    poolKey: latest.poolKey,
    poolManager: reviewedShape.poolManager,
    stateViewAddress: latest.stateViewAddress,
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
    fee: latest.lpFee,
    lpFee: latest.lpFee,
    protocolFee: latest.protocolFee,
    protocolFeeStatus: "zero",
    staticFee: reviewedShape.fee.toString(),
    feeSource: latest.feeSource,
    observedThroughBlock: latest.observedThroughBlock,
    blockHash: latest.blockHash,
    parentHash: latest.parentHash,
    snapshotId: latest.snapshotId,
    stateHash: latest.stateHash,
    source: latest.source,
    sourceRegistryId: latest.sourceRegistryId,
    maxFreshnessBlocks: options.maxFreshnessBlocks,
    hookAddress: reviewedShape.hooks,
    hookData: reviewedShape.hookData,
    hookDataStatus: "empty",
    zoraProvenance: latest.zoraProvenance,
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
  const reservePoolsById = new Map(
    entries
      .map(({ entry }) => entry)
      .filter(
        (entry): entry is ReserveQuotePool =>
          entry !== undefined && isReserveQuotePool(entry),
      )
      .map((entry) => [entry.id, entry]),
  );
  const clReplayPoolsById = new Map(
    entries
      .map(({ entry }) => entry)
      .filter(
        (entry): entry is ClReplayPool =>
          entry !== undefined && isClReplayPool(entry),
      )
      .map((entry) => [entry.id, entry]),
  );
  const v4ClReplayPoolsById = new Map(
    entries
      .map(({ entry }) => entry)
      .filter(
        (entry): entry is V4ClReplayPool =>
          entry !== undefined && isV4ClReplayPool(entry),
      )
      .map((entry) => [entry.id, entry]),
  );
  const clReplayPools = [...clReplayPoolsById.values()];
  const v4ClReplayPools = [...v4ClReplayPoolsById.values()];
  const reserveStates = await batchGetLatestPoolStates({
    db,
    tableName,
    pools: [...reservePoolsById.values()],
  });
  const latestStates = await batchGetLatestClReplayPointers({
    db,
    tableName,
    pools: clReplayPools,
  });
  const v4LatestStates = await batchGetLatestV4ClReplayPointers({
    db,
    tableName,
    pools: v4ClReplayPools,
  });
  const maintenanceStates = await batchGetLatestClReplayMaintenanceStates({
    db,
    tableName,
    pools: clReplayPools,
  });
  const maintenanceStatesByPoolId = new Map(
    maintenanceStates.map((state) => [state.poolId, state]),
  );
  const v4MaintenanceStates =
    await batchGetLatestV4ClReplayMaintenanceStates({
      db,
      tableName,
      pools: v4ClReplayPools,
    });
  const v4MaintenanceStatesByPoolId = new Map(
    v4MaintenanceStates.map((state) => [state.poolId, state]),
  );
  const freshLatestStates = latestStates.filter((latest) => {
    const entry = clReplayPoolsById.get(latest.poolId);
    const maintenance = maintenanceStatesByPoolId.get(latest.poolId);
    return (
      entry !== undefined &&
      clReplayLatestStateMatchesRegistry({ latest, entry, sourceRegistryId }) &&
      clReplayMaintenanceCompatible({
        maintenance,
        latest,
        sourceRegistryId,
      }) &&
      freshnessStatus({
        state: latest,
        currentBlock: parsed.currentBlock,
        maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
      }) === "fresh"
    );
  });
  const freshV4LatestStates = v4LatestStates.filter((latest) => {
    const entry = v4ClReplayPoolsById.get(latest.poolId);
    const maintenance = v4MaintenanceStatesByPoolId.get(latest.poolId);
    return (
      entry !== undefined &&
      v4ClReplayLatestStateMatchesRegistry({
        latest,
        entry,
        sourceRegistryId,
      }) &&
      v4AdmissionUnavailableReason({ entry, latest }) === null &&
      v4ClReplayMaintenanceCompatible({
        maintenance,
        latest,
        sourceRegistryId,
      }) &&
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
  const v4ClReplayStates = await batchGetV4ClReplayStateCapsules({
    db,
    tableName,
    latestStates: freshV4LatestStates,
  });
  const latestStatesByPoolId = new Map(
    latestStates.map((state) => [state.poolId, state]),
  );
  const v4LatestStatesByPoolId = new Map(
    v4LatestStates.map((state) => [state.poolId, state]),
  );
  const reserveStatesByAddress = new Map(
    reserveStates.map((state) => [
      addressStateKey(state.chainId, state.poolAddress),
      state,
    ]),
  );
  const v4ReplayStatesByPoolKey = new Map(
    v4ClReplayStates.map((state) => [
      poolKeyStateKey(state.latest.chainId, state.latest.poolKey),
      state,
    ]),
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
      if (isReserveQuotePool(entry)) {
        const state = reserveStatesByAddress.get(
          addressStateKey(entry.chainId, entry.poolAddress),
        );
        if (!state) {
          return unavailable(requested, "missing-indexed-state", {
            poolId: entry.id,
            chainId: entry.chainId,
            poolAddress: entry.poolAddress,
          });
        }
        if (state.sourceRegistryId !== sourceRegistryId) {
          return unavailable(requested, "source-registry-mismatch", {
            poolId: entry.id,
            chainId: entry.chainId,
            poolAddress: entry.poolAddress,
            observedThroughBlock: state.observedThroughBlock,
            sourceRegistryId: state.sourceRegistryId,
            maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
          });
        }
        if (!reserveStateMatchesRegistry({ state, entry, sourceRegistryId })) {
          return unavailable(requested, "missing-indexed-state", {
            poolId: entry.id,
            chainId: entry.chainId,
            poolAddress: entry.poolAddress,
            observedThroughBlock: state.observedThroughBlock,
            sourceRegistryId: state.sourceRegistryId,
            maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
          });
        }
        if (
          freshnessStatus({
            state,
            currentBlock: parsed.currentBlock,
            maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
          }) === "stale"
        ) {
          return unavailable(requested, "stale-indexed-state", {
            poolId: entry.id,
            chainId: entry.chainId,
            poolAddress: entry.poolAddress,
            observedThroughBlock: state.observedThroughBlock,
            sourceRegistryId: state.sourceRegistryId,
            maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
          });
        }

        return quoteFromReserveState({
          request: requested,
          state,
          entry,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });
      }
      if (isV4ClReplayPool(entry)) {
        const latest = v4LatestStatesByPoolId.get(entry.id);
        if (!latest) {
          return unavailable(
            requested,
            "missing-indexed-state",
            v4PoolMetadata(entry),
          );
        }
        if (latest.sourceRegistryId !== sourceRegistryId) {
          return unavailable(
            requested,
            "source-registry-mismatch",
            v4QuoteMetadata(latest, effectiveMaxFreshnessBlocks),
          );
        }
        const latestUnavailableReason = v4ClReplayLatestUnavailableReason({
          latest,
          entry,
          sourceRegistryId,
        });
        if (latestUnavailableReason !== null) {
          return unavailable(
            requested,
            latestUnavailableReason,
            v4QuoteMetadata(latest, effectiveMaxFreshnessBlocks),
          );
        }
        if (
          freshnessStatus({
            state: latest,
            currentBlock: parsed.currentBlock,
            maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
          }) === "stale"
        ) {
          return unavailable(
            requested,
            "stale-indexed-state",
            v4QuoteMetadata(latest, effectiveMaxFreshnessBlocks),
          );
        }
        const admissionReason = v4AdmissionUnavailableReason({
          entry,
          latest,
        });
        if (admissionReason !== null) {
          return unavailable(
            requested,
            admissionReason,
            v4QuoteMetadata(latest, effectiveMaxFreshnessBlocks),
          );
        }
        const maintenance = v4MaintenanceStatesByPoolId.get(entry.id);
        if (
          !v4ClReplayMaintenanceCompatible({
            maintenance,
            latest,
            sourceRegistryId,
          })
        ) {
          return unavailable(
            requested,
            "producer-untrusted",
            {
              ...v4QuoteMetadata(latest, effectiveMaxFreshnessBlocks),
              producerStatus: maintenance?.status,
              producerReason: safeProducerReason(maintenance?.reason),
            },
          );
        }

        const state = v4ReplayStatesByPoolKey.get(
          poolKeyStateKey(entry.chainId, entry.poolKey),
        );
        if (
          !state ||
          !v4ClReplayStateMatchesRegistry({ state, entry, sourceRegistryId })
        ) {
          return unavailable(
            requested,
            "missing-indexed-state",
            v4QuoteMetadata(latest, effectiveMaxFreshnessBlocks),
          );
        }

        return quoteFromV4ReplayState({
          request: requested,
          state,
          entry,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
        });
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
      if (
        !clReplayLatestStateMatchesRegistry({ latest, entry, sourceRegistryId })
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
      const maintenance = maintenanceStatesByPoolId.get(entry.id);
      if (
        !clReplayMaintenanceCompatible({
          maintenance,
          latest,
          sourceRegistryId,
        })
      ) {
        return unavailable(requested, "producer-untrusted", {
          poolId: entry.id,
          chainId: entry.chainId,
          poolAddress: entry.poolAddress,
          observedThroughBlock: latest.observedThroughBlock,
          sourceRegistryId: latest.sourceRegistryId,
          maxFreshnessBlocks: effectiveMaxFreshnessBlocks,
          producerStatus: maintenance?.status,
          producerReason: safeProducerReason(maintenance?.reason),
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
