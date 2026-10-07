import { encodeFunctionResult } from "viem";
import { referenceAbi, referenceCalls } from "./reference-rpc.ts";
import {
  referencePolicy,
  REFERENCE_VERSION,
  USDC,
  FAME_REFERENCE_POOL,
  ETH_REFERENCE_POOL,
  type ReferenceEvidence,
} from "./reference.ts";
import { scope, epoch } from "./worker-fixture.ts";
import { FAME_ADDRESS } from "./model.ts";
import type { Header } from "./model.ts";
export const referenceHeader = (n: number): Header => ({
  number: n,
  timestamp: epoch + n * 2,
  hash: `0x${n.toString(16).padStart(64, "0")}`,
  parentHash: `0x${(n - 1).toString(16).padStart(64, "0")}`,
});
export function referenceFixture(
  timestamp = epoch + 300,
  options: {
    oraclePrice?: bigint;
    oracleAge?: number;
    fameReserve?: bigint;
    sqrtPrice?: bigint;
    activeLiquidity?: bigint;
    reverts?: number[];
    reverse?: boolean;
  } = {},
) {
  const localScope = structuredClone(scope);
  if (options.reverse)
    for (const id of [FAME_REFERENCE_POOL, ETH_REFERENCE_POOL]) {
      const p = localScope.registry.pools.find((p) => p.id === id)!;
      [p.token0, p.token1] = [p.token1, p.token0];
    }
  const block = referenceHeader((timestamp + 298 - epoch) / 2),
    after = referenceHeader(block.number + 1);
  const calls = referenceCalls(localScope);
  const results = calls.map((c, i) => {
    const p = localScope.registry.pools.find(
      (p) => p.poolAddress === c.address,
    );
    let result: unknown;
    switch (c.functionName) {
      case "decimals":
        result = i === 10 ? 8 : c.address === USDC ? 6 : 18;
        break;
      case "token0":
        result = p!.token0;
        break;
      case "token1":
        result = p!.token1;
        break;
      case "getReserves":
        result =
          p!.token0 === FAME_ADDRESS
            ? [
                options.fameReserve ?? 1000000n * 10n ** 18n,
                2n * 10n ** 18n,
                0n,
              ]
            : [
                2n * 10n ** 18n,
                options.fameReserve ?? 1000000n * 10n ** 18n,
                0n,
              ];
        break;
      // Use exact 1:1 raw ratio, yielding 1e12 USDC/ETH. Useful for orientation/decimal tests.
      case "slot0":
        result = [options.sqrtPrice ?? 2n ** 96n, 0, 0, 0, 0, 0, true];
        break;
      case "liquidity":
        result = options.activeLiquidity ?? 1000n;
        break;
      case "latestRoundData":
        result = [
          1n,
          options.oraclePrice ?? 2000n * 10n ** 8n,
          BigInt(block.timestamp - 10),
          BigInt(block.timestamp - (options.oracleAge ?? 10)),
          1n,
        ];
        break;
    }
    return options.reverts?.includes(i)
      ? { success: false, returnData: "0x" as const }
      : {
          success: true,
          returnData: encodeFunctionResult({
            abi: referenceAbi,
            functionName: c.functionName,
            result: result as never,
          }),
        };
  });
  const evidence: ReferenceEvidence = {
    version: REFERENCE_VERSION,
    scopeId: localScope.id,
    policy: referencePolicy(localScope),
    policyRevision: referencePolicy(localScope).revision,
    timestamp,
    block,
    after,
    results,
  };
  return { scope: localScope, evidence };
}
