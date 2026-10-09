/** Read-only finalized valuation check. No AWS writes or transaction signing. */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { valuationReader } from "../../src/fame-market-history/valuation-rpc.ts";
import { validateSnapshots } from "../../src/fame-market-history/valuation.ts";
try {
  const url = process.env.FAME_HISTORY_RPC_URL ?? process.env.BASE_RPC_URL;
  if (!url) throw new Error("Missing RPC configuration");
  const scope = historyScope(famePoolStateRegistry);
  const rpc = boundedTransport({
    url,
    maxRequests: 10,
    maxResponseBytes: 256 * 1024,
    deadline: Date.now() + 60_000,
  });
  const chain = chainReader(scope, rpc.transport, 1);
  const block = await chain.finalized();
  const snapshot = await valuationReader(scope, rpc.transport)(block);
  if ((await chain.header(block.number)).hash !== block.hash)
    throw new Error("Finalized hash changed");
  validateSnapshots([snapshot], scope);
  if (process.argv[2])
    await writeFile(process.argv[2], JSON.stringify(snapshot, null, 2), {
      flag: "wx",
    });
  console.log(
    JSON.stringify({
      event: "valuation-read-only-rehearsal",
      blockNumber: block.number,
      oracle: snapshot.ethUsd,
      quotes: Object.fromEntries(
        Object.entries(snapshot.quotes).map(([token, value]) => [
          token,
          value !== null,
        ]),
      ),
      liquidity: Object.fromEntries(
        Object.entries(snapshot.pools).map(([id, value]) => [
          id,
          value !== null,
        ]),
      ),
      metrics: rpc.metrics,
    }),
  );
} catch {
  console.error("Valuation rehearsal failed; RPC details suppressed.");
  process.exitCode = 1;
}
