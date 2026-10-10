# Launch-day rehearsal and PR 56 reconciliation

PR 56 incorporates main through `59a4a91`: dated chart/activity serving (#53),
earliest-history availability (#54), and retain-live materialization (#57).
Availability and the materialization operator resolve the active dataset, just
like chart/activity reads. Deploying admission code does not select six pools.

## Captured evidence

The isolated scope contains the two FAME pools created in Base block 17,019,741:
Uniswap V2 and Uniswap V3 FAME/WETH 0.30%. Later pools are not admitted into this
launch-day scope. The existing WETH/USDC conversion route is sampled, not indexed
for every swap. No production data was written or activated.

- Exact raw interval: July 13, 2024 00:00:29 UTC through July 14 00:00:29 UTC,
  blocks `[17019741, 17062941)`. Both boundary timestamps were verified by RPC.
- Chart interval: July 13 00:00 through July 14 00:00 UTC, 288 aligned buckets.
  This begins 29 seconds before pool creation and excludes the final 29 seconds
  of the raw interval. It is not a claim of pre-creation coverage.
- 22 contiguous archive batches; 1,362 raw events; 803 swaps; 811 activity rows
  (474 buys, 329 sells, seven adds, one remove).
- Both ETH and USDC: 284 market prices, 283 market candles, two unpriced activity
  rows. All 288 buckets remain present with explicit coverage.
- 1,399 RPC requests and 10,173,209 response bytes, including two resume checks.
  Methods: 1,067 block headers, 22 chain checks, 22 log queries, 288 Multicalls.
  Compressed canonical raw archives: 184,726 bytes. These are measured traffic
  and request counts, not provider billing estimates.

The first four V3 samples have zero active liquidity despite a FAME balance.
The existing sampler therefore withholds a price. The first market bucket also
has no preceding inventory weights. At 00:20 a market price becomes available,
but its V3 candle is partial without an opening reference. The blended candle
remains absent rather than manufacturing an opening value. Historical conversion
uses the reviewed bucket-end on-chain route, not execution-time FX.

## Verification and artifacts

See `2026-10-09-launch-day-rehearsal.json` for the machine-readable receipt.
The local raw, observation, page and activity artifacts are retained at
`/private/tmp/fame-launch-day-2024-07-13` on the rehearsal machine. That temporary
directory is not a durable production archive; preserve it before cleanup if it
will be reused for a future import.

Raw-to-Parquet and fresh Parquet-to-dataset rebuilds matched exactly. The builder
retains its eight-batch limit; the rehearsal splits its 22 batches into bounded
groups. Resuming reuses immutable raw/sampling evidence and creates a fresh local
derived-output directory, without repeating log queries or historical samples.

The actual Lambda handler against DynamoDB Local returned 288 chart buckets and
all 811 activity rows in each currency, without duplicate event identities.
Activity required 25 paginated requests per currency. Chart trade counts matched
activity swaps, unchanged cursors returned empty deltas, and availability stopped
at the launch-day boundary. This is local handler proof, not a public deployment.

Reconciliation validation: 465 history/pool-state/operator tests, four CDK tests,
TypeScript, and the existing DynamoDB Local worker/transition rehearsal passed.
Active-five-pool chart and availability behavior has a regression test even when
the deployed registry knows six pools.

## Next boundary

Production's active scope was read before and after and remains
`4ec4f8ca2a9f9a27565e438683d40f7d56b2caef62b32879eaaad31b26073389`.
No genesis job, production import, deployment, or dataset activation was started.
Operator merge/deployment and any later dataset activation remain separate.
This proves one launch day; managed multi-day progress and admission of pools at
their individual creation boundaries remain part of the managed-genesis plan.
