/** Read-only AWS rehearsal. Reports metadata, never credentials or bodies. */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { readChart } from "../../src/fame-market-history/chart-api.ts";
import { sampledReader } from "../../src/fame-market-history/sampled-reader.ts";
import { sampledPolicy } from "../../src/fame-market-history/sampled-market.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import { fameHistoryRegistry } from "../../src/fame-market-history/registry.ts";
const table = process.env.FAME_HISTORY_TABLE;
if (!table) throw new Error("Missing history table");
const scope = historyScope(fameHistoryRegistry),
  client = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
let calls = 0,
  capacity = 0,
  pages = 0;
const db = {
  send: async (command: any, options: any) => {
    calls++;
    command.input.ReturnConsumedCapacity = "TOTAL";
    pages += command.input.RequestItems?.[table]?.Keys.length ?? 0;
    const r: any = await client.send(command, options);
    const consumed = Array.isArray(r.ConsumedCapacity)
      ? r.ConsumedCapacity
      : [r.ConsumedCapacity];
    capacity += consumed.reduce(
      (n: number, c: any) => n + (c?.CapacityUnits ?? 0),
      0,
    );
    return r;
  },
} as unknown as DynamoDBDocumentClient;
try {
  const p = await sampledReader(
    db,
    table,
    sampledPolicy(scope).revision,
  ).publication();
  for (const currency of ["ETH", "USDC"] as const) {
    const request = {
      currency,
      series: "market",
      from: p.startTimestamp,
      to: p.nextTimestamp,
    };
    const samples = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      calls = 0;
      capacity = 0;
      pages = 0;
      const t = performance.now();
      const r = await readChart(db, table, scope, request);
      cursor = r.cursor;
      samples.push({
        ms: Math.round(performance.now() - t),
        calls,
        capacity,
        pages,
      });
    }
    calls = 0;
    capacity = 0;
    pages = 0;
    const t = performance.now();
    const idle = await readChart(db, table, scope, { ...request, cursor });
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        currency,
        location: "local client to AWS (not deployed Lambda)",
        p50Ms: (sorted[9] + sorted[10]) / 2,
        p95Ms: sorted[18],
        samples,
        idle: {
          ms: Math.round(performance.now() - t),
          calls,
          capacity,
          pages,
          upserts: idle.upserts.length,
        },
      }),
    );
  }
} finally {
  client.destroy();
}
