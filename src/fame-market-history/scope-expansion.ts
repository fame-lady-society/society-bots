import { VALUATION_VERSION } from "./valuation.ts";
import { collect, type ArchiveStore, type ChainReader } from "./collector.ts";
import { readArchive } from "./archive.ts";
import { historyScope, type Manifest, type Scope } from "./model.ts";

/** Expansion is deliberately additive: never relabel an archive after changing
 * an existing emitter, ABI family, token order, or conversion route. */
export function expansionPools(source: Scope, target: Scope) {
  if (source.id === target.id)
    throw new Error("Expansion requires a new scope");
  for (const pool of source.registry.pools) {
    const next = target.registry.pools.find((p) => p.id === pool.id);
    if (JSON.stringify(pool) !== JSON.stringify(next))
      throw new Error(`Expansion changed existing registry entry: ${pool.id}`);
  }
  const added = target.pools.filter(
    (p) => !source.pools.some((s) => s.id === p.id),
  );
  if (
    !added.length ||
    target.pools.length !== source.pools.length + added.length
  )
    throw new Error("Expansion must only add direct pools");
  return historyScope({
    ...target.registry,
    pools: target.registry.pools.filter((p) =>
      added.some((a) => a.id === p.id),
    ),
  });
}

/** Read missing emitters only; reuse the source's checksummed native events.
 * The regular collector validates the merged logs and archives a NEW scope.
 * Live finality, boundary rechecks, capacity splits and cursor CAS remain intact. */
export async function expandRange({
  source,
  target,
  manifest,
  bytes,
  chain,
  store,
  startBlock,
  maxBlocks,
  maxEvents,
}: {
  source: Scope;
  target: Scope;
  manifest: Manifest;
  bytes: Uint8Array;
  /** Must read logs for expansionPools(source, target), not the whole target. */
  chain: ChainReader;
  store: ArchiveStore;
  startBlock: number;
  maxBlocks: number;
  maxEvents: number;
}) {
  const added = expansionPools(source, target);
  const batch = readArchive(manifest, bytes);
  if (manifest.scopeId !== source.id || batch.scope.id !== source.id)
    throw new Error("Expansion source archive mismatch");
  const cursor = await store.cursor(target.id, startBlock);
  if (
    cursor.nextBlock < manifest.fromBlock ||
    cursor.nextBlock > manifest.toBlock
  )
    throw new Error("Source archive does not cover expansion cursor");
  const last = batch.headers.find((h) => h.number === manifest.toBlock)!;
  if ((await chain.header(last.number)).hash !== last.hash)
    throw new Error("Expansion source boundary is no longer canonical");
  const headers = new Map(batch.headers.map((h) => [h.number, h]));
  return collect({
    scope: target,
    store: {
      ...store,
      commit: (expanded, expected) =>
        store.commit(
          {
            ...expanded,
            sourceArchive: {
              scopeId: source.id,
              key: manifest.key,
              sha256: manifest.sha256,
              fromBlock: manifest.fromBlock,
              toBlock: manifest.toBlock,
            },
          },
          expected,
        ),
    },
    startBlock,
    maxBlocks,
    maxEvents,
    endBlock: manifest.toBlock,
    chain: {
      // Preserve existing boundary valuation evidence byte-for-byte. A capacity
      // split can introduce boundaries that were never sampled: retain explicit
      // unavailable values there instead of moving an old observation in time.
      ...(batch.valuation
        ? {
            valuation: async (block) =>
              batch.valuation!.find((v) => v.block.number === block.number) ?? {
                version: VALUATION_VERSION,
                block,
                ethUsd: null,
                quotes: {},
                pools: {},
              },
          }
        : {}),
      finalized: () => chain.finalized(),
      // Re-read headers, including retained source events. Do not let a cache
      // defeat the collector's final canonical boundary check.
      header: async (n) => {
        const header = await chain.header(n);
        if (headers.has(n) && headers.get(n)!.hash !== header.hash)
          throw new Error("Expansion source header changed");
        return header;
      },
      headerAllowance: chain.headerAllowance?.bind(chain),
      logs: async (from, to) => {
        const scanned = await chain.logs(from, to);
        if (
          scanned.logs.some(
            (l) =>
              !added.pools.some((p) => p.address === l.address.toLowerCase()),
          )
        )
          throw new Error(
            "Expansion RPC returned an existing or unknown emitter",
          );
        return {
          ...scanned,
          logs: [
            ...batch.events.filter(
              (e) =>
                e.blockNumber >= from && e.blockNumber <= scanned.throughBlock,
            ),
            ...scanned.logs,
          ],
        };
      },
    },
  });
}
