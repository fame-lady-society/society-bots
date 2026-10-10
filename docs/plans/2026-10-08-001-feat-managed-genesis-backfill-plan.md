---
title: "feat: Managed genesis backfill and dated market-history publication"
type: feat
status: planned
date: 2026-10-08
---

# Managed genesis backfill

## Outcome and scope

Serve the existing consolidated FAME market index, individual pools and activity
feed in ETH or USDC back to the earliest included pool, while continuing live
collection. Preserve native economic events and historical price evidence so
derived data can be repaired without repeating the chain ingest.

The verified earliest direct-pool creation is **Base block 17,019,741,
2024-07-13 00:00:29 UTC**, Uniswap V2 and V3 FAME/WETH. This is genesis for the currently
reviewed pool set, not every FAME pool ever deployed. The six direct pools and
five conversion sources are recorded in the [deployment inventory](../research/2026-10-08-genesis-deployment-inventory.md)
and its JSON evidence. Other old venues and newly proposed pools remain separate
scope additions.

This document supersedes implementation details in the October 6 backfill plan
that referred to the prior Chainlink/execution-candle publisher. Keep its useful
principles: independent progress, newest-to-oldest windows, immutable evidence,
bounded resumable work and short atomic publication. No full-history production
fill was started during this research. Operator merge/deployment remains required;
existing authorization permits local backfill and PRs.

## Current code and missing pieces

Baseline: main `f704e112a83ba13dc05f588acce1e6b2fa418897`.

Reuse:
- `collector.ts`, `rpc.ts`, `archive.ts`, `decode.ts`: bounded address/topic
  scans, ordered native logs, checksums and durable raw archives.
- `reference-collector.ts`, `sampled-rpc.ts`: verified time boundaries and
  historical block-pinned pooled reads.
- `sampled-rebuild.ts`, `market-blend.ts`, activity builders and Parquet exports:
  the same derivation as live collection.
- `chart-api.ts` and activity API: compact responses, filters, bounded reads,
  generation-aware cursors and cache behavior.

Build:
1. Dated source membership and deployment evidence validation.
2. A historical raw-log collector with isolated durable job state.
3. Dated chart/activity publication and bounded date lookup.
4. An operator CLI for preparation, progress, resumption and explicit range repair.

`sampled-backfill.ts` only rebuilds a day from already committed raw archives.
It cannot ingest the missing years. `import-sampled-history.ts` fills a live
publication only until it contains 288 buckets. `sampled-live.ts` then retains
only the latest 288 references. Removing that cap would create an ever-growing
DynamoDB item and is not the design.

## Price and membership rules

Preserve the accepted semantics:
- Direct FAME pools: capture the existing supported swap, liquidity and spot-state
  event set, including events emitted during internal contract calls.
- Conversion pools: read actual historical bucket-end state through the existing
  sampler; do not index their busy swap streams or full liquidity tick books.
- ETH and USDC remain distinct denominations. USDC is not asserted to equal fiat USD.
- Keep native event quantities exact; converted volume and price movements use the
  bucket's closing route rate. This is explicitly not execution-time FX or true
  intrabucket FX extrema.
- Consolidation retains fixed opening FAME-balance weights and the ordered
  direct-pool spot-event path. Do not average independent pool highs and lows.

Represent source lifecycle separately from unavailable data:
- Before verified creation: `not-created`, excluded from eligible market
  membership; never a missing active pool.
- Created but uninitialized or without usable liquidity: explicit no-price state.
- Active source with unavailable archival state: explicit unavailable price/route,
  preserving native events and unpriced quantities.
- Provider timeout or rate limit: retry/yield, not a permanent historical gap.

Store a stable dataset identity with versioned membership/valuation definitions;
do not make all old archives unusable when a new pool is added to today's registry.
Freeze the definition in each job and each derived publication. Do not auto-select
a modern alternative route for old data.

For a pool created inside a bucket, capture its logs immediately and include its
activity in totals. Its opening index weight is zero because it did not exist at
the opening boundary; it enters the blended index at the next bucket's opening
snapshot. Document this explicitly and test the creation bucket. No imaginary
pre-creation price or candle. A disappeared or unreadable active pool is not silently
assigned zero weight to make the blend look complete.

Creation is evidence, not proof of perpetual liquidity. Verify the inventory's
creation receipts and historical state through the configured RPC before running.
V4 requires pool-ID initialization and hook/state-reader compatibility at the
historical block, not PoolManager deployment. A newer StateView helper may not
exist for older history even when the pool does; record that limitation rather
than use current state.

## Frozen jobs and operator controls

Provide a single small CLI with proposed operations:
- `prepare --to-existing-history --from-pool-genesis`: read-only manifest.
- `run --job <id>` / `resume --job <id>`: bounded work from saved checkpoints.
- `status --job <id>`: target, completed windows, current phase/cursor, last
  progress time, errors, price gaps, cumulative requests/bytes/storage.
- `pause --job <id>`: cooperative pause after the next durable checkpoint.
- `repair --from ... --to ...`: prepare a replacement generation for an explicit
  range using retained archives first; missing raw intervals require explicit
  recollection within the frozen repair job.

Freeze chain/account/region/resources, dataset and policy revision, per-source
origins, requested interval, current archive frontier, boundary block hashes,
metadata, and job identity. Resume never recomputes the interval from wall time.
Reject concurrent ownership with a fenced expiring lease. Stale runners cannot
commit; duplicate submissions reuse the same job.

Initial backfill works backward from the earliest verified contiguous raw coverage.
Choose adjacent UTC/bucket-aligned windows up to one day, shrinking when limits
require it. Scan forward within each window; record contiguous raw prefix commits.
A crash resumes that prefix without rescanning completed ranges. Separate phases:
raw capture → historical observations → derived artifacts → verified publication.
Status distinguishes those phases rather than reporting archived data as served.

The genesis edge includes the deployment block, even though launch is mid-bucket.
Known pre-creation time is not a raw-event gap. At the live-history join, rebuild
the complete shared bucket from both sides and deduplicate by chain/block/log
identity; never sum independently aggregated candles.

## Storage, publication and bounded serving

Keep S3 as durable evidence/Parquet storage and DynamoDB for job state, date
directories and serving pages. No new database, queue service or paid monitoring.

Use immutable, checksummed artifacts plus deterministic per-UTC-day directory
keys. A directory contains at most 288 bucket references and the matching chart/
activity generation, coverage intervals and membership revision. Do not put years
of references in one item or scan the table to answer a date query.

Stage chart pages, activity indexes/chunks and provenance first. Conditionally
publish a day-directory pointer only after all referenced artifacts are present
and verified. Readers capture immutable day generations: replacements cannot expose
half-old, half-new chart/activity results. Limit the commit transaction to pointers,
lease conditions and job progress rather than every historical event.

A day-sized request touches at most two UTC date directories plus bounded pages.
Continue enforcing the existing 24-hour request maximum, response limits and
activity scan/chunk caps; users can request different dates. Empty/short filtered
activity pages retain continuation cursors. Multi-day storage does not imply
unbounded API responses.

Keep the rolling live manifest for fast incremental refresh, but write the dated
directory before evicting live references. Do not let the live writer overwrite
a historical repair: assign settled ranges to historical publication and serialize
the handoff through an expected-generation condition. Derive the safe handoff
from the live worker's actual trailing-bucket rewrite behavior.

Across live/historical seams resolve each bucket to one owner. Historical requests
use a cursor/ETag derived from only the requested generations; new live buckets
must not invalidate an unchanged old date. A repair replaces affected data or
returns the existing explicit cursor-reset response. Preserve retained old
generations for cursor lifetime; audit TTL on directories, pages and chunks so
canonical history never expires with a short-lived cursor manifest.

Repair windows crossing UTC days publish each day atomically and record per-day
completion. They do not promise a transaction across the entire requested range.
Responses describe their captured day revisions and never claim all days share one
generation. A reader racing a pointer update must finish coherently or retry.

## Efficiency and cost rehearsal

Blockscout is deployment discovery evidence; raw collection continues through the
existing RPC and archive pipeline. Restrict log address sets by source lifetime,
and request only supported direct-pool event topics. Use adaptive block ranges,
reuse existing committed archives and cache verified boundary headers. Do not fetch
every block or transaction receipt during the full fill.

Share each boundary lookup and Multicall across sources; omit sources not yet
created. Persist observations so restarts/rebuilds do not reread them. Use archival
raw headers to bracket timestamps, verify the closing block and successor, and
avoid full-chain binary search for every five-minute boundary.

There are 288 sample times/day, 105,120/year; a continuous run reuses opening
observations and only needs one additional boundary seed. That is a timestamp
count, not an RPC-call or billing estimate. Measure headers, Multicalls, subcalls,
provider billing units, logs, retries and bytes separately. Recent one-day
measurements are not proof of costs or archive availability in 2024.

Per-run request, total-byte, time and single-response bounds yield after a durable
checkpoint. Keep busy block-header handling from PR #51. A single indivisible
oversized item stops with an actionable reason; never skip it or loop without
progress. No hard daily cutoff. Retain a configurable low request rate/concurrency
for operator-paced runs; foreground invocations only until production wiring is
reviewed. No detached process or new scheduler in this milestone.

Read-only launch rehearsal:
1. Validate chain/resource identity and the eleven source boundaries.
2. Sample a small fixed selection near the earliest launch and each later pool
   launch, plus a quiet and an active current bucket. Record every call/byte/error.
3. Freeze **2024-07-13 00:00 UTC through July 14 00:00 UTC** as the first
   24-hour exercise. Include both V2 and V3 from their shared creation block,
   exclude the four later direct pools by lifecycle, and leave the interval
   between this day and live coverage explicitly unfilled. Capture/rebuild
   locally, interrupt/resume, and compare with a clean rebuild.
4. Prepare the exact production import manifest and expected read/write/storage
   counts. Operator merges/deploys serving changes before publication.
5. Verify that historical date through authenticated chart and activity APIs in
   both currencies, including launch boundaries and the gap to live history. Rehearse the live
   join with a later adjacent window. Only then extend the managed target to
   the remaining years.

## Tests, review and completion

Meaningful automated tests must cover:
- Creation vs first-transaction mismatch, exact V4 pool ID and missing receipt.
- Mid-bucket launches, pools absent before creation, route absence, no-trade
  periods, missing active pools and dynamic index weights.
- Event identity/order, multiple rows per transaction, zero/partial/unpriced
  values and size/type filtering in both denominations.
- Termination before/after artifact upload and commit; lost commit response,
  duplicate runners, expired leases, response-range shrink and no-progress errors.
- Live joins, bucket/day seams, historical repair concurrent with reads, live
  eviction, cursor expiry and retained generation references.
- Native totals and spot candles matching one canonical rebuild; quiet-bucket
  samples from actual historical state; no modern-state substitution.
- DynamoDB transaction/item limits, read/response bounds, TTL protection and IAM
  restrictions. API reads must not trigger RPC or chain backfill.

Rehearse against DynamoDB Local and the real archive/derivation code; test HTTP
handlers, compact charts and paginated activity. Review consistency, simplicity,
security and adversarial failure scenarios before production execution.

The first reviewable implementation milestone is a managed historical day,
including date-addressable chart/activity publication and restart/repair proof.
Genesis completion means the declared pool scope is scanned from each verified
origin to the existing archive, derived coverage and explicit price gaps are
published, and operator receipts reconcile raw events, API totals and costs.
It does not mean every historical price is recoverable or every FAME pool was
included.

## Open evidence gates

- Launch-week historical state and serving are now verified by the isolated
  trial below. Later-pool helper/hook availability still needs its own evidence.
- Full-history RPC cost, event count and serving storage are unmeasured.
- Deployment boundaries are explorer-backed; preserve the supplied evidence and
  confirm canonical hashes before registering a production job.
- Confirm actual archive frontier and current live health at preparation time;
  do not reuse an earlier chat's timestamp as operational input.

## July 13–20 isolated trial

The next authorized step is the fixed launch-week local runner documented in
[the launch-week runbook](../research/2026-10-10-launch-week-runner.md).
It extends the verified first day to seven days using the same two launch pools.
cbBTC/SPX discovery remains separate and those pools are not admitted here.
This milestone exercises local checkpoints, historical state availability,
deterministic replay and dated API serving. It does not register a production
job or switch the active dataset. Launch-to-present scheduling and bounded
partition loading remain subsequent work, informed by the trial measurements.
