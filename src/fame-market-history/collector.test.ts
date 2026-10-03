import { gunzipSync } from "node:zlib";
import type { Hex } from "viem";
import { collect, type ArchiveStore, type ChainReader } from "./collector.ts";
import {
  historyScope,
  type Cursor,
  type Header,
  type RawLog,
} from "./model.ts";
import { famePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";

const scope = historyScope(famePoolStateRegistry);
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const header = (number: number): Header => ({
  number,
  hash: h(number),
  parentHash: h(number - 1),
  timestamp: 1700000000 + number,
});
const event = (overrides: Partial<RawLog> = {}): RawLog => ({
  address: scope.pools[0].address,
  blockNumber: 101,
  blockHash: h(101),
  transactionHash: h(500),
  transactionIndex: 0,
  logIndex: 0,
  topics: [h(600)],
  data: `0x${"ff".repeat(32)}`,
  removed: false,
  ...overrides,
});

function fixture(logs: RawLog[] = [event()]) {
  let cursor: Cursor = { startBlock: 100, nextBlock: 100, previousHash: null };
  const uploaded: Uint8Array[] = [];
  const headers: number[] = [];
  const operations: string[] = [];
  const chain: ChainReader = {
    finalized: async () => header(110),
    header: async (n) => {
      headers.push(n);
      return header(n);
    },
    logs: async () => logs,
  };
  const store: ArchiveStore = {
    cursor: async () => ({ ...cursor }),
    upload: async (_, bytes) => {
      operations.push("upload");
      uploaded.push(bytes);
    },
    commit: async (manifest, expected) => {
      operations.push("commit");
      if (cursor.nextBlock !== expected.nextBlock) throw new Error("conflict");
      cursor = {
        ...cursor,
        nextBlock: manifest.toBlock + 1,
        previousHash: manifest.lastHash,
      };
    },
  };
  return {
    chain,
    store,
    uploaded,
    headers,
    operations,
    cursor: () => cursor,
    run: (dryRun = false) =>
      collect({
        chain,
        store,
        scope,
        startBlock: 100,
        maxBlocks: 5,
        maxEvents: 100,
        dryRun,
      }),
  };
}

test("archives ordered lossless logs and coverage before advancing", async () => {
  const f = fixture([event({ logIndex: 2 }), event(), event()]);
  expect(await f.run()).toMatchObject({
    status: "archived",
    fromBlock: 100,
    toBlock: 104,
    eventCount: 2,
  });
  expect(f.operations).toEqual(["upload", "commit"]);
  expect(f.cursor().nextBlock).toBe(105);
  const lines = gunzipSync(f.uploaded[0])
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(lines[0]).toMatchObject({
    kind: "range",
    fromBlock: 100,
    toBlock: 104,
  });
  expect(lines[1]).toMatchObject({
    data: `0x${"ff".repeat(32)}`,
    blockTimestamp: 1700000101,
    logIndex: 0,
  });
  expect(lines[2].logIndex).toBe(2);
  expect(f.headers.filter((n) => n === 101)).toHaveLength(1);
});

test("successful empty ranges have durable coverage", async () => {
  const f = fixture([]);
  expect(await f.run()).toMatchObject({ eventCount: 0, status: "archived" });
  expect(f.cursor().nextBlock).toBe(105);
  expect(f.uploaded).toHaveLength(1);
});

test("caught-up runs still validate the committed finalized boundary", async () => {
  const f = fixture([]);
  await f.run();
  f.chain.finalized = async () => header(104);
  expect(await f.run()).toMatchObject({ status: "caught-up" });
  f.chain.finalized = async () => ({ ...header(104), hash: h(999) });
  await expect(f.run()).rejects.toThrow("boundary hash changed");
  f.chain.finalized = async () => header(103);
  await expect(f.run()).rejects.toThrow("regressed");
  expect(f.uploaded).toHaveLength(1);
});

test("provider failure is not empty success", async () => {
  const f = fixture();
  f.chain.logs = async () => {
    throw new Error("provider down");
  };
  await expect(f.run()).rejects.toThrow("provider down");
  expect(f.operations).toEqual([]);
});

test("upload failure cannot advance the cursor", async () => {
  const f = fixture();
  f.store.upload = async () => {
    throw new Error("S3 failed");
  };
  await expect(f.run()).rejects.toThrow("S3 failed");
  expect(f.cursor().nextBlock).toBe(100);
});

test("retry after commit failure uploads identical content and commits once", async () => {
  const f = fixture();
  const commit = f.store.commit;
  f.store.commit = async () => {
    throw new Error("DynamoDB failed");
  };
  await expect(f.run()).rejects.toThrow("DynamoDB failed");
  f.store.commit = commit;
  await f.run();
  expect(
    Buffer.compare(Buffer.from(f.uploaded[0]), Buffer.from(f.uploaded[1])),
  ).toBe(0);
  expect(f.cursor().nextBlock).toBe(105);
});

test("dry-run reads and validates but never uploads or commits", async () => {
  const f = fixture();
  expect(await f.run(true)).toMatchObject({ status: "dry-run" });
  expect(f.operations).toEqual([]);
});

test.each([
  ["removed", { removed: true }],
  ["foreign pool", { address: "0x0000000000000000000000000000000000000001" }],
  ["wrong hash", { blockHash: h(999) }],
  ["outside range", { blockNumber: 99 }],
  ["invalid data", { data: "0x1" }],
  ["invalid topic", { topics: ["0x12"] }],
] as const)("rejects %s without publishing", async (_, change) => {
  const f = fixture([
    event({
      ...change,
      topics: "topics" in change ? [...change.topics] : [h(600)],
    }),
  ]);
  await expect(f.run()).rejects.toThrow();
  expect(f.operations).toEqual([]);
});

test("conflicting duplicates fail instead of choosing one", async () => {
  const f = fixture([event(), event({ data: "0x00" })]);
  await expect(f.run()).rejects.toThrow("Conflicting duplicate");
});

test("boundary change stops publication", async () => {
  const f = fixture();
  // Deliberately explicit second observation of the end block.
  let endReads = 0;
  f.chain.header = async (n) =>
    n === 104 && ++endReads === 2 ? { ...header(n), hash: h(999) } : header(n);
  await expect(f.run()).rejects.toThrow("Range changed");
  expect(f.operations).toEqual([]);
});

test("busy ranges commit a verified prefix within the header allowance", async () => {
  const f = fixture([
    event({ blockNumber: 100, blockHash: h(100) }),
    event(),
    event({ blockNumber: 102, blockHash: h(102) }),
  ]);
  f.chain.headerAllowance = () => 2;
  expect(await f.run()).toMatchObject({
    fromBlock: 100,
    toBlock: 101,
    eventCount: 2,
  });
  expect(f.cursor().nextBlock).toBe(102);
});

test("no new finalized blocks means no writes", async () => {
  const f = fixture();
  f.chain.finalized = async () => header(99);
  expect(await f.run()).toMatchObject({ status: "caught-up" });
  expect(f.operations).toEqual([]);
});

test("scope contains five direct pools and excludes connector/V4 manager", () => {
  expect(scope.pools).toHaveLength(5);
  expect(
    scope.pools.every(
      (p) =>
        p.token0.toLowerCase() ===
          "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418" ||
        p.token1.toLowerCase() === "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
    ),
  ).toBe(true);
  expect(
    historyScope({
      ...famePoolStateRegistry,
      source: { ...famePoolStateRegistry.source, pinnedBaseBlock: 1 },
    }).id,
  ).toBe(scope.id);
});

test("concurrent runs cannot both publish the same range", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.run(), f.run()]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(f.cursor().nextBlock).toBe(105);
});

test("a changed committed boundary cannot be skipped", async () => {
  const f = fixture([]);
  await f.run();
  f.operations.length = 0;
  f.chain.header = async (number) =>
    number === 104 ? { ...header(number), hash: h(999) } : header(number);
  await expect(f.run()).rejects.toThrow("Committed boundary hash changed");
  expect(f.operations).toEqual([]);
  expect(f.cursor().nextBlock).toBe(105);
});

test("captures liquidity observations without upgrading source finality", async () => {
  const f = fixture();
  f.store.observations = async () => [
    {
      poolId: scope.pools[0].id,
      status: "available",
      finality: "source-observation-unverified",
      state: {
        observedThroughBlock: 200,
        reserve0: "10000000000000000000000001",
      },
    },
  ];
  await f.run();
  const metadata = JSON.parse(
    gunzipSync(f.uploaded[0]).toString().split("\n")[0],
  );
  expect(metadata.toBlock).toBe(104);
  expect(metadata.observations[0]).toMatchObject({
    finality: "source-observation-unverified",
    state: {
      observedThroughBlock: 200,
      reserve0: "10000000000000000000000001",
    },
  });
});
