import type { Address } from "viem";
import { baseClient } from "@/viem.ts";
import {
  batchGetLatestPoolStates,
  defaultDb,
  type PoolStateDocumentClient,
} from "./dynamodb/pool-state.ts";
import {
  getCurrentFameLandingSnapshot,
  publishFameLandingSnapshot,
  type PublishFameLandingSnapshotResult,
} from "./dynamodb/landing-snapshot.ts";
import {
  FAME_LANDING_SNAPSHOT_CONTENT_TTL_SECONDS,
  FAME_LANDING_SNAPSHOT_LEAF_TIMEOUT_MS,
  FAME_LANDING_SNAPSHOT_RUN_TIMEOUT_MS,
  fameLandingAuthority,
  type FameLandingSnapshot,
} from "./landing-snapshot.ts";
import {
  produceFameLandingSnapshot,
  type FameLandingSnapshotProducerDependencies,
} from "./landing-snapshot-producer.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type { FamePoolStateIndexerResult } from "./indexer.ts";

const MARKETPLACE = "0x54e7E4F2d439Be599706f51068f7EB2ce2D2a27e" as Address;
const MIRROR = "0xBB5ED04dD7B207592429eb8d599d103CCad646c4" as Address;
const CREATOR_MAGIC = "0xC8268c2aa571F3C88044C2959F73DdB8eB9e139F" as Address;

const addressAbi = (name: string) =>
  [
    {
      type: "function",
      name,
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "address" }],
    },
  ] as const;
const boolAbi = (name: string) =>
  [
    {
      type: "function",
      name,
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "bool" }],
    },
  ] as const;
const uintAbi = (name: string, bits = 256) =>
  [
    {
      type: "function",
      name,
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: `uint${bits}` }],
    },
  ] as const;
const balanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface FameLandingMulticallClient {
  multicall(options: {
    allowFailure: false;
    blockNumber: bigint;
    contracts: readonly Record<string, unknown>[];
  }): Promise<readonly unknown[]>;
}

function sameAddress(left: unknown, right: Address): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

function requiredBigint(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`Landing marketplace ${field} is invalid.`);
  }
  return value;
}

function requiredDecimals(value: unknown): number {
  const decimals =
    typeof value === "number"
      ? value
      : typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Landing marketplace decimals are invalid.");
  }
  return decimals;
}

export function createFameLandingSnapshotDependencies({
  tableName,
  db = defaultDb,
  rpc = baseClient as unknown as FameLandingMulticallClient,
}: {
  tableName: string;
  db?: PoolStateDocumentClient;
  rpc?: FameLandingMulticallClient;
}): FameLandingSnapshotProducerDependencies {
  return {
    async readMarketplace({ blockNumber }) {
      const fame = fameLandingAuthority.fameToken;
      const values = await rpc.multicall({
        allowFailure: false,
        blockNumber,
        contracts: [
          {
            address: MARKETPLACE,
            abi: addressAbi("fame"),
            functionName: "fame",
          },
          {
            address: MARKETPLACE,
            abi: addressAbi("mirror"),
            functionName: "mirror",
          },
          {
            address: MARKETPLACE,
            abi: addressAbi("creatorMagic"),
            functionName: "creatorMagic",
          },
          {
            address: MARKETPLACE,
            abi: boolAbi("paused"),
            functionName: "paused",
          },
          {
            address: MARKETPLACE,
            abi: uintAbi("premium"),
            functionName: "premium",
          },
          {
            address: MARKETPLACE,
            abi: uintAbi("totalProviderUnits"),
            functionName: "totalProviderUnits",
          },
          {
            address: MARKETPLACE,
            abi: uintAbi("activeProviderCount"),
            functionName: "activeProviderCount",
          },
          {
            address: MARKETPLACE,
            abi: uintAbi("inventory"),
            functionName: "inventory",
          },
          { address: fame, abi: uintAbi("unit"), functionName: "unit" },
          {
            address: fame,
            abi: uintAbi("totalSupply"),
            functionName: "totalSupply",
          },
          {
            address: fame,
            abi: uintAbi("decimals", 8),
            functionName: "decimals",
          },
        ],
      });
      if (
        values.length !== 11 ||
        !sameAddress(values[0], fame) ||
        !sameAddress(values[1], MIRROR) ||
        !sameAddress(values[2], CREATOR_MAGIC) ||
        typeof values[3] !== "boolean"
      ) {
        throw new Error(
          "Landing marketplace authority is incomplete or mismatched.",
        );
      }
      requiredBigint(values[5], "totalProviderUnits");
      requiredBigint(values[6], "activeProviderCount");
      requiredBigint(values[7], "inventory");
      const decimals = requiredDecimals(values[10]);
      return {
        premium: requiredBigint(values[4], "premium"),
        unit: requiredBigint(values[8], "unit"),
        totalSupply: requiredBigint(values[9], "totalSupply"),
        decimals,
      };
    },
    async readReserveStates({ poolIds }) {
      const wanted = new Set(poolIds);
      const pools = famePoolStateRegistry.pools.filter(
        (pool): pool is typeof pool & { poolAddress: Address } =>
          wanted.has(pool.id) && pool.poolAddress !== null,
      );
      if (pools.length !== wanted.size) {
        throw new Error("Landing reserve pool authority is incomplete.");
      }
      return batchGetLatestPoolStates({ db, tableName, pools });
    },
    async readConcentratedPoolBalances({
      blockNumber,
      poolId,
      poolAddress,
      tokenAddresses,
    }) {
      const values = await rpc.multicall({
        allowFailure: false,
        blockNumber,
        contracts: tokenAddresses.map((address) => ({
          address,
          abi: balanceOfAbi,
          functionName: "balanceOf",
          args: [poolAddress],
        })),
      });
      if (values.length !== tokenAddresses.length) {
        throw new Error("Landing concentrated balances are incomplete.");
      }
      return {
        poolId,
        balances: Object.fromEntries(
          tokenAddresses.map((address, index) => [
            address.toLowerCase(),
            requiredBigint(values[index], `balance:${address.toLowerCase()}`),
          ]),
        ),
      };
    },
  };
}

class FameLandingRunDeadlineError extends Error {
  constructor() {
    super("FAME landing snapshot run deadline exceeded.");
    this.name = "FameLandingRunDeadlineError";
  }
}

async function withRunDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new FameLandingRunDeadlineError()),
      timeoutMs,
    );
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export interface FameLandingPublication {
  snapshot: FameLandingSnapshot;
  publication: PublishFameLandingSnapshotResult;
}

export async function produceAndPublishFameLandingSnapshot({
  indexResult,
  tableName,
  db = defaultDb,
  deps = createFameLandingSnapshotDependencies({ tableName, db }),
  capturedAt = new Date(),
  runTimeoutMs = FAME_LANDING_SNAPSHOT_RUN_TIMEOUT_MS,
  leafTimeoutMs = FAME_LANDING_SNAPSHOT_LEAF_TIMEOUT_MS,
  ttlSeconds = FAME_LANDING_SNAPSHOT_CONTENT_TTL_SECONDS,
}: {
  indexResult: FamePoolStateIndexerResult;
  tableName: string;
  db?: PoolStateDocumentClient;
  deps?: FameLandingSnapshotProducerDependencies;
  capturedAt?: Date;
  runTimeoutMs?: number;
  leafTimeoutMs?: number;
  ttlSeconds?: number;
}): Promise<FameLandingPublication> {
  if (
    !Number.isSafeInteger(runTimeoutMs) ||
    runTimeoutMs <= 0 ||
    !Number.isSafeInteger(leafTimeoutMs) ||
    leafTimeoutMs <= 0 ||
    leafTimeoutMs > runTimeoutMs
  ) {
    throw new Error("Landing run and leaf deadlines are invalid.");
  }
  return withRunDeadline(
    (async () => {
      let previousSnapshot: FameLandingSnapshot | null = null;
      try {
        previousSnapshot = await getCurrentFameLandingSnapshot({
          db,
          tableName,
        });
      } catch {
        // A warm start is optional; a corrupt prior pointer must not poison a new pass.
      }
      const snapshot = await produceFameLandingSnapshot({
        chainId: indexResult.chainId,
        safeBlockNumber: indexResult.observedThroughBlock,
        safeBlockHash: indexResult.safeBlockHash,
        capturedAt,
        deps,
        previousSnapshot,
        leafTimeoutMs,
      });
      const publication = await publishFameLandingSnapshot({
        db,
        tableName,
        snapshot,
        publishedAt: capturedAt,
        ttlSeconds,
      });
      return { snapshot, publication };
    })(),
    runTimeoutMs,
  );
}
