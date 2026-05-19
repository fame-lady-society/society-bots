import type { Address, Hex } from "viem";
import {
  Uint256ReserveSyncEvent,
  UniswapV2PairReserveAbi,
  UniswapV2SyncEvent,
} from "@/events.ts";
import type { baseClient } from "@/viem.ts";
import {
  batchGetLatestPoolStates,
  getPoolStateCursor,
  latestStateFromReserves,
  markPoolObservedThroughBlock,
  putLatestPoolState,
  setPoolStateCursor,
  sourceRegistryIdFor,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateRegistryFile,
} from "./types.ts";

type QuoteModelPool = FamePoolStateRegistryEntry & { poolAddress: Address };
type FamePoolStateSyncEventKind = "uint112-reserves" | "uint256-reserves";

export interface FamePoolStateSyncLog {
  address: Address;
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
  transactionHash: Hex;
  args: {
    reserve0: bigint;
    reserve1: bigint;
  };
}

export interface FamePoolStateIndexerClient {
  chain: {
    id: number;
  };
  getBlockNumber(): Promise<bigint>;
  getSyncLogs(options: {
    pools: readonly QuoteModelPool[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly FamePoolStateSyncLog[]>;
  getReserves(options: {
    poolAddress: Address;
    blockNumber: bigint;
  }): Promise<readonly [bigint, bigint, number]>;
}

export interface FamePoolStateIndexerResult {
  chainId: number;
  durationMs: number;
  fromBlock: number;
  observedThroughBlock: number;
  syncEvents: number;
  writtenEvents: number;
  ignoredEvents: number;
  seededPools: number;
  reconciledPools: number;
  observedPools: number;
  sourceRegistryId: string;
}

function quoteModelPools(
  registry: FamePoolStateRegistryFile,
): QuoteModelPool[] {
  return registry.pools.filter(
    (pool): pool is QuoteModelPool =>
      pool.capability === "quote-model" && pool.poolAddress !== null,
  );
}

function syncEventKind(pool: QuoteModelPool): FamePoolStateSyncEventKind {
  if (pool.venue === "uniswap-v2") return "uint112-reserves";
  if (pool.venue === "solidly" || pool.venue === "aerodrome-v2") {
    return "uint256-reserves";
  }
  throw new Error(`${pool.id} has no supported Sync event kind.`);
}

function addressKey(address: Address): string {
  return address.toLowerCase();
}

function safeNumber(value: bigint, name: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${name} exceeds Number.MAX_SAFE_INTEGER.`);
  }
  return Number(value);
}

function safeHeadBlock(
  latestBlock: bigint,
  confirmationBlocks: number,
): bigint {
  const confirmations = BigInt(confirmationBlocks);
  return latestBlock > confirmations
    ? latestBlock - confirmations
    : latestBlock;
}

function sortedLogs(
  logs: readonly FamePoolStateSyncLog[],
): FamePoolStateSyncLog[] {
  return [...logs].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber < right.blockNumber ? -1 : 1;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex;
    }
    return left.logIndex - right.logIndex;
  });
}

function reservesDiffer(
  latest: { reserve0: string; reserve1: string } | null,
  reserve0: bigint,
  reserve1: bigint,
): boolean {
  return (
    latest === null ||
    latest.reserve0 !== reserve0.toString() ||
    latest.reserve1 !== reserve1.toString()
  );
}

function stateNeedsReconciliation({
  latest,
  pool,
  reserve0,
  reserve1,
  sourceRegistryId,
}: {
  latest: {
    poolId: string;
    reserve0: string;
    reserve1: string;
    sourceRegistryId: string;
  } | null;
  pool: QuoteModelPool;
  reserve0: bigint;
  reserve1: bigint;
  sourceRegistryId: string;
}): boolean {
  if (latest === null) return true;
  return (
    reservesDiffer(latest, reserve0, reserve1) ||
    latest.poolId !== pool.id ||
    latest.sourceRegistryId !== sourceRegistryId
  );
}

export function createViemPoolStateIndexerClient(
  client: typeof baseClient,
): FamePoolStateIndexerClient {
  return {
    chain: {
      id: client.chain.id,
    },
    getBlockNumber() {
      return client.getBlockNumber();
    },
    async getSyncLogs({ pools, fromBlock, toBlock }) {
      const uint112Addresses = pools
        .filter((pool) => syncEventKind(pool) === "uint112-reserves")
        .map((pool) => pool.poolAddress);
      const uint256Addresses = pools
        .filter((pool) => syncEventKind(pool) === "uint256-reserves")
        .map((pool) => pool.poolAddress);
      const logsByKind = await Promise.all([
        uint112Addresses.length === 0
          ? Promise.resolve([])
          : client.getLogs({
              address: uint112Addresses,
              event: UniswapV2SyncEvent,
              fromBlock,
              toBlock,
              strict: true,
            }),
        uint256Addresses.length === 0
          ? Promise.resolve([])
          : client.getLogs({
              address: uint256Addresses,
              event: Uint256ReserveSyncEvent,
              fromBlock,
              toBlock,
              strict: true,
            }),
      ]);
      return logsByKind.flat().map((log) => ({
        address: log.address,
        blockNumber: log.blockNumber,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        transactionHash: log.transactionHash,
        args: {
          reserve0: log.args.reserve0,
          reserve1: log.args.reserve1,
        },
      }));
    },
    getReserves({ poolAddress, blockNumber }) {
      return client.readContract({
        address: poolAddress,
        abi: UniswapV2PairReserveAbi,
        functionName: "getReserves",
        blockNumber,
      });
    },
  };
}

export async function indexFamePoolStates({
  client,
  tableName,
  db,
  registry = famePoolStateRegistry,
  confirmationBlocks = 2,
  now = new Date(),
}: {
  client: FamePoolStateIndexerClient;
  tableName: string;
  db?: PoolStateDocumentClient;
  registry?: FamePoolStateRegistryFile;
  confirmationBlocks?: number;
  now?: Date;
}): Promise<FamePoolStateIndexerResult> {
  const startedAtMs = Date.now();
  const pools = quoteModelPools(registry);
  const sourceRegistryId = sourceRegistryIdFor(registry.source);
  const latestBlock = await client.getBlockNumber();
  const safeBlock = safeHeadBlock(latestBlock, confirmationBlocks);
  const observedThroughBlock = safeNumber(safeBlock, "safe head block");
  const cursor = await getPoolStateCursor({
    db,
    tableName,
    chainId: client.chain.id,
  });
  const fromBlock = Math.min(
    observedThroughBlock,
    (cursor?.observedThroughBlock ?? observedThroughBlock) + 1,
  );
  const previousObservedThroughBlock = cursor?.observedThroughBlock ?? 0;
  const writeObservedThroughBlock = Math.min(
    previousObservedThroughBlock,
    observedThroughBlock,
  );
  const updatedAt = now.toISOString();
  const poolByAddress = new Map(
    pools.map((pool) => [addressKey(pool.poolAddress), pool]),
  );

  let writtenEvents = 0;
  let ignoredEvents = 0;
  const logs =
    pools.length === 0 || fromBlock > observedThroughBlock
      ? []
      : await client.getSyncLogs({
          pools,
          fromBlock: BigInt(fromBlock),
          toBlock: safeBlock,
        });
  const reserveSnapshots = new Map(
    await Promise.all(
      pools.map(async (pool) => {
        const [reserve0, reserve1] = await client.getReserves({
          poolAddress: pool.poolAddress,
          blockNumber: safeBlock,
        });
        return [addressKey(pool.poolAddress), { reserve0, reserve1 }] as const;
      }),
    ),
  );

  for (const log of sortedLogs(logs)) {
    const pool = poolByAddress.get(addressKey(log.address));
    if (!pool) {
      throw new Error(`Sync log came from unregistered pool ${log.address}.`);
    }

    const result = await putLatestPoolState({
      db,
      tableName,
      state: latestStateFromReserves({
        pool,
        reserve0: log.args.reserve0,
        reserve1: log.args.reserve1,
        observedThroughBlock: writeObservedThroughBlock,
        version: {
          blockNumber: safeNumber(log.blockNumber, "Sync event block number"),
          transactionIndex: log.transactionIndex,
          logIndex: log.logIndex,
        },
        transactionHash: log.transactionHash,
        source: "sync-event",
        sourceRegistryId,
        updatedAt,
      }),
    });
    if (result === "written") writtenEvents += 1;
    else ignoredEvents += 1;
  }

  let seededPools = 0;
  let reconciledPools = 0;
  let observedPools = 0;
  const latestStates = await batchGetLatestPoolStates({
    db,
    tableName,
    pools,
  });
  const latestByAddress = new Map(
    latestStates.map((state) => [addressKey(state.poolAddress), state]),
  );

  for (const pool of pools) {
    const latest = latestByAddress.get(addressKey(pool.poolAddress)) ?? null;
    const reserves = reserveSnapshots.get(addressKey(pool.poolAddress));
    if (!reserves) {
      throw new Error(`${pool.id} missing reserve snapshot.`);
    }
    const { reserve0, reserve1 } = reserves;
    if (
      stateNeedsReconciliation({
        latest,
        pool,
        reserve0,
        reserve1,
        sourceRegistryId,
      })
    ) {
      const result = await putLatestPoolState({
        db,
        tableName,
        state: latestStateFromReserves({
          pool,
          reserve0,
          reserve1,
          observedThroughBlock: writeObservedThroughBlock,
          version: {
            blockNumber: observedThroughBlock,
            transactionIndex: Number.MAX_SAFE_INTEGER,
            logIndex: Number.MAX_SAFE_INTEGER,
          },
          transactionHash: null,
          source: "getReserves",
          sourceRegistryId,
          updatedAt,
        }),
      });
      if (result === "written") {
        if (latest) reconciledPools += 1;
        else seededPools += 1;
      }
    }
  }

  for (const pool of pools) {
    await markPoolObservedThroughBlock({
      db,
      tableName,
      chainId: pool.chainId,
      poolAddress: pool.poolAddress,
      observedThroughBlock,
      sourceRegistryId,
      updatedAt,
    });
    observedPools += 1;
  }

  await setPoolStateCursor({
    db,
    tableName,
    chainId: client.chain.id,
    observedThroughBlock,
    sourceRegistryId,
    updatedAt,
  });

  return {
    chainId: client.chain.id,
    durationMs: Date.now() - startedAtMs,
    fromBlock,
    observedThroughBlock,
    syncEvents: logs.length,
    writtenEvents,
    ignoredEvents,
    seededPools,
    reconciledPools,
    observedPools,
    sourceRegistryId,
  };
}
