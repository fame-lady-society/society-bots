import { readFileSync } from "node:fs";
import { historyScope, type ArchivedLog } from "./model.ts";
import { fameHistoryRegistry } from "./registry.ts";
import { famePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import {
  decode,
  EVENT_ABIS,
  validateMetadata,
  type TokenMetadata,
} from "./decode.ts";
import { encodeAbiParameters, encodeEventTopics, type AbiEvent } from "viem";
import { activityEvent } from "./activity-events.ts";
import { eventSpot } from "./spot-candles.ts";
import { sampledCalls, deriveSampledObservation } from "./sampled-rpc.ts";
import { sampledPolicy } from "./sampled-market.ts";
import { sampledFixture } from "./sampled-fixture.ts";

const scope = historyScope(fameHistoryRegistry);
const pool = scope.pools.find((p) => p.id === "uniswap-v3-weth-fame-30bps")!;
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/uniswap-v3-launch.json", import.meta.url),
    "utf8",
  ),
);
const metadata: TokenMetadata = JSON.parse(
  readFileSync(new URL("./token-metadata.json", import.meta.url), "utf8"),
);

test("decoder covers every verified deployed V3 event layout and excludes fee/admin actions", () => {
  const abi: AbiEvent[] = JSON.parse(
    readFileSync(
      new URL("./fixtures/uniswap-v3-events.json", import.meta.url),
      "utf8",
    ),
  );
  expect(EVENT_ABIS.UniswapV3).toHaveLength(abi.length);
  for (const event of abi) {
    const args = Object.fromEntries(
      event.inputs.map((i) => [
        i.name!,
        i.type === "address" ? pool.address : 1n,
      ]),
    );
    const raw: ArchivedLog = {
      address: pool.address,
      poolId: pool.id,
      blockNumber: fixture.blockNumber,
      blockTimestamp: fixture.timestamp,
      transactionHash: fixture.transactionHash,
      blockHash: `0x${"1".repeat(64)}`,
      transactionIndex: 0,
      logIndex: 0,
      topics: encodeEventTopics({
        abi: [event],
        eventName: event.name,
        args,
      }) as `0x${string}`[],
      data: encodeAbiParameters(
        event.inputs.filter((i) => !i.indexed),
        event.inputs.filter((i) => !i.indexed).map((i) => args[i.name!]),
      ),
      removed: false,
    };
    const decoded = decode(raw, pool, metadata);
    expect(decoded.eventName).toBe(event.name);
    if (
      [
        "Collect",
        "CollectProtocol",
        "Flash",
        "IncreaseObservationCardinalityNext",
        "SetFeeProtocol",
      ].includes(event.name)
    )
      expect(activityEvent(decoded, pool)).toBeNull();
  }
});

test("launch factory evidence matches admitted V3 identity and fee", () => {
  expect(famePoolStateRegistry.pools.some((p) => p.id === pool.id)).toBe(false);
  validateMetadata(scope, metadata);
  const creation = fixture.logs.find((l: { index: number }) => l.index === 194);
  const parameters = Object.fromEntries(
    creation.decoded.parameters.map((p: { name: string; value: string }) => [
      p.name,
      p.value,
    ]),
  );
  const registry = scope.registry.pools.find((p) => p.id === pool.id)!;
  expect(creation.address.toLowerCase()).toBe(registry.factoryAddress);
  expect(parameters.pool.toLowerCase()).toBe(pool.address);
  expect(parameters.token0.toLowerCase()).toBe(pool.token0);
  expect(parameters.token1.toLowerCase()).toBe(pool.token1);
  if (registry.fee.status !== "available") throw new Error("Missing fee");
  expect(Number(parameters.fee) / 100).toBe(registry.fee.feeBps);
  expect(Number(parameters.tickSpacing)).toBe(registry.tickSpacing);
  expect(sampledPolicy(scope).routes[pool.id]).toEqual({
    ETH: [],
    USDC: ["uniswap-v3-usdc-weth-5bps"],
  });
});

test("real launch bytes retain two one-sided adds in the same transaction and initialized spot", () => {
  const events = fixture.logs
    .filter(
      (l: { address: string }) => l.address.toLowerCase() === pool.address,
    )
    .map((l: { index: number; topics: (string | null)[]; data: string }) => {
      // Explorer fixture has real event bytes. This test-only block hash is not canonical evidence.
      const raw: ArchivedLog = {
        address: pool.address,
        poolId: pool.id,
        blockNumber: fixture.blockNumber,
        blockTimestamp: fixture.timestamp,
        transactionHash: fixture.transactionHash,
        blockHash: `0x${"1".repeat(64)}`,
        transactionIndex: 0,
        logIndex: l.index,
        topics: l.topics.filter((t): t is `0x${string}` => t !== null),
        data: l.data as `0x${string}`,
        removed: false,
      };
      return decode(raw, pool, metadata);
    });
  expect(events.map((e: ReturnType<typeof decode>) => e.eventName)).toEqual([
    "Initialize",
    "Mint",
    "Mint",
  ]);
  expect(eventSpot(scope, pool, events[0], metadata)).not.toBeNull();
  const actions = events
    .map((e: ReturnType<typeof decode>) => activityEvent(e, pool))
    .filter(Boolean);
  expect(actions).toHaveLength(2);
  expect(
    actions.map((a: NonNullable<ReturnType<typeof activityEvent>>) => [
      a.type,
      a.fameAtoms,
      a.quoteAtoms,
    ]),
  ).toEqual([
    ["add", "99999999999999999999999991", "0"],
    ["add", "166399999999999999999994558", "0"],
  ]);
  expect(actions[0].transactionHash).toBe(actions[1].transactionHash);
  expect(actions[0].id).not.toBe(actions[1].id);
});

test("new pool adds six shared-multicall subcalls, no connector and no tick reads", () => {
  const oldRegistry = {
    ...fameHistoryRegistry,
    pools: fameHistoryRegistry.pools.filter((p) => p.id !== pool.id),
  };
  const old = historyScope(oldRegistry);
  expect(sampledCalls(scope).length - sampledCalls(old).length).toBe(6);
  expect(
    sampledPolicy(scope).sources.length - sampledPolicy(old).sources.length,
  ).toBe(1);
  expect(scope.id).not.toBe(old.id);
  expect(sampledPolicy(scope).revision).not.toBe(sampledPolicy(old).revision);
  const calls = sampledCalls(scope).filter((c) =>
    c.key.startsWith(`${pool.id}:`),
  );
  expect(calls.map((c) => c.functionName)).toEqual([
    "token0",
    "token1",
    "slot0",
    "liquidity",
    "balanceOf",
    "balanceOf",
  ]);
  expect(
    deriveSampledObservation(scope, sampledFixture()).rates[pool.id],
  ).not.toBeNull();
});
