import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  type Hex,
} from "viem";
import { scope, epoch } from "./worker-fixture.ts";
import {
  sampledCalls,
  sampledReader,
  deriveSampledObservation,
} from "./sampled-rpc.ts";
import { sampledMarketBucket } from "./sampled-market.ts";
const calls = sampledCalls(scope);
const block = {
  number: 100,
  timestamp: epoch + 299,
  hash: `0x${"a".repeat(64)}` as Hex,
  parentHash: `0x${"b".repeat(64)}` as Hex,
};
const after = {
  number: 101,
  timestamp: epoch + 300,
  hash: `0x${"c".repeat(64)}` as Hex,
  parentHash: block.hash,
};
function mock(mode = "ok") {
  const requests: { method: string; params: unknown }[] = [];
  const transport = custom(
    {
      request: async ({ method, params }) => {
        requests.push({ method, params });
        if (method !== "eth_call") throw new Error("Unexpected RPC");
        const [request, tag] = params as [{ data: Hex }, string];
        expect(tag).toBe("0x64");
        const decoded = decodeFunctionData({
          abi: multicall3Abi,
          data: request.data,
        });
        if (decoded.functionName !== "aggregate3")
          throw new Error("Wrong multicall");
        expect(decoded.args[0]).toHaveLength(calls.length);
        const results = calls.map((c) => {
          const p = scope.registry.pools.find((p) =>
            c.key.startsWith(`${p.id}:`),
          );
          if (mode === "balance" && c.key.endsWith(":balance0"))
            return { success: false, returnData: "0x" as Hex };
          if (
            mode === "connector" &&
            c.key === "uniswap-v3-usdc-weth-5bps:state"
          )
            return { success: false, returnData: "0x" as Hex };
          let result: unknown;
          switch (c.functionName) {
            case "decimals":
              result =
                c.address === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
                  ? 6
                  : 18;
              break;
            case "token0":
              result =
                mode === "identity"
                  ? "0x0000000000000000000000000000000000000000"
                  : p!.token0;
              break;
            case "token1":
              result = p!.token1;
              break;
            case "getReserves":
              result = [10n ** 18n, 10n ** 18n, 0n];
              break;
            case "slot0":
              result =
                p!.venueFamily === "Slipstream"
                  ? [2n ** 96n, 0, 0, 0, 0, true]
                  : [2n ** 96n, 0, 0, 0, 0, 0, true];
              break;
            case "getSlot0":
              result = [2n ** 96n, 0, 0, 0];
              break;
            case "liquidity":
            case "getLiquidity":
              result = mode === "liquidity" ? 0n : 1n;
              break;
            case "balanceOf":
              result = 10n ** 18n;
              break;
            default:
              throw new Error("Unexpected call");
          }
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: c.abi,
              functionName: c.functionName,
              result,
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
  return { requests, transport };
}
test("one pinned call supplies reproducible raw evidence for both currencies", async () => {
  const m = mock(),
    e = await sampledReader(scope, m.transport)(epoch, block, after);
  expect(m.requests).toHaveLength(1);
  const s = deriveSampledObservation(scope, JSON.parse(JSON.stringify(e)));
  for (const c of ["ETH", "USDC"] as const) {
    const response = sampledMarketBucket(scope, c, epoch, s, []);
    expect(response.series.filter((r) => r.price !== null)).toHaveLength(6);
    expect(response.totals.eventCoverage).toBe("missing");
  }
});
test.each(["balance", "connector", "liquidity"])(
  "preserves independent observations after %s failure",
  async (mode) => {
    const m = mock(mode),
      e = await sampledReader(scope, m.transport)(epoch, block, after);
    const s = deriveSampledObservation(scope, e);
    if (mode === "balance") {
      expect(Object.values(s.balances).every((b) => b === null)).toBe(true);
      expect(Object.values(s.rates).every((r) => r !== null)).toBe(true);
    } else {
      expect(s.rates["uniswap-v3-usdc-weth-5bps"]).toBeNull();
      expect(s.rates["scale-equalizer-weth-fame"]).not.toBeNull();
    }
  },
);
test("identity mismatch fails qualification rather than becoming plausible prices", async () => {
  const m = mock("identity"),
    e = await sampledReader(scope, m.transport)(epoch, block, after);
  expect(() => deriveSampledObservation(scope, e)).toThrow("identity mismatch");
});
