import { encodeFunctionResult } from "viem";
import { scope, epoch } from "./worker-fixture.ts";
import { sampledCalls, type SampledEvidence } from "./sampled-rpc.ts";
import { sampledPolicy } from "./sampled-market.ts";
import type { Header } from "./model.ts";
export const sampledHeader = (n: number): Header => ({
  number: n,
  timestamp: epoch + (n - 100) * 60,
  hash: `0x${n.toString(16).padStart(64, "0")}`,
  parentHash: `0x${(n - 1).toString(16).padStart(64, "0")}`,
});
export function sampledFixture(timestamp = epoch): SampledEvidence {
  const block = sampledHeader(104 + (timestamp - epoch) / 60),
    after = sampledHeader(block.number + 1);
  const results = sampledCalls(scope).map((c) => {
    const p = scope.registry.pools.find((p) => c.key.startsWith(`${p.id}:`));
    let result: unknown;
    switch (c.functionName) {
      case "decimals":
        result =
          c.address === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ? 6 : 18;
        break;
      case "token0":
        result = p!.token0;
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
        result = 1n;
        break;
      case "balanceOf":
        result = 10n ** 18n;
        break;
      default:
        throw new Error("Unexpected fixture call");
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
  return {
    version: "fame-market-sampled-evidence-v1",
    policyRevision: sampledPolicy(scope).revision,
    timestamp,
    block,
    after,
    results,
  };
}
