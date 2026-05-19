import type { Address, Hex } from "viem";

export const FAME_POOL_STATE_REGISTRY_SCHEMA_VERSION = 1;

export type FamePoolStateVenue =
  | "aerodrome-slipstream"
  | "aerodrome-slipstream2"
  | "aerodrome-v2"
  | "native-wrap"
  | "solidly"
  | "uniswap-v2"
  | "uniswap-v3"
  | "uniswap-v4";

export type FamePoolStateVenueFamily =
  | "AerodromeV2"
  | "NativeWrap"
  | "Slipstream"
  | "Slipstream2"
  | "Solidly"
  | "UniswapV2"
  | "UniswapV3"
  | "UniswapV4";

export type FamePoolStateCapability = "quote-model" | "tracked-only";
export type FamePoolStateQuoteModel = "constant-product-reserves";
export type FamePoolStateUnsupportedReason =
  | "concentrated-liquidity"
  | "missing-fee-metadata"
  | "native-wrap"
  | "stable-pool"
  | "unsupported-venue";

export type FamePoolStateFeeDescriptor =
  | {
      status: "available";
      feeBps: number;
      label: string;
      source: "pool-metadata";
    }
  | {
      status: "unavailable";
      reason: string;
    };

export interface FamePoolStateRegistrySource {
  repo: "www";
  schemaVersion: number;
  pinnedBaseBlock: number;
  poolsJsonHash: Hex;
  poolsContentHash: Hex;
  solverRoutesJsonHash: Hex;
  solverRoutesContentHash: Hex;
}

export interface FamePoolStateRegistryDirection {
  tokenIn: Address;
  tokenOut: Address;
}

export interface FamePoolStateRegistryEntry {
  id: string;
  chainId: 8453;
  venue: FamePoolStateVenue;
  venueFamily: FamePoolStateVenueFamily;
  router: Address;
  poolAddress: Address | null;
  poolKey: Hex | null;
  token0: Address;
  token1: Address;
  stable: boolean | null;
  fee: FamePoolStateFeeDescriptor;
  capability: FamePoolStateCapability;
  quoteModel: FamePoolStateQuoteModel | null;
  unsupportedReason: FamePoolStateUnsupportedReason | null;
}

export interface FamePoolStateRegistryFile {
  schemaVersion: typeof FAME_POOL_STATE_REGISTRY_SCHEMA_VERSION;
  status: "generated-reviewed-route-candidates";
  source: FamePoolStateRegistrySource;
  candidateDirections: FamePoolStateRegistryDirection[];
  pools: FamePoolStateRegistryEntry[];
}
