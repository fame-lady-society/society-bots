/** Explicit operator-only admission. Production registry/worker never imports this module. */
import { readFileSync } from "node:fs";
import { fameHistoryRegistry } from "./registry.ts";
import { parseFamePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { historyScope, digest, integer } from "./model.ts";
import { sampledPolicy } from "./sampled-market.ts";
import type { TokenMetadata } from "./decode.ts";

export const isolatedRegistry = parseFamePoolStateRegistry({
  ...fameHistoryRegistry,
  pools: [
    ...fameHistoryRegistry.pools,
    ...JSON.parse(
      readFileSync(new URL("./isolated-pools.json", import.meta.url), "utf8"),
    ),
  ],
});
export const isolatedScope = historyScope(isolatedRegistry);
export const isolatedDecimals: Record<string, number> = {
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": 8,
  "0x50da645f148798f68ef2d7db7c1cb22a6819bb2c": 8,
};
export interface Origin {
  id: string;
  creationBlock: number;
  creationTimestamp: string;
  creationTransaction: string;
}
export function isolatedOrigins(): Origin[] {
  const old = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/research/2026-10-08-genesis-deployment-evidence.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const added: Origin[] = JSON.parse(
    readFileSync(
      new URL(
        "../../docs/research/2026-10-10-pool-admission-origins.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return [
    ...old.pools.map((p: any) => ({
      id: p.id,
      creationBlock: p.creationEvidence.block,
      creationTimestamp: p.creationEvidence.timestamp,
      creationTransaction: p.creationEvidence.creationTx,
    })),
    ...added,
  ];
}
export function isolatedMetadata(
  blockNumber: number,
  blockHash: string,
): TokenMetadata {
  const original: TokenMetadata = JSON.parse(
    readFileSync(new URL("./token-metadata.json", import.meta.url), "utf8"),
  );
  return {
    ...original,
    blockNumber,
    blockHash,
    decimals: { ...original.decimals, ...isolatedDecimals },
    poolTokens: Object.fromEntries(
      isolatedScope.pools.map((p) => [
        p.id,
        { token0: p.token0, token1: p.token1 },
      ]),
    ),
  };
}
export function isolatedPoolScope(id: string) {
  if (!isolatedScope.pools.some((p) => p.id === id))
    throw new Error("Unknown isolated direct pool");
  return historyScope({
    ...isolatedRegistry,
    pools: isolatedRegistry.pools.filter(
      (p) => !isolatedScope.pools.some((d) => d.id === p.id) || p.id === id,
    ),
  });
}
/** Freeze a local-only target and lifecycle windows; never read or alter active-scope. */
export function prepareIsolatedBackfill(from: number, to: number) {
  integer(from, "from");
  integer(to, "to");
  if (from % 300 || to % 300 || to <= from || to - from > 3660 * 86400)
    throw new Error("Invalid isolated interval");
  const origins = isolatedOrigins();
  const births = isolatedScope.pools.map((p) => {
    const o = origins.find((o) => o.id === p.id);
    if (
      !o ||
      !Number.isSafeInteger(o.creationBlock) ||
      !Number.isFinite(Date.parse(o.creationTimestamp))
    )
      throw new Error("Missing verified pool origin");
    return { ...o, timestamp: Date.parse(o.creationTimestamp) / 1000 };
  });
  const cuts = new Set([from, to]);
  for (let t = (Math.floor(from / 86400) + 1) * 86400; t < to; t += 86400)
    cuts.add(t);
  // A pool joins in its creation bucket; no claim that it existed earlier in that bucket.
  for (const o of births) {
    const t = Math.floor(o.timestamp / 300) * 300;
    if (t > from && t < to) cuts.add(t);
  }
  const boundaries = [...cuts].sort((a, b) => a - b);
  const windows = boundaries.slice(0, -1).map((start, i) => ({
    from: start,
    to: boundaries[i + 1],
    poolIds: births
      .filter((o) => o.timestamp < boundaries[i + 1])
      .map((o) => o.id)
      .sort(),
  }));
  if (windows.some((w) => !w.poolIds.length))
    throw new Error("Interval precedes first pool launch");
  const definition = {
    version: "isolated-backfill-plan-v1",
    destination: "local-only",
    scope: isolatedScope,
    policy: sampledPolicy(isolatedScope),
    from,
    to,
    origins,
    windows,
  };
  return { ...definition, id: digest(JSON.stringify(definition)) };
}
