import { describe, expect, jest, test } from "@jest/globals";
import {
  encodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  type Address,
  type Hex,
} from "viem";
import { baseRpcs } from "@/viem.ts";
import {
  getCanonicalBlockIdentity,
  multicallAtBlockHash,
} from "./block-hash-multicall.ts";

const SAFE_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const CONTRACT = "0x1111111111111111111111111111111111111111" as Address;
const uintAbi = [
  {
    type: "function",
    name: "value",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

describe("block-hash multicall", () => {
  test("uses an EIP-1898 canonical block selector and decodes results", async () => {
    const resultData = encodeFunctionResult({
      abi: uintAbi,
      functionName: "value",
      result: 42n,
    });
    const aggregateData = encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [[{ success: true, returnData: resultData }]] as never,
    });
    const request = jest.fn(async () => aggregateData);

    await expect(
      multicallAtBlockHash({
        rpc: { request },
        blockHash: SAFE_HASH,
        allowFailure: false,
        contracts: [{ address: CONTRACT, abi: uintAbi, functionName: "value" }],
      }),
    ).resolves.toEqual([42n]);

    expect(request).toHaveBeenCalledWith({
      method: "eth_call",
      params: [
        {
          to: expect.any(String),
          data: encodeFunctionData({
            abi: multicall3Abi,
            functionName: "aggregate3",
            args: [
              [
                {
                  target: CONTRACT,
                  allowFailure: true,
                  callData: encodeFunctionData({
                    abi: uintAbi,
                    functionName: "value",
                  }),
                },
              ],
            ],
          }),
        },
        { blockHash: SAFE_HASH, requireCanonical: true },
      ],
    });
  });

  test("fails the whole batch when allowFailure is false", async () => {
    const aggregateData = encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [[{ success: false, returnData: "0x" }]] as never,
    });

    await expect(
      multicallAtBlockHash({
        rpc: { request: async () => aggregateData },
        blockHash: SAFE_HASH,
        allowFailure: false,
        contracts: [{ address: CONTRACT, abi: uintAbi, functionName: "value" }],
      }),
    ).rejects.toThrow(/multicall value failed/u);
  });

  test("returns success and failure results independently when allowed", async () => {
    const resultData = encodeFunctionResult({
      abi: uintAbi,
      functionName: "value",
      result: 42n,
    });
    const aggregateData = encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: [
        [
          { success: true, returnData: resultData },
          { success: false, returnData: "0x" },
        ],
      ] as never,
    });

    await expect(
      multicallAtBlockHash({
        rpc: { request: async () => aggregateData },
        blockHash: SAFE_HASH,
        allowFailure: true,
        contracts: [
          { address: CONTRACT, abi: uintAbi, functionName: "value" },
          { address: CONTRACT, abi: uintAbi, functionName: "value" },
        ],
      }),
    ).resolves.toEqual([
      { status: "success", result: 42n },
      { status: "failure", error: expect.any(Error) },
    ]);
  });

  test("does not retry an aborted RPC request", async () => {
    const originalBaseRpcs = [...baseRpcs];
    const controller = new AbortController();
    const fetchMock = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        controller.abort(new Error("RPC deadline expired."));
        throw controller.signal.reason;
      });
    baseRpcs.splice(0, baseRpcs.length, "https://rpc.example");

    try {
      await expect(
        getCanonicalBlockIdentity({
          blockNumber: 1n,
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      baseRpcs.splice(0, baseRpcs.length, ...originalBaseRpcs);
    }
  });
});
