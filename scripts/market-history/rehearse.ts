import { runHistory } from "../../src/fame-market-history/runtime.ts";

// Intentionally read-only. Requires a bounded start/range and explicit environment.
if (process.argv.length !== 2)
  throw new Error("Usage: yarn nodets scripts/market-history/rehearse.ts");
try {
  console.log(
    JSON.stringify(
      await runHistory(process.env, {
        dryRun: true,
        deadline: Date.now() + 60_000,
      }),
      null,
      2,
    ),
  );
} catch {
  console.error(
    "History rehearsal failed; provider details omitted to protect credentials.",
  );
  process.exitCode = 1;
}
