import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  parseAbi,
  type Hex,
} from "viem";
import { valuationReader } from "./valuation-rpc.ts";
import { scope, epoch } from "./worker-fixture.ts";
import { ETH_USD_FEED, validateSnapshots, WETH } from "./valuation.ts";
const abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)",
  "function liquidity() view returns (uint128)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
const block = {
  number: 100,
  hash: `0x${"a".repeat(64)}` as Hex,
  parentHash: `0x${"b".repeat(64)}` as Hex,
  timestamp: epoch,
};
function fixture(mode = "") {
  let requests = 0,
    subcalls = 0;
  const connector = scope.registry.pools.find(
    (p) => p.id === "uniswap-v3-usdc-weth-5bps",
  )!;
  const transport = custom(
    {
      request: async ({ method, params }) => {
        requests++;
        expect(method).toBe("eth_call");
        if (mode === "transport") throw new Error("outer failure");
        const [tx, tag] = params as [{ data: Hex }, string];
        expect(tag).toBe("0x64");
        const decoded = decodeFunctionData({
          abi: multicall3Abi,
          data: tx.data,
        });
        if (decoded.functionName !== "aggregate3")
          throw new Error("Expected aggregate3");
        const calls = decoded.args[0];
        subcalls = calls.length;
        expect(
          new Set(calls.map((c) => `${c.target}:${c.callData}`)).size,
        ).toBe(calls.length);
        const results = calls.map((c) => {
          const decoded = decodeFunctionData({ abi, data: c.callData });
          const p = scope.registry.pools.find(
            (p) => p.poolAddress === c.target.toLowerCase(),
          );
          if (
            mode === "identity-revert" &&
            c.target.toLowerCase() === connector.poolAddress &&
            decoded.functionName === "token0"
          )
            return { success: false, returnData: "0x" as Hex };
          let result: unknown;
          switch (decoded.functionName) {
            case "decimals":
              result =
                c.target.toLowerCase() === ETH_USD_FEED
                  ? 8
                  : c.target.toLowerCase() ===
                      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
                    ? 6
                    : 18;
              break;
            case "token0":
              result = p!.token0;
              break;
            case "token1":
              result = p!.token1;
              break;
            case "balanceOf":
              result = 10n ** 18n;
              break;
            case "getReserves":
              result = [10n ** 18n, 10n ** 18n, 0];
              break;
            case "liquidity":
            case "getLiquidity":
              result =
                mode === "empty" &&
                c.target.toLowerCase() === connector.poolAddress
                  ? 0n
                  : 100n;
              break;
            case "latestRoundData":
              result = [
                1n,
                2000n * 10n ** 8n,
                BigInt(epoch - 10),
                BigInt(epoch - 10),
                1n,
              ];
              break;
            case "getSlot0":
              result = [2n ** 96n, 0, 0, 0];
              break;
            case "slot0":
              result =
                p?.venueFamily === "Slipstream"
                  ? [2n ** 96n, 0, 0, 0, 0, true]
                  : [2n ** 96n, 0, 0, 0, 0, 0, true];
              break;
          }
          const outputAbi =
            p?.venueFamily === "Slipstream" && decoded.functionName === "slot0"
              ? parseAbi([
                  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)",
                ])
              : abi;
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: outputAbi,
              functionName: decoded.functionName,
              result: result as never,
            }),
          };
        });
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: [results] as never,
        });
      },
    },
    { retryCount: 0 },
  );
  return {
    read: valuationReader(scope, transport),
    counts: () => ({ requests, subcalls }),
  };
}
test("all routes and custody balances use one deduplicated pinned-block batch", async () => {
  const f = fixture(),
    snapshot = await f.read(block);
  validateSnapshots([snapshot], scope);
  expect(Object.values(snapshot.quotes).every(Boolean)).toBe(true);
  expect(Object.values(snapshot.pools).every(Boolean)).toBe(true);
  expect(f.counts().requests).toBe(1);
  expect(f.counts().subcalls).toBeLessThan(60);
});
test.each(["empty", "identity-revert"])(
  "unusable connector (%s) yields explicit partial valuation",
  async (mode) => {
    const f = fixture(mode),
      snapshot = await f.read(block);
    expect(
      snapshot.quotes["0xe5020a6d073a794b6e7f05678707de47986fb0b6"],
    ).toBeNull();
    expect(snapshot.quotes[WETH]).not.toBeNull();
  },
);
test("outer transport failures propagate rather than becoming per-contract gaps", async () => {
  const f = fixture("transport");
  await expect(f.read(block)).rejects.toThrow();
  expect(f.counts().requests).toBe(1);
});
