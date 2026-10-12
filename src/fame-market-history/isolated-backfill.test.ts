import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  type AbiEvent,
} from "viem";
import {
  isolatedScope,
  isolatedPoolScope,
  isolatedMetadata,
  prepareIsolatedBackfill,
  isolatedDecimals,
} from "./isolated-backfill.ts";
import { fameHistoryRegistry } from "./registry.ts";
import { historyScope, type ArchivedLog } from "./model.ts";
import { decode, EVENT_ABIS, validateMetadata } from "./decode.ts";
import { activityEvent } from "./activity-events.ts";
import { sampledPolicy, conversionFor, decimal } from "./sampled-market.ts";
import { sampledCalls, deriveSampledObservation } from "./sampled-rpc.ts";
import { sampledHeader } from "./sampled-fixture.ts";

const scope = isolatedPoolScope("aerodrome-cbbtc-fame"),
  pool = scope.pools[0];
const metadata = isolatedMetadata(21374567, `0x${"1".repeat(64)}`);
const verified: AbiEvent[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/aerodrome-events-abi.json", import.meta.url),
    "utf8",
  ),
);
function log(name: string, values: Record<string, unknown> = {}): ArchivedLog {
  const event = verified.find((e) => e.name === name)!;
  const args = Object.fromEntries(
    event.inputs.map((i) => [
      i.name!,
      values[i.name!] ?? (i.type === "address" ? pool.address : 1n),
    ]),
  );
  return {
    address: pool.address,
    poolId: pool.id,
    blockNumber: 21374567,
    blockTimestamp: 1729538481,
    blockHash: `0x${"1".repeat(64)}`,
    transactionHash: `0x${"2".repeat(64)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: [event],
      eventName: name,
      args,
    }) as `0x${string}`[],
    data: encodeAbiParameters(
      event.inputs.filter((i) => !i.indexed),
      event.inputs.filter((i) => !i.indexed).map((i) => args[i.name!]),
    ),
  };
}
test("isolated admission leaves the production registry and policy unchanged", () => {
  expect(isolatedScope.pools).toHaveLength(8);
  expect(historyScope(fameHistoryRegistry).pools).toHaveLength(6);
  expect(fameHistoryRegistry.pools.some((p) => p.id === pool.id)).toBe(false);
  validateMetadata(isolatedScope, metadata);
  expect(sampledPolicy(scope).routes[pool.id]).toEqual({
    ETH: ["uniswap-v3-usdc-cbbtc-5bps", "uniswap-v3-usdc-weth-5bps"],
    USDC: ["uniswap-v3-usdc-cbbtc-5bps"],
  });
});
test("all deployed Aerodrome event layouts decode, including its distinct Swap/Burn selectors", () => {
  expect(EVENT_ABIS.AerodromeV2).toHaveLength(verified.length);
  for (const event of verified)
    expect(decode(log(event.name), pool, metadata).eventName).toBe(event.name);
  const e = decode(
    log("Swap", {
      amount0In: 100000000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 2n * 10n ** 18n,
    }),
    pool,
    metadata,
  );
  expect(e.priceX18).toBe("500000000000000000");
  expect(activityEvent(e, pool)).toMatchObject({
    type: "buy",
    fameAtoms: "2000000000000000000",
    quoteAtoms: "100000000",
  });
  expect(activityEvent(decode(log("Burn"), pool, metadata), pool)?.type).toBe(
    "remove",
  );
  expect(activityEvent(decode(log("Fees"), pool, metadata), pool)).toBeNull();
});
test("sampled conversion respects eight-decimal tokens and fails closed on a missing connector", () => {
  const calls = sampledCalls(scope),
    block = sampledHeader(104),
    after = sampledHeader(105);
  const results = calls.map((c) => {
    const p = scope.registry.pools.find((p) => c.key.startsWith(`${p.id}:`));
    const d = (t: string) =>
      isolatedDecimals[t] ??
      (t === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ? 6 : 18);
    const result: unknown =
      c.functionName === "decimals"
        ? d(c.address)
        : c.functionName === "token0"
          ? p!.token0
          : c.functionName === "token1"
            ? p!.token1
            : c.functionName === "getReserves"
              ? [10n ** 8n, 2n * 10n ** 18n, 0n]
              : c.functionName === "slot0"
                ? [2n ** 96n, 0, 0, 0, 0, 0, true]
                : 1n;
    return {
      success: true,
      returnData: encodeFunctionResult({ ...c, result }),
    };
  });
  const evidence = {
    version: "fame-market-sampled-evidence-v1" as const,
    policyRevision: sampledPolicy(scope).revision,
    timestamp: block.timestamp - 299,
    block,
    after,
    results,
  };
  const o = deriveSampledObservation(scope, evidence);
  expect(decimal(o.rates[pool.id]!)).toBe("2.000000000000000000");
  expect(decimal(conversionFor(sampledPolicy(scope), pool, "USDC", o)!)).toBe(
    "100.000000000000000000",
  );
  o.rates["uniswap-v3-usdc-cbbtc-5bps"] = null;
  expect(conversionFor(sampledPolicy(scope), pool, "USDC", o)).toBeNull();
  results[
    calls.findIndex((c) => c.key === `decimals:${pool.token0}`)
  ].returnData = encodeFunctionResult({
    ...calls[0],
    functionName: "decimals",
    result: 18,
  });
  expect(() => deriveSampledObservation(scope, evidence)).toThrow(
    "Unreviewed sampled token decimals",
  );
});
test("frozen windows are bounded and admit later pools only in their launch bucket", () => {
  const job = prepareIsolatedBackfill(1720828800, 1791590400);
  expect(job.id).toBe(prepareIsolatedBackfill(job.from, job.to).id);
  expect(job.windows[0].poolIds).toEqual([
    "uniswap-v2-fame-direct",
    "uniswap-v3-weth-fame-30bps",
  ]);
  expect(job.windows.at(-1)!.poolIds).toHaveLength(8);
  for (let i = 0; i < job.windows.length; i++) {
    const w = job.windows[i];
    expect(w.to - w.from).toBeLessThanOrEqual(86400);
    if (i) expect(w.from).toBe(job.windows[i - 1].to);
  }
  const birth = Math.floor(Date.parse("2024-10-21T19:21:21Z") / 300000) * 300;
  expect(job.windows.find((w) => w.to === birth)!.poolIds).not.toContain(
    pool.id,
  );
  expect(job.windows.find((w) => w.from === birth)!.poolIds).toContain(pool.id);
  expect(() => prepareIsolatedBackfill(0, 300)).toThrow("precedes");
});
