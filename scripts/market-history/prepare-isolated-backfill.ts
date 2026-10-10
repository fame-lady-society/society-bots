/** Writes a frozen local planning manifest. No AWS, RPC, publication or activation. */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { prepareIsolatedBackfill } from "../../src/fame-market-history/isolated-backfill.ts";
import { immutableFile } from "../../src/fame-market-history/local-artifacts.ts";
const [directory, from, to] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  !directory ||
  !/^\d+$/.test(from) ||
  !/^\d+$/.test(to)
)
  throw new Error(
    "Usage: prepare-isolated-backfill.ts <local-directory> <from-unix> <to-unix>",
  );
const plan = prepareIsolatedBackfill(Number(from), Number(to));
await mkdir(directory, { recursive: true });
await immutableFile(
  path.join(directory, "plan.json"),
  Buffer.from(JSON.stringify(plan)),
);
const saved = JSON.parse(
  await readFile(path.join(directory, "plan.json"), "utf8"),
);
console.log(
  JSON.stringify({
    id: saved.id,
    from: saved.from,
    to: saved.to,
    windows: saved.windows.length,
    directPools: saved.scope.pools.length,
    destination: saved.destination,
    status: "prepared-not-collected",
    productionWrites: 0,
  }),
);
