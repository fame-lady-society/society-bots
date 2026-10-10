# Isolated launch-week runner

The trial covers July 13–20, 2024 UTC (`[1720828800,1721433600)`), beginning at
FAME's launch block 17,019,741. Only Uniswap V2 FAME/WETH and Uniswap V3
FAME/WETH 0.30% are admitted. cbBTC/SPX and all later direct pools are deferred.
The reviewed WETH/USDC route is sampled once per five-minute bucket.

## Run and resume

Use Node 24 and supply `FAME_HISTORY_RPC_URL` in the process environment through
your secret manager. Never write it into the job or command line.

```sh
yarn nodets scripts/market-history/run-local-backfill.ts prepare .market-history-local/launch-week-2024-07-13 --seed /private/tmp/fame-launch-day-2024-07-13
yarn nodets scripts/market-history/run-local-backfill.ts run .market-history-local/launch-week-2024-07-13 --checkpoints 2
yarn nodets scripts/market-history/run-local-backfill.ts run .market-history-local/launch-week-2024-07-13 --max-requests 12000
yarn nodets scripts/market-history/run-local-backfill.ts status .market-history-local/launch-week-2024-07-13
yarn nodets scripts/market-history/run-local-backfill.ts rebuild .market-history-local/launch-week-2024-07-13
```

Seed is optional; without it, collection starts at launch. Re-run `run` after a
pause or transport failure. Raw ranges and samples checkpoint independently;
completed evidence is reused. `rebuild` rejects RPC and verifies deterministic
pages, activity and fresh Parquet replay. No command here accepts a production
table, bucket or dataset activation argument.

The fixed scope, boundary headers, metadata and policy revision live in
`job.json`. Raw bytes are published atomically before immutable manifest commit
markers. Resume validates every checksum, contiguous block interval and adjacent
range hash. An orphan raw upload cannot advance progress. Samples retain raw
Multicall returns and adjacent headers proving their bucket-end boundary.

The exclusive time boundary is important: capture includes the first block at or
after July 20 midnight so the final bucket has provable coverage; derivation
excludes events at/after midnight. The first bucket starts 29 seconds before the
pool launch and retains partial coverage. Prices and candles remain absent when
the existing policy cannot derive them; no zero prices or fabricated openings.
USD-like values are **USDC**, using the existing bucket-end on-chain conversion
policy, not execution-time foreign exchange.

A writer lock rejects concurrent jobs. Normal completion, exceptions and graceful
signals release it. After a forced kill, inspect `writer.lock/owner.json` and
verify that process has exited before manually removing the stale lock. There is
no automatic lock stealing. Filesystem atomicity protects process interruption;
this local disk is not a replicated production archive or power-loss guarantee.

Invocations have request/response/time bounds, a sequential 10 requests/second
ceiling, and optional checkpoint bounds. These pause local work; they impose no
production daily cutoff. Each invocation records request counts, methods,
response bytes, elapsed time and committed checkpoints under `runs/`.

## Serving verification

Start disposable DynamoDB Local on `127.0.0.1:18001`, then:

```sh
yarn nodets scripts/market-history/launch-week-serving-rehearse.ts .market-history-local/launch-week-2024-07-13
```

The script rejects non-loopback endpoints and uses dummy AWS credentials. It
stages dated chart pages and activity indexes plus a final-day rolling window,
then calls the actual API handler for all seven days in ETH and USDC. It checks
paginated event identity/counts against retained activity, chart swap counts,
empty incremental updates, windows across all six midnights, and the explicit
earliest-history/hasEarlier boundary. Its disposable table is deleted afterward.
This proves local serving, not public deployment or production import.

## Assumptions and limits

- Base block spacing is used only to guess the next boundary. Actual adjacent
  headers must bracket the timestamp; otherwise binary search finds it.
- Archived log queries provide range completeness under the existing collector's
  provider trust model. This trial does not independently compare two RPCs.
- Derivation reads the full seven-day raw evidence for each day to preserve
  boundary coverage and previous-bucket weights. A launch-to-present runner will
  need bounded partition loading; this trial is deliberately fixed to one week.
- Existing immutable outputs detect changed derivation. A changed policy needs a
  separate job directory; this runner does not silently overwrite old evidence.
- Local artifacts survive normal restarts but are not uploaded or activated.
  Production promotion remains a separate, explicitly authorized operation.

## Completed trial — October 10, 2026

[Machine-readable receipt](2026-10-10-launch-week-rehearsal.json).

- Raw blocks `17019741..17322127` inclusive, 152 contiguous ranges: 1,632 events,
  971 swaps and 985 economic activity rows. The first-day seed contributed
  22 ranges and 288 samples; 130 new ranges and 1,728 new samples completed the week.
- 2,016 five-minute buckets per currency. ETH and USDC each have 2,012 market
  prices and 2,011 candles. All July 14–19 buckets have prices and candles;
  each day's opening coverage is complete. July 13 retains the existing four
  initial price gaps, five initial candle gaps, and partial launch bucket.
- Local API checks passed for all 14 day/currency combinations: exact chart
  contents, all activity identities/counts, matching swap totals, and empty
  incremental updates. Six windows across midnight passed. Availability reports
  July 13 00:00 UTC as earliest, July 19 23:55 as latest, and `hasEarlier: false`
  at the launch boundary. The final-day rolling window alone does not hide older days.
- Raw-to-Parquet and fresh Parquet replay matched for every bounded group.
  A full offline rebuild reproduced immutable pages/activity/receipt with zero
  RPC calls. The disposable DynamoDB table and container were removed.
- Recovery passed after two raw checkpoints, SIGINT after 75 new samples, and a
  one-request invocation bound. A competing writer was refused. One initial
  preparation attempt exposed the existing eight-batch validation limit; the
  local loader now validates adjacent pairs, including seams, with a regression
  test covering ten ranges. Its failed attempt is included in measured usage.
- 236 tests across 33 history/pool-state/operator suites passed, plus TypeScript.
  No deployed collector, API or infrastructure implementation was changed.

Incremental execution used **6,233 requests / 43,685,535 response bytes**, including
preparation and recovery tests, over approximately **11.8 minutes of active
invocations**. Methods: 130 log queries, 130 chain checks, 4,245 block-header
requests and 1,728 Multicalls. Including the previously measured first-day seed
would total 7,632 requests / 53,858,744 bytes; this is not a new cold-run benchmark
or a provider billing-unit estimate.

Retained logical file sizes: raw archives 547,725 bytes; manifests 132,869;
observations 6,572,160; dated pages/activity/publications 10,656,593. One complete
Parquet build plus its separate replay outputs consumes 25,091,180 bytes. Repeated
offline checks intentionally create additional fresh Parquet directories.
These are local bytes, not compressed S3 billing estimates.

Artifacts remain in `.market-history-local/launch-week-2024-07-13/` in the local
checkout, excluded from Git. Production received **zero writes**. No production
job, import, activation, deployment, or later-pool admission occurred.
