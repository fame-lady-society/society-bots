import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  launchScope,
  withLocalLock,
  localInputs,
  commitLocalRange,
} from "./local-backfill.ts";
import { collect } from "./collector.ts";
import type { Header, Manifest } from "./model.ts";
const scope = launchScope();
const header = (number: number): Header => ({
  number,
  timestamp: 1700000000 + number,
  hash: `0x${number.toString(16).padStart(64, "0")}`,
  parentHash: `0x${(number - 1).toString(16).padStart(64, "0")}`,
});
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "local-fill-test-"));
  for (const name of ["raw", "manifests"]) await mkdir(path.join(dir, name));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function range(from: number) {
  let manifest!: Manifest, bytes!: Uint8Array;
  await collect({
    scope,
    startBlock: from,
    endBlock: from + 1,
    maxBlocks: 2,
    maxEvents: 100,
    chain: {
      finalized: async () => header(1000),
      header: async (n) => header(n),
      logs: async (_, to) => ({ logs: [], throughBlock: to }),
    },
    store: {
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
      reduceRange: async () => {
        throw new Error("unexpected reduction");
      },
    },
  });
  return { manifest, bytes };
}
test("launch scope excludes all later direct pools", () => {
  expect(scope.pools.map((p) => p.id).sort()).toEqual([
    "uniswap-v2-fame-direct",
    "uniswap-v3-weth-fame-30bps",
  ]);
});
test("lock refuses another writer and releases after failure", async () => {
  await expect(
    withLocalLock(dir, async () => {
      await expect(withLocalLock(dir, async () => 0)).rejects.toThrow("locked");
      throw new Error("failed");
    }),
  ).rejects.toThrow("failed");
  expect(await withLocalLock(dir, async () => 1)).toBe(1);
});
test("orphan raw upload cannot advance; committed retries are idempotent", async () => {
  const r = await range(100);
  await writeFile(path.join(dir, "raw", `${r.manifest.sha256}.gz`), r.bytes);
  expect(await localInputs(dir, scope, 100)).toEqual([]);
  await commitLocalRange(dir, r.manifest, r.bytes);
  await commitLocalRange(dir, r.manifest, r.bytes);
  expect(await localInputs(dir, scope, 100)).toHaveLength(1);
});
test("resume accepts more than eight consecutive committed ranges", async () => {
  for (let n = 100; n < 120; n += 2) {
    const r = await range(n);
    await commitLocalRange(dir, r.manifest, r.bytes);
  }
  expect(await localInputs(dir, scope, 100)).toHaveLength(10);
});
test("resume rejects gaps and corrupt bytes", async () => {
  for (const n of [100, 104]) {
    const r = await range(n);
    await commitLocalRange(dir, r.manifest, r.bytes);
  }
  await expect(localInputs(dir, scope, 100)).rejects.toThrow("Noncontiguous");
  const m: Manifest = JSON.parse(
    await readFile(path.join(dir, "manifests", "100.json"), "utf8"),
  );
  await writeFile(path.join(dir, "raw", `${m.sha256}.gz`), "corrupt");
  await expect(localInputs(dir, scope, 100)).rejects.toThrow("checksum");
});
