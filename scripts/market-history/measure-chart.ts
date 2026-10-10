/** Offline serving rehearsal from a saved detailed API response. No credentials/network. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { fameHistoryRegistry } from "../../src/fame-market-history/registry.ts";
import { historyScope, digest } from "../../src/fame-market-history/model.ts";
import { sampledPageKey } from "../../src/fame-market-history/keys.ts";
import { readChart } from "../../src/fame-market-history/chart-api.ts";
const [directory, out] = process.argv.slice(2);
if (!directory || !out)
  throw new Error("Expected input and output directories");
const scope = historyScope(fameHistoryRegistry);
await mkdir(out, { recursive: true });
const inputs = await Promise.all(
  ["ETH", "USDC"].map((c) =>
    readFile(`${directory}/${c}.json`, "utf8").then(JSON.parse),
  ),
);
const data = new Map<string, any>(),
  pages: any[] = [];
const key = (k: any) => `${k.pk}|${k.sk}`;
for (let i = 0; i < inputs[0].buckets.length; i++) {
  const ref: any = { timestamp: inputs[0].buckets[i].timestamp };
  for (const input of inputs) {
    const { publicationStatus: _, ...b } = input.buckets[i];
    if (input.buckets[i].publicationStatus !== "published")
      throw new Error("Use a fully published fixture window");
    const body = JSON.stringify(b),
      sha = digest(body),
      k = sampledPageKey(b.policyRevision, b.currency, b.timestamp, sha);
    ref[b.currency] = sha;
    data.set(key(k), { ...k, body });
  }
  pages.push(ref);
}
const body = {
  version: "fame-sampled-publication-v1",
  policyRevision: inputs[0].buckets[0].policyRevision,
  startTimestamp: inputs[0].from,
  nextTimestamp: inputs[0].to,
  pages,
};
const publication = { ...body, generation: digest(JSON.stringify(body)) };
let pageReads = 0,
  calls = 0;
const db = {
  send: async (c: any) => {
    calls++;
    if (c.input.Key) return { Item: publication };
    const keys = c.input.RequestItems.table.Keys;
    pageReads += keys.length;
    return {
      Responses: { table: keys.map((k: any) => data.get(key(k))).reverse() },
    };
  },
} as unknown as DynamoDBDocumentClient;
for (const currency of ["ETH", "USDC"] as const)
  for (const series of ["market", ...scope.pools.map((p) => p.id)]) {
    pageReads = 0;
    calls = 0;
    const started = performance.now();
    const request = {
      currency,
      series,
      from: inputs[0].from,
      to: inputs[0].to,
    };
    const snapshot = await readChart(db, "table", scope, request),
      json = JSON.stringify(snapshot),
      snapshotReads = pageReads,
      snapshotCalls = calls;
    pageReads = 0;
    calls = 0;
    const idle = await readChart(db, "table", scope, {
      ...request,
      cursor: snapshot.cursor,
    });
    if (pageReads !== 0 || idle.upserts.length !== 0)
      throw new Error("Idle poll reread data");
    await writeFile(`${out}/${currency}-${series}.json`, json);
    console.log(
      JSON.stringify({
        currency,
        series,
        decodedBytes: Buffer.byteLength(json),
        gzipBytes: gzipSync(json).length,
        snapshotReads,
        snapshotCalls,
        idleReads: pageReads,
        idleCalls: calls,
        idleBytes: Buffer.byteLength(JSON.stringify(idle)),
        localMs: Math.round(performance.now() - started),
      }),
    );
  }
