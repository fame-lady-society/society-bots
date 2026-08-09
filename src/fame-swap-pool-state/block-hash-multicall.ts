import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  http,
  isHex,
  multicall3Abi,
  numberToHex,
  type ContractFunctionParameters,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { baseRpcs } from "@/viem.ts";

type BlockHashRpcRequest =
  | {
      method: "eth_call";
      params: readonly [
        { to: string; data: Hex },
        { blockHash: Hex; requireCanonical: true },
      ];
    }
  | {
      method: "eth_getBlockByNumber";
      params: readonly [Hex, false];
    };

export interface BlockHashRpcClient {
  request(request: BlockHashRpcRequest): Promise<unknown>;
}

export type BlockHashMulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; error: Error };

export interface CanonicalBlockIdentity {
  hash: Hex;
  parentHash: Hex;
}

function abortableBaseRpc(signal: AbortSignal): BlockHashRpcClient {
  if (baseRpcs.length === 0) {
    throw new Error("BASE_RPCS_JSON must contain at least one RPC endpoint.");
  }
  const client = createPublicClient({
    chain: base,
    transport: fallback(
      baseRpcs.map((url) =>
        http(url, {
          batch: true,
          fetchOptions: { signal },
        }),
      ),
      { retryCount: 0 },
    ),
  });
  return {
    request(request) {
      return client.request(request as never);
    },
  };
}

function callFailure(functionName: string, cause?: unknown): Error {
  return new Error(`Block-hash multicall ${functionName} failed.`, {
    cause,
  });
}

export async function multicallAtBlockHash({
  rpc,
  blockHash,
  contracts,
  allowFailure,
  signal,
}: {
  rpc?: BlockHashRpcClient;
  blockHash: Hex;
  contracts: readonly ContractFunctionParameters[];
  allowFailure: boolean;
  signal?: AbortSignal;
}): Promise<readonly unknown[]> {
  signal?.throwIfAborted();
  const calls = contracts.map((contract) => ({
    target: contract.address,
    allowFailure: true,
    callData: encodeFunctionData(contract),
  }));
  const data = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [calls],
  });
  const response = await (
    rpc ?? abortableBaseRpc(signal ?? new AbortController().signal)
  ).request({
    method: "eth_call",
    params: [
      { to: base.contracts.multicall3.address, data },
      { blockHash, requireCanonical: true },
    ],
  });
  signal?.throwIfAborted();
  if (typeof response !== "string" || !isHex(response)) {
    throw new Error("Block-hash multicall returned invalid RPC data.");
  }
  const aggregateResults = decodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    data: response,
  });
  return aggregateResults.map(({ success, returnData }, index) => {
    const contract = contracts[index];
    if (!contract) {
      throw new Error("Block-hash multicall result count is invalid.");
    }
    const functionName = String(contract.functionName);
    if (!success) {
      const error = callFailure(functionName);
      if (!allowFailure) throw error;
      return { status: "failure", error } satisfies BlockHashMulticallResult;
    }
    try {
      const result = decodeFunctionResult({
        ...contract,
        data: returnData,
      });
      return allowFailure
        ? ({ status: "success", result } satisfies BlockHashMulticallResult)
        : result;
    } catch (error) {
      const failure = callFailure(functionName, error);
      if (!allowFailure) throw failure;
      return {
        status: "failure",
        error: failure,
      } satisfies BlockHashMulticallResult;
    }
  });
}

export async function getCanonicalBlockIdentity({
  rpc,
  blockNumber,
  signal,
}: {
  rpc?: BlockHashRpcClient;
  blockNumber: bigint;
  signal: AbortSignal;
}): Promise<CanonicalBlockIdentity> {
  signal.throwIfAborted();
  const response = await (rpc ?? abortableBaseRpc(signal)).request({
    method: "eth_getBlockByNumber",
    params: [numberToHex(blockNumber), false],
  });
  signal.throwIfAborted();
  if (typeof response !== "object" || response === null) {
    throw new Error("Canonical block identity is unavailable.");
  }
  const { hash, parentHash } = response as {
    hash?: unknown;
    parentHash?: unknown;
  };
  if (!isHex(hash) || !isHex(parentHash)) {
    throw new Error("Canonical block identity is malformed.");
  }
  return { hash, parentHash };
}
