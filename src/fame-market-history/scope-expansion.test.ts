import { VALUATION_VERSION } from "./valuation.ts";
import { jest } from "@jest/globals";
import type { Hex } from "viem";
import { collect, type ArchiveStore, type ChainReader } from "./collector.ts";
import {
  historyScope,
  type Cursor,
  type Manifest,
  type RawLog,
} from "./model.ts";
import { scope as target } from "./worker-fixture.ts";
import { expandRange, expansionPools } from "./scope-expansion.ts";
import { readArchive } from "./archive.ts";
const source = historyScope({
  ...target.registry,
  pools: target.registry.pools.filter(
    (p) => p.id !== "uniswap-v3-weth-fame-30bps",
  ),
});
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const header = (number: number) => ({
  number,
  hash: h(number),
  parentHash: h(number - 1),
  timestamp: 1700000000 + number,
});
const event = (address = source.pools[0].address, logIndex = 0): RawLog => ({
  address,
  blockNumber: 102,
  blockHash: h(102),
  transactionHash: h(900),
  transactionIndex: 0,
  logIndex,
  topics: [h(777)],
  data: "0x",
  removed: false,
});
function store() {
  let cursor: Cursor = { startBlock: 100, nextBlock: 100, previousHash: null };
  let bytes!: Uint8Array, manifest!: Manifest;
  const api: ArchiveStore = {
    cursor: async () => cursor,
    upload: async (_, value) => {
      bytes = value;
    },
    commit: async (m) => {
      manifest = m;
      cursor = {
        ...cursor,
        nextBlock: m.toBlock + 1,
        previousHash: m.lastHash,
      };
    },
    reduceRange: async (_, __, maxBlocks) => {
      cursor = { ...cursor, maxBlocks };
    },
  };
  return { api, result: () => ({ bytes, manifest, cursor }) };
}
async function setup() {
  const original = store();
  await collect({
    scope: source,
    store: original.api,
    startBlock: 100,
    maxBlocks: 10,
    maxEvents: 100,
    chain: {
      valuation: async (block) => ({
        version: VALUATION_VERSION,
        block,
        ethUsd: null,
        quotes: {},
        pools: {},
      }),
      header: async (n) => header(n),
      finalized: async () => header(105),
      logs: async (_, to) => ({ logs: [event()], throughBlock: to }),
    },
  });
  const added = expansionPools(source, target);
  const logs = jest
    .fn<ChainReader["logs"]>()
    .mockImplementation(async (_, to) => ({
      logs: [event(added.pools[0].address, 1)],
      throughBlock: to,
    }));
  const chain: ChainReader = {
    header: async (n) => header(n),
    finalized: async () => header(110),
    logs,
  };
  const staging = store();
  return {
    original,
    staging,
    chain,
    logs,
    run: () =>
      expandRange({
        source,
        target,
        ...original.result(),
        chain,
        store: staging.api,
        startBlock: 100,
        maxBlocks: 10,
        maxEvents: 100,
      }),
  };
}
test("merges native events without resampling old emitters or extending source coverage", async () => {
  const f = await setup();
  expect((await f.run()).toBlock).toBe(105);
  expect(f.logs).toHaveBeenCalledWith(100, 105);
  const staged = f.staging.result(),
    original = f.original.result();
  const rows = readArchive(staged.manifest, staged.bytes).events;
  expect(rows).toHaveLength(2);
  expect(readArchive(staged.manifest, staged.bytes).valuation).toEqual(
    readArchive(original.manifest, original.bytes).valuation,
  );
  expect(rows[0]).toEqual(
    readArchive(original.manifest, original.bytes).events[0],
  );
  expect(staged.manifest.scopeId).toBe(target.id);
  expect(staged.manifest.sourceArchive?.sha256).toBe(original.manifest.sha256);
  expect(original.manifest.scopeId).toBe(source.id);
  expect(staged.cursor.nextBlock).toBe(106);
  expect(staged.manifest.key).not.toBe(original.manifest.key);
});
test("resumes a capacity-limited prefix with the same source archive", async () => {
  const f = await setup();
  f.logs.mockResolvedValueOnce({
    logs: [],
    throughBlock: 101,
    yieldReason: "request-capacity",
  });
  expect((await f.run()).toBlock).toBe(101);
  expect((await f.run()).fromBlock).toBe(102);
  expect(f.logs).toHaveBeenLastCalledWith(102, 105);
  const staged = f.staging.result();
  expect(readArchive(staged.manifest, staged.bytes).events).toHaveLength(2);
});
test("rejects changed source headers and log emitters before committing", async () => {
  const f = await setup();
  f.logs.mockResolvedValueOnce({ logs: [event()], throughBlock: 105 });
  await expect(f.run()).rejects.toThrow("existing or unknown emitter");
  expect(f.staging.result().cursor.nextBlock).toBe(100);
  f.chain.header = async (n) => ({ ...header(n), hash: h(999) });
  await expect(f.run()).rejects.toThrow("no longer canonical");
  expect(f.staging.result().cursor.nextBlock).toBe(100);
});
test("corrupt archives and changes to existing pool definitions are rejected", async () => {
  const f = await setup();
  f.original.result().bytes[0] ^= 1;
  await expect(f.run()).rejects.toThrow();
  const changed = structuredClone(target);
  changed.registry.pools[0].token0 = target.pools[0].token1;
  expect(() => expansionPools(source, changed)).toThrow("changed existing");
  expect(() => expansionPools(source, source)).toThrow("new scope");
});
test("explicit replay end never claims blocks beyond finality and yields caught up on resume", async () => {
  const f = await setup();
  await f.run();
  const result = await collect({
    scope: target,
    chain: f.chain,
    store: f.staging.api,
    startBlock: 100,
    endBlock: 105,
    maxBlocks: 10,
    maxEvents: 100,
  });
  expect(result.status).toBe("caught-up");
  expect(f.logs).toHaveBeenCalledTimes(1);
});
