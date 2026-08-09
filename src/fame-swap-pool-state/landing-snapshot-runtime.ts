import type { Address, ContractFunctionParameters, Hex } from "viem";
import { UniswapV2PairReserveAbi } from "@/events.ts";
import {
  getCanonicalBlockIdentity,
  multicallAtBlockHash,
  type CanonicalBlockIdentity,
} from "./block-hash-multicall.ts";
import {
  batchGetLatestPoolStatesForLanding,
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
import {
  famePoolStateRegistry,
  getFamePoolStateRegistryEntry,
} from "./registry/index.ts";
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
const getAmountOutAbi = [
  {
    type: "function",
    name: "getAmountOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "tokenIn", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface FameLandingMulticallClient {
  multicall(options: {
    allowFailure: boolean;
    blockNumber: bigint;
    blockHash: Hex;
    signal: AbortSignal;
    contracts: readonly ContractFunctionParameters[];
  }): Promise<readonly unknown[]>;
}

const defaultFameLandingMulticallClient: FameLandingMulticallClient = {
  multicall({ allowFailure, blockHash, signal, contracts }) {
    return multicallAtBlockHash({
      allowFailure,
      blockHash,
      signal,
      contracts,
    });
  },
};

function sameAddress(left: unknown, right: Address): boolean {
  return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

interface ApprovedRuntimePool {
  poolId: string;
  poolAddress: Address;
}

interface ApprovedRuntimeQuoteDirection extends ApprovedRuntimePool {
  tokenIn: Address;
}

function landingRuntimeAuthority(): {
  pools: Map<string, ApprovedRuntimePool>;
  quotes: Map<string, ApprovedRuntimeQuoteDirection[]>;
} {
  const pools = new Map<string, ApprovedRuntimePool>();
  const quotes = new Map<string, ApprovedRuntimeQuoteDirection[]>();
  for (const capability of fameLandingAuthority.capabilities) {
    if (
      capability.status !== "enabled" ||
      capability.evaluator !== "constant-product-runtime-validated-v1"
    ) {
      continue;
    }
    const definition = fameLandingAuthority.quoteDefinitions.find(
      ({ id }) => id === capability.quoteDefinitionId,
    );
    const asset = fameLandingAuthority.assets.find(
      ({ currency }) => currency === definition?.currency,
    );
    if (!definition || !asset) {
      throw new Error("Landing runtime authority is incomplete.");
    }
    for (const template of capability.routeTemplates) {
      let currentToken =
        definition.mode === "exactInput"
          ? fameLandingAuthority.fameToken
          : (asset.wrappedAddress ?? asset.address);
      for (const poolId of template.legs) {
        const pool = getFamePoolStateRegistryEntry({ poolId });
        if (!pool?.poolAddress) {
          throw new Error("Landing runtime authority pool is incomplete.");
        }
        if (pool.capability === "tracked-only") {
          const approved = {
            poolId,
            poolAddress: pool.poolAddress,
            tokenIn: currentToken,
          };
          pools.set(poolId, approved);
          quotes.set(capability.quoteDefinitionId, [
            ...(quotes.get(capability.quoteDefinitionId) ?? []),
            approved,
          ]);
        }
        if (sameAddress(currentToken, pool.token0)) {
          currentToken = pool.token1;
        } else if (sameAddress(currentToken, pool.token1)) {
          currentToken = pool.token0;
        } else {
          throw new Error("Landing runtime authority route is disconnected.");
        }
      }
    }
  }
  return { pools, quotes };
}

const APPROVED_RUNTIME_AUTHORITY = landingRuntimeAuthority();

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

function requiredReserveTuple(
  value: unknown,
  poolId: string,
): readonly [bigint, bigint] {
  if (
    !Array.isArray(value) ||
    typeof value[0] !== "bigint" ||
    typeof value[1] !== "bigint" ||
    value[0] <= 0n ||
    value[1] <= 0n
  ) {
    throw new Error(`Landing runtime reserves are invalid for ${poolId}.`);
  }
  return [value[0], value[1]];
}

export function createFameLandingSnapshotDependencies({
  tableName,
  db = defaultDb,
  rpc = defaultFameLandingMulticallClient,
}: {
  tableName: string;
  db?: PoolStateDocumentClient;
  rpc?: FameLandingMulticallClient;
}): FameLandingSnapshotProducerDependencies {
  return {
    async readMarketplace({ blockNumber, blockHash, signal }) {
      const fame = fameLandingAuthority.fameToken;
      const values = await rpc.multicall({
        allowFailure: false,
        blockNumber,
        blockHash,
        signal,
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
    async readReserveStates({ poolIds, signal }) {
      const wanted = new Set(poolIds);
      const pools = famePoolStateRegistry.pools.filter(
        (pool): pool is typeof pool & { poolAddress: Address } =>
          wanted.has(pool.id) && pool.poolAddress !== null,
      );
      if (pools.length !== wanted.size) {
        throw new Error("Landing reserve pool authority is incomplete.");
      }
      return batchGetLatestPoolStatesForLanding({
        db,
        tableName,
        pools,
        signal,
      });
    },
    async readConcentratedPoolBalances({
      blockNumber,
      blockHash,
      signal,
      poolId,
      poolAddress,
      tokenAddresses,
    }) {
      const values = await rpc.multicall({
        allowFailure: false,
        blockNumber,
        blockHash,
        signal,
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
    async readRuntimePoolReserves({ blockNumber, blockHash, signal, pools }) {
      if (
        pools.length !== APPROVED_RUNTIME_AUTHORITY.pools.size ||
        new Set(pools.map(({ poolId }) => poolId)).size !== pools.length ||
        pools.some(({ poolId, poolAddress }) => {
          const approved = APPROVED_RUNTIME_AUTHORITY.pools.get(poolId);
          return !approved || !sameAddress(poolAddress, approved.poolAddress);
        })
      ) {
        throw new Error(
          "Landing runtime reserve request is outside authority.",
        );
      }
      const values = await rpc.multicall({
        allowFailure: false,
        blockNumber,
        blockHash,
        signal,
        contracts: pools.map(({ poolAddress }) => ({
          address: poolAddress,
          abi: UniswapV2PairReserveAbi,
          functionName: "getReserves",
        })),
      });
      if (values.length !== pools.length) {
        throw new Error("Landing runtime reserves are incomplete.");
      }
      return pools.map(({ poolId }, index) => {
        const [reserve0, reserve1] = requiredReserveTuple(
          values[index],
          poolId,
        );
        return { poolId, blockNumber, reserve0, reserve1 };
      });
    },
    async readRuntimePoolQuotes({ blockNumber, blockHash, signal, requests }) {
      const definitionIds = new Set(
        requests.map(({ quoteDefinitionId }) => quoteDefinitionId),
      );
      if (definitionIds.size !== requests.length) {
        throw new Error("Landing runtime quote definitions must be unique.");
      }
      for (const request of requests) {
        const approved = APPROVED_RUNTIME_AUTHORITY.quotes.get(
          request.quoteDefinitionId,
        );
        if (
          !approved?.some(
            ({ poolId, poolAddress, tokenIn }) =>
              request.poolId === poolId &&
              sameAddress(request.poolAddress, poolAddress) &&
              sameAddress(request.tokenIn, tokenIn),
          ) ||
          request.amountIn <= 0n
        ) {
          throw new Error(
            "Landing runtime quote request is outside authority.",
          );
        }
      }
      const values = await rpc.multicall({
        allowFailure: true,
        blockNumber,
        blockHash,
        signal,
        contracts: requests.map((request) => ({
          address: request.poolAddress,
          abi: getAmountOutAbi,
          functionName: "getAmountOut",
          args: [request.amountIn, request.tokenIn],
        })),
      });
      if (values.length !== requests.length) {
        throw new Error("Landing runtime quotes are incomplete.");
      }
      return requests.map((request, index) => {
        const value = values[index];
        if (
          !value ||
          typeof value !== "object" ||
          !("status" in value) ||
          value.status !== "success" ||
          !("result" in value) ||
          typeof value.result !== "bigint" ||
          value.result <= 0n
        ) {
          return {
            quoteDefinitionId: request.quoteDefinitionId,
            status: "unavailable" as const,
          };
        }
        return {
          quoteDefinitionId: request.quoteDefinitionId,
          status: "available" as const,
          blockNumber,
          amountOut: value.result,
        };
      });
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
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new FameLandingRunDeadlineError();
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  return Promise.race([operation(controller.signal), deadline]).finally(() => {
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
  readBlockIdentity = getCanonicalBlockIdentity,
}: {
  indexResult: FamePoolStateIndexerResult;
  tableName: string;
  db?: PoolStateDocumentClient;
  deps?: FameLandingSnapshotProducerDependencies;
  capturedAt?: Date;
  runTimeoutMs?: number;
  leafTimeoutMs?: number;
  ttlSeconds?: number;
  readBlockIdentity?: (options: {
    blockNumber: bigint;
    signal: AbortSignal;
  }) => Promise<CanonicalBlockIdentity>;
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
  return withRunDeadline(async (signal) => {
    let previousSnapshot: FameLandingSnapshot | null = null;
    try {
      previousSnapshot = await getCurrentFameLandingSnapshot({
        db,
        tableName,
        signal,
      });
    } catch {
      // A warm start is optional; a corrupt prior pointer must not poison a new pass.
      signal.throwIfAborted();
    }
    const snapshot = await produceFameLandingSnapshot({
      chainId: indexResult.chainId,
      safeBlockNumber: indexResult.observedThroughBlock,
      safeBlockHash: indexResult.safeBlockHash,
      capturedAt,
      deps,
      previousSnapshot,
      leafTimeoutMs,
      signal,
    });
    signal.throwIfAborted();
    const publication = await publishFameLandingSnapshot({
      db,
      tableName,
      snapshot,
      publishedAt: capturedAt,
      ttlSeconds,
      signal,
      beforePointerWrite: async () => {
        signal.throwIfAborted();
        const finalBlockIdentity = await readBlockIdentity({
          blockNumber: BigInt(indexResult.observedThroughBlock),
          signal,
        });
        if (
          finalBlockIdentity.hash.toLowerCase() !==
          indexResult.safeBlockHash.toLowerCase()
        ) {
          throw new Error(
            "FAME safe head block identity changed before publication.",
          );
        }
        signal.throwIfAborted();
      },
    });
    return { snapshot, publication };
  }, runTimeoutMs);
}
