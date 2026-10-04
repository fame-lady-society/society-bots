import { createHash } from "node:crypto";
import { isAddress, type Address, type Hex } from "viem";
import type { FamePoolStateRegistryFile } from "../fame-swap-pool-state/types.ts";

export const FAME_ADDRESS = "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418";
export const CHAIN_ID = 8453;
export const SCHEMA = "fame-market-raw-v1";

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function integer(value: unknown, name: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`Invalid ${name}: expected a safe integer >= ${minimum}`);
  }
  return value;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

export function hash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Invalid block/transaction hash");
  }
  return value.toLowerCase() as Hex;
}

export interface Pool {
  id: string;
  address: Address;
  token0: Address;
  token1: Address;
  venueFamily: string;
}

export interface Scope {
  id: string;
  pools: Pool[];
  registry: FamePoolStateRegistryFile;
}

/** Capture ALL emitting logs for exact direct-pool addresses. No guessed ABI filters. */
export function historyScope(registry: FamePoolStateRegistryFile): Scope {
  const pools = registry.pools
    .filter((pool) =>
      [pool.token0.toLowerCase(), pool.token1.toLowerCase()].includes(
        FAME_ADDRESS,
      ),
    )
    .map((pool): Pool => {
      if (
        pool.chainId !== CHAIN_ID ||
        !pool.poolAddress ||
        pool.poolKey ||
        pool.venueFamily === "UniswapV4"
      ) {
        throw new Error(
          `History needs a reviewed identity filter for ${pool.id}`,
        );
      }
      if (!isAddress(pool.poolAddress, { strict: false }))
        throw new Error("Invalid pool address");
      return {
        id: pool.id,
        address: pool.poolAddress.toLowerCase() as Address,
        token0: pool.token0.toLowerCase() as Address,
        token1: pool.token1.toLowerCase() as Address,
        venueFamily: pool.venueFamily,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    pools.length === 0 ||
    pools.length > 20 ||
    new Set(pools.map((p) => p.address)).size !== pools.length
  ) {
    throw new Error("History requires 1–20 unique direct pool addresses");
  }
  // Quote-only registry changes do not reset raw event coverage; identity/filter changes do.
  return {
    id: digest(
      JSON.stringify({
        schema: SCHEMA,
        chainId: CHAIN_ID,
        filter: "all-address-logs",
        pools,
      }),
    ),
    pools,
    registry,
  };
}

export interface Header {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
}
export interface RawLog {
  address: Address;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  topics: Hex[];
  data: Hex;
  removed: boolean;
}
export interface ArchivedLog extends RawLog {
  poolId: string;
  blockTimestamp: number;
}
export interface Cursor {
  nextBlock: number;
  previousHash: Hex | null;
  startBlock: number;
  maxBlocks?: number;
}
export interface Manifest {
  schema: typeof SCHEMA;
  scopeId: string;
  fromBlock: number;
  toBlock: number;
  firstHash: Hex;
  lastHash: Hex;
  previousHash: Hex;
  eventCount: number;
  key: string;
  sha256: string;
  contentSha256: string;
  bytes: number;
  eventIdentityDigest: string;
}

export interface ArchiveBatch {
  schema: typeof SCHEMA;
  scope: Scope;
  fromBlock: number;
  toBlock: number;
  headers: Header[];
  events: ArchivedLog[];
  observations: LiquidityObservation[];
}

export interface LiquidityObservation {
  poolId: string;
  status: "available" | "missing";
  /** Latest quote observations may be newer than finalized event coverage. */
  finality: "source-observation-unverified";
  state?: Record<string, string | number>;
}

export function validateLogs(
  logs: RawLog[],
  scope: Scope,
  from: number,
  to: number,
  headers: Map<number, Header>,
): ArchivedLog[] {
  const pools = new Map(
    scope.pools.map((pool) => [pool.address.toLowerCase(), pool.id]),
  );
  const unique = new Map<string, ArchivedLog>();
  const positions = new Map<string, string>();
  for (const log of logs) {
    const poolId = pools.get(log.address.toLowerCase());
    const blockNumber = integer(log.blockNumber, "log block");
    const header = headers.get(blockNumber);
    if (
      !poolId ||
      log.removed ||
      blockNumber < from ||
      blockNumber > to ||
      !header ||
      hash(log.blockHash) !== header.hash
    ) {
      throw new Error("Log identity/range/canonical header mismatch");
    }
    integer(log.transactionIndex, "transaction index");
    integer(log.logIndex, "log index");
    hash(log.transactionHash);
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(log.data) || log.topics.length > 4)
      throw new Error("Malformed event bytes");
    log.topics.forEach(hash);
    const event: ArchivedLog = {
      ...log,
      address: log.address.toLowerCase() as Address,
      poolId,
      blockTimestamp: header.timestamp,
    };
    const id = `${header.hash}:${log.logIndex}`;
    const old = unique.get(id);
    if (old && JSON.stringify(old) !== JSON.stringify(event))
      throw new Error("Conflicting duplicate event");
    const position = `${blockNumber}:${log.logIndex}`;
    if (positions.has(position) && positions.get(position) !== id)
      throw new Error("Conflicting block identity");
    positions.set(position, id);
    unique.set(id, event);
  }
  return [...unique.values()].sort(
    (a, b) =>
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex,
  );
}
