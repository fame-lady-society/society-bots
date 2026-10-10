import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import {
  encodeAbiParameters,
  parseAbiParameters,
  padHex,
  toEventSelector,
  type Hex,
} from "viem";
import { collect } from "./collector.ts";
import { readArchive } from "./archive.ts";
import { buildHistory, rebuildParquet } from "./analytics.ts";
import { decode, EVENT_ABIS, type TokenMetadata } from "./decode.ts";
import {
  historyScope,
  digest,
  FAME_ADDRESS,
  type RawLog,
  type Manifest,
  type ArchivedLog,
  type Pool,
} from "./model.ts";
import { fameHistoryRegistry } from "./registry.ts";

const scope = historyScope(fameHistoryRegistry);
const pool = scope.pools.find((p) => p.venueFamily === "Solidly")!;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const epoch = 1800000000;
const header = (number: number) => ({
  number,
  hash: h(number),
  parentHash: h(number - 1),
  timestamp: epoch + (number - 100) * 60,
});
const metadata: TokenMetadata = {
  chainId: 8453,
  blockNumber: 100,
  blockHash: h(100),
  decoderReview: "provisional",
  decimals: Object.fromEntries(
    scope.pools.flatMap((p) => [p.token0, p.token1]).map((t) => [t, 18]),
  ),
  poolTokens: Object.fromEntries(
    scope.pools.map((p) => [p.id, { token0: p.token0, token1: p.token1 }]),
  ),
};
function swap({
  block = 106,
  index = 0,
  base = 10n ** 18n,
  quote = 2n * 10n ** 18n,
} = {}): RawLog {
  const base0 = pool.token0 === FAME_ADDRESS;
  const event = EVENT_ABIS.Solidly.find((e) => e.name === "Swap")!;
  return {
    address: pool.address,
    blockNumber: block,
    blockHash: h(block),
    transactionHash: h(1000 + index),
    transactionIndex: index,
    logIndex: index,
    removed: false,
    topics: [
      toEventSelector(event),
      padHex(pool.address, { size: 32 }),
      padHex(pool.address, { size: 32 }),
    ],
    data: encodeAbiParameters(
      parseAbiParameters("uint256,uint256,uint256,uint256"),
      base0 ? [base, 0n, 0n, quote] : [quote, 0n, 0n, base],
    ),
  };
}
async function archive(logs: RawLog[], from = 100, to = 120) {
  let bytes!: Uint8Array, manifest!: Manifest;
  await collect({
    scope,
    startBlock: from,
    maxBlocks: to - from + 1,
    maxEvents: 100,
    chain: {
      finalized: async () => header(to),
      header: async (n) => header(n),
      logs: async () => ({ logs, throughBlock: to }),
    },
    store: {
      reduceRange: async () => {
        throw new Error("Unexpected capacity yield in fixture");
      },
      cursor: async () => ({
        startBlock: from,
        nextBlock: from,
        previousHash: null,
      }),
      upload: async (_, b) => {
        bytes = b;
      },
      commit: async (m) => {
        manifest = m;
      },
      observations: async () => [
        {
          poolId: pool.id,
          status: "available",
          finality: "source-observation-unverified",
          state: {
            observedThroughBlock: 150,
            reserve0: "123",
            reserve1: "456",
          },
        },
      ],
    },
  });
  return { bytes, manifest };
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "history-analytics-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("collector → verified archive → native Parquet → same-SQL candles → bounded response", async () => {
  const source = await archive([
    swap({ index: 1, quote: 3n * 10n ** 18n }),
    swap(),
  ]);
  const result = await buildHistory(
    [source, source],
    metadata,
    path.join(directory, "built"),
  );
  expect(result).toMatchObject({
    eventCount: 2,
    tradeCount: 2,
    rebuildMatches: true,
    unknownEvents: 0,
  });
  expect(
    (await readFile(path.join(directory, "built/events.parquet")))
      .subarray(0, 4)
      .toString(),
  ).toBe("PAR1");
  const api = {
    points: result.dataset.candles[300].filter(
      (c) =>
        c.poolId === pool.id &&
        c.timestamp >= epoch + 300 &&
        c.timestamp < epoch + 900,
    ),
  };
  expect(api.points[0]).toMatchObject({
    open: "2.000000000000000000",
    close: "3.000000000000000000",
    high: "3.000000000000000000",
    low: "2.000000000000000000",
    tradeCount: 2,
    baseVolumeAtoms: "2000000000000000000",
    quoteVolumeAtoms: "5000000000000000000",
    coverage: "complete",
  });
  expect(api.points[1]).toMatchObject({
    open: null,
    tradeCount: 0,
    baseVolumeAtoms: "0",
    coverage: "complete",
  });
  expect(
    result.dataset.candles[3600].find((c) => c.poolId === pool.id),
  ).toMatchObject({ tradeCount: 2, coverage: "partial" });
  expect(result.dataset.liquidity[0].state?.observedThroughBlock).toBe(150);
  expect(result.dataset.liquidity[0].finality).toBe(
    "source-observation-unverified",
  );
});

test("uint256 maximum amounts and their sum survive Parquet exactly", async () => {
  const max = 2n ** 256n - 1n;
  const source = await archive([
    swap({ base: max, quote: max }),
    swap({ index: 1, base: max, quote: max }),
  ]);
  const { dataset } = await buildHistory(
    [source],
    metadata,
    path.join(directory, "built"),
  );
  const point = dataset.candles[300].find(
    (c) => c.poolId === pool.id && c.tradeCount,
  )!;
  expect(point.baseVolumeAtoms).toBe(String(max * 2n));
  expect(point.quoteVolumeAtoms).toBe(String(max * 2n));
  expect(point.open).toBe("1.000000000000000000");
});

test("Parquet rebuild verifies content independently of the original gzip encoding", async () => {
  const source = await archive([swap()]);
  const bytes = gzipSync(gunzipSync(source.bytes), { level: 0 });
  expect(digest(bytes)).not.toBe(source.manifest.sha256);
  const differentlyCompressed = {
    bytes,
    manifest: {
      ...source.manifest,
      sha256: digest(bytes),
      bytes: bytes.length,
    },
  };
  const built = await buildHistory(
    [differentlyCompressed],
    metadata,
    path.join(directory, "built"),
  );
  const rebuilt = await rebuildParquet(
    path.join(directory, "built"),
    path.join(directory, "rebuilt"),
  );
  expect(rebuilt.dataset).toEqual(built.dataset);
});

test("missing ranges and unknown/ambiguous events never become complete empty candles", async () => {
  const unknown = { ...swap(), topics: [h(888)], data: "0x" as Hex };
  const ambiguous = swap({ index: 1, base: 0n });
  const source = await archive([unknown, ambiguous]);
  const { dataset, unknownEvents, invalidTrades } = await buildHistory(
    [source],
    metadata,
    path.join(directory, "built"),
  );
  expect([unknownEvents, invalidTrades]).toEqual([1, 1]);
  const response = {
    points: dataset.candles[300].filter(
      (c) =>
        c.poolId === pool.id &&
        c.timestamp >= epoch + 300 &&
        c.timestamp < epoch + 1800,
    ),
  };
  expect(response.points[0]).toMatchObject({
    rejectedEvents: 2,
    coverage: "partial",
    open: null,
  });
  expect(
    dataset.market
      .find((c) => c.timestamp === epoch + 300)
      ?.prices.every((c) => c.status !== "complete"),
  ).toBe(true);
});

test("gaps between source ranges stay missing and overlaps fail before publication", async () => {
  const a = await archive([], 100, 105),
    b = await archive([], 115, 120);
  const { dataset } = await buildHistory(
    [a, b],
    metadata,
    path.join(directory, "built"),
  );
  expect(
    dataset.candles[300].find(
      (c) => c.poolId === pool.id && c.timestamp === epoch + 300,
    )?.coverage,
  ).toBe("missing");
  await expect(
    buildHistory(
      [a, await archive([], 104, 110)],
      metadata,
      path.join(directory, "overlap"),
    ),
  ).rejects.toThrow("Overlapping");
  await expect(
    access(path.join(directory, "overlap/history.json")),
  ).rejects.toThrow();
});

test("checksum corruption fails", async () => {
  const source = await archive([]);
  expect(() =>
    readArchive({ ...source.manifest, sha256: "bad" }, source.bytes),
  ).toThrow("checksum");
});

test("signed CL trades use execution amounts, token decimals, and FAME orientation", () => {
  const cl = scope.pools.find((p) => p.venueFamily === "Slipstream")!;
  const base0 = cl.token0 === FAME_ADDRESS;
  const quoteToken = base0 ? cl.token1 : cl.token0;
  const event = EVENT_ABIS.Slipstream.find((e) => e.name === "Swap")!;
  const raw: ArchivedLog = {
    ...swap(),
    address: cl.address,
    poolId: cl.id,
    blockTimestamp: epoch + 360,
    topics: [
      toEventSelector(event),
      padHex(cl.address, { size: 32 }),
      padHex(cl.address, { size: 32 }),
    ],
    data: encodeAbiParameters(
      parseAbiParameters("int256,int256,uint160,uint128,int24"),
      [
        base0 ? 10n ** 18n : -2_000_000n,
        base0 ? -2_000_000n : 10n ** 18n,
        123n,
        456n,
        -10,
      ],
    ),
  };
  const result = decode(raw, cl, {
    ...metadata,
    decimals: { ...metadata.decimals, [quoteToken]: 6 },
  });
  expect(result).toMatchObject({
    classification: "trade",
    baseAtoms: "1000000000000000000",
    quoteAtoms: "2000000",
    priceX18: "2000000000000000000",
  });
  expect(result.args.sqrtPriceX96).toBe("123");
  expect(result.args.tick).toBe("-10");
});

test("FAME token0 orientation and price precision bounds are explicit", () => {
  const quoteToken = pool.token0 === FAME_ADDRESS ? pool.token1 : pool.token0;
  const base0Pool: Pool = { ...pool, token0: FAME_ADDRESS, token1: quoteToken };
  const raw: ArchivedLog = {
    ...swap(),
    poolId: pool.id,
    blockTimestamp: epoch + 360,
    data: encodeAbiParameters(
      parseAbiParameters("uint256,uint256,uint256,uint256"),
      [10n ** 18n, 0n, 0n, 2n * 10n ** 18n],
    ),
  };
  expect(decode(raw, base0Pool, metadata)).toMatchObject({
    classification: "trade",
    baseAtoms: "1000000000000000000",
    quoteAtoms: "2000000000000000000",
    priceX18: "2000000000000000000",
  });
  for (const [base, quote] of [
    [10n ** 36n, 1n],
    [1n, 10n ** 36n],
  ]) {
    const bounded = {
      ...raw,
      data: encodeAbiParameters(
        parseAbiParameters("uint256,uint256,uint256,uint256"),
        [base, 0n, 0n, quote],
      ),
    };
    expect(decode(bounded, base0Pool, metadata).classification).toBe(
      "invalid-trade",
    );
  }
});

test("a known event with trailing data or metadata from a conflicting block cannot publish", async () => {
  const malformed = swap();
  malformed.data = `${malformed.data}${"0".repeat(64)}`;
  await expect(
    buildHistory(
      [await archive([malformed])],
      metadata,
      path.join(directory, "malformed"),
    ),
  ).rejects.toThrow("ABI layout");
  await expect(
    access(path.join(directory, "malformed/history.json")),
  ).rejects.toThrow();
  await expect(
    buildHistory(
      [await archive([swap()])],
      { ...metadata, blockHash: h(999) },
      path.join(directory, "conflict"),
    ),
  ).rejects.toThrow("anchor conflicts");
});

test("tampered Parquet fails before rebuilding or publishing", async () => {
  await buildHistory(
    [await archive([swap()])],
    metadata,
    path.join(directory, "built"),
  );
  const parquet = path.join(directory, "built/events.parquet");
  const bytes = await readFile(parquet);
  bytes[8] ^= 1;
  await writeFile(parquet, bytes);
  await expect(
    rebuildParquet(
      path.join(directory, "built"),
      path.join(directory, "rebuilt"),
    ),
  ).rejects.toThrow("Parquet checksum");
  await expect(
    access(path.join(directory, "rebuilt/history.json")),
  ).rejects.toThrow();
});

test("captured live evidence rebuilds from Parquet alone with known execution prices", async () => {
  const fixture = new URL(
    "./fixtures/base-52090000-52139999/",
    import.meta.url,
  );
  const source = {
    manifest: JSON.parse(
      await readFile(new URL("manifest.json", fixture), "utf8"),
    ),
    bytes: await readFile(new URL("raw.jsonl.gz", fixture)),
  };
  const tokens = JSON.parse(
    await readFile(new URL("tokens.json", fixture), "utf8"),
  );
  const built = await buildHistory(
    [source],
    tokens,
    path.join(directory, "built"),
  );
  expect(built).toMatchObject({
    eventCount: 17,
    tradeCount: 5,
    unknownEvents: 0,
    invalidTrades: 0,
  });
  const fresh = await rebuildParquet(
    path.join(directory, "built"),
    path.join(directory, "rebuilt"),
  );
  expect(fresh.dataset).toEqual(built.dataset);
  const point = built.dataset.candles[300].find(
    (c) => c.poolId === "scale-equalizer-scale-fame" && c.tradeCount,
  )!;
  expect(point).toMatchObject({
    timestamp: 1790973000,
    open: "0.021345266792635092",
    baseVolumeAtoms: "23687327742874360343785",
    quoteVolumeAtoms: "505612330276240036848",
  });
});
