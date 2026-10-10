/** Local-only checkpoint primitives. No AWS clients or production publication. */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { immutableFile } from "./local-artifacts.ts";
import { readArchive, validateBatchSequence } from "./archive.ts";
import { historyScope, type Manifest, type Scope } from "./model.ts";
import { fameHistoryRegistry } from "./registry.ts";

export function launchScope() {
  const ids = new Set(["uniswap-v2-fame-direct", "uniswap-v3-weth-fame-30bps"]);
  const all = historyScope(fameHistoryRegistry);
  const scope = historyScope({
    ...fameHistoryRegistry,
    pools: fameHistoryRegistry.pools.filter(
      (p) => !all.pools.some((d) => d.id === p.id) || ids.has(p.id),
    ),
  });
  if (scope.pools.length !== 2 || scope.pools.some((p) => !ids.has(p.id)))
    throw new Error("Launch scope changed");
  return scope;
}
export async function withLocalLock<T>(
  directory: string,
  run: () => Promise<T>,
) {
  await mkdir(directory, { recursive: true });
  const lock = path.join(directory, "writer.lock");
  try {
    await mkdir(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Local writer locked; verify the owner has exited before removing a stale lock",
      );
    throw e;
  }
  try {
    await writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    );
    return await run();
  } finally {
    await rm(lock, { recursive: true });
  }
}
export async function localInputs(
  directory: string,
  scope: Scope,
  startBlock: number,
) {
  const names = (await readdir(path.join(directory, "manifests"))).filter((n) =>
    /^\d+\.json$/.test(n),
  );
  const inputs = await Promise.all(
    names.map(async (n) => {
      const manifest: Manifest = JSON.parse(
        await readFile(path.join(directory, "manifests", n), "utf8"),
      );
      if (
        n !== `${manifest.fromBlock}.json` ||
        !/^[a-f0-9]{64}$/.test(manifest.sha256)
      )
        throw new Error("Invalid local manifest identity");
      const bytes = await readFile(
        path.join(directory, "raw", `${manifest.sha256}.gz`),
      );
      return { manifest, bytes };
    }),
  );
  inputs.sort((a, b) => a.manifest.fromBlock - b.manifest.fromBlock);
  const batches = inputs.map((i) => readArchive(i.manifest, i.bytes));
  for (let i = 0; i < batches.length; i++) {
    if (
      batches[i].scope.id !== scope.id ||
      inputs[i].manifest.fromBlock !==
        (i ? inputs[i - 1].manifest.toBlock + 1 : startBlock)
    )
      throw new Error("Noncontiguous local checkpoint");
  }
  for (let i = 0; i < batches.length; i++)
    validateBatchSequence(
      batches.slice(Math.max(0, i - 1), i + 1),
      inputs.slice(Math.max(0, i - 1), i + 1).map((input) => input.manifest),
    );
  return inputs;
}
export async function commitLocalRange(
  directory: string,
  manifest: Manifest,
  bytes: Uint8Array,
) {
  readArchive(manifest, bytes);
  await immutableFile(
    path.join(directory, "raw", `${manifest.sha256}.gz`),
    bytes,
  );
  // Manifest is the commit marker; an interrupted raw write cannot advance progress.
  await immutableFile(
    path.join(directory, "manifests", `${manifest.fromBlock}.json`),
    Buffer.from(JSON.stringify(manifest)),
  );
}
