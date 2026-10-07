---
title: "feat: Extend FAME market history backward without interrupting live collection"
type: feat
status: planned
date: 2026-10-06
---

# FAME market history backfill

## Scope and approval boundary

The operator approved planning a backward fill, initially 24 hours before the
existing recorded history boundary. This document is a plan only: no code,
deployment, production data writes, or backfill execution is authorized by writing
it. Live recording continues. Range replay and repair are a separate increment.

Deliver a bounded, resumable operator CLI that collects older events and historical
valuation observations, archives them, builds the existing five-minute pool and
ETH/USD market candles, and extends the existing API's continuous coverage backward.
Use the existing five-pool scope and valuation policy. Do not expand venues or
attempt all-time history in this milestone.

Out of scope: repair/replacement of published history, new resolutions, frontend
charts, automatic recurring backfills, paid monitoring, hard daily RPC budgets,
and a general job orchestration framework. Retain immutable evidence and exact
range identities so repair can be designed later; do not implement repair hooks or
compatibility layers speculatively.

## Current implementation and constraints

Grounded in main commit `26951d1644e4adff1ccacb5e5a992719462c07b4`:

- `collector.ts` and `storage.ts` use a forward cursor with an immutable start.
  Changing the start is rejected. Collection commits raw manifests, cursor and
  pending work atomically.
- `worker.ts` adds adjacent raw context, rebuilds the previous trailing bucket,
  and emits immutable nonoverlapping Parquet partitions plus evidence.
- `worker-storage.ts` publishes pool and market rows together under a fenced
  lease. It advances the forward checkpoint; its current first-coverage fields
  use `if_not_exists`. This publisher cannot simply be run in reverse.
- `api.ts` expects one continuous published interval. Rows outside that interval,
  or missing rows inside it, are integrity failures. It checks progress before and
  after bounded DynamoDB reads; partially exposing historical rows is unsafe.
- The retained SSM launch marker records block 52,264,484 for this deployment.
  Treat this as observed deployment evidence, not a hard-coded backfill input.
  Read and validate current state when preparing the job.

Never reset the live cursor, worker checkpoint, launch marker, or active scope.
A collector-only local sample is not completion: the milestone ends with historical
results available through the production API after a separately authorized run.

## Operator flow and frozen job

Proposed CLI operations (interfaces to implement, not existing commands):

1. `prepare --hours 24`: read current scope/progress and resolve the exact interval;
   produce a reviewable manifest locally without production writes.
2. `run --manifest <path>`: conditionally register that manifest, then do bounded
   collection, aggregation and publication work. Stop cleanly at a per-run limit.
3. `resume --job <id>`: continue the same frozen job and checkpoints.
4. `status --job <id>`: read progress, coverage and cumulative resource statistics.

Preparation records chain ID, scope and serving/metadata revisions, requested
seconds, earliest committed boundary and hash, selected inclusive block range,
parent/endpoint hashes, timestamps, current publication boundary and a deterministic
job identity. The initial end is the block immediately before the earliest recorded
contiguous interval. Later jobs start from the newly extended boundary, not from
wall-clock time or the original launch marker.

Resolve the target timestamp as the frozen boundary timestamp minus 86,400 seconds.
Use bounded block-header binary search, including a predecessor before the target
and before the first affected bucket when needed to establish completeness. Record
requested coverage separately from extra boundary context. Never assume a fixed
blocks-per-day rate, infer deployment blocks for other pools, or silently shorten
24 hours when RPC history is unavailable. Validate the scope was applicable at the
selected historical blocks; unsupported pool history stops preparation or execution
with an explicit reason rather than fabricating zero activity.

Repeated preparation against the same boundary and policy must not create competing
active jobs. Resume reads persisted bounds; it never recalculates them from now.
Account, region, table, bucket and RPC chain identity must be checked before writes.

## Collection and durable progress

Use the existing RPC transport, filtered address/topic queries, adaptive range
splitting, event/header validation, decoder, and historical valuation reads. Extract
only the minimum shared collector operation needed for explicit range bounds; do
not duplicate log ingestion or synthesize a fake finalized head to impose an end.

Select adjacent windows from newest to oldest. Within a selected window, reuse
forward scanning and prefix commits with a separate backfill cursor. Fully capture
and validate the window before making it visible, then move the backward frontier.
The persisted window bounds and internal scan cursor survive shortened RPC ranges,
process termination and resumption. A partial forward prefix of a historical window
must not advance the visible backward frontier.

Keep job state and staged manifests in a separate key namespace in the existing
DynamoDB table. Reuse immutable content-addressed raw S3 objects and checksum
verification. Staged manifests do not become live pending-work entries, do not alter
the collector cursor, and do not appear as canonical partitions until committed.
Use conditional creation and a fenced job lease so duplicate runners converge or
exit as busy. Persist observed hashes and verify adjacency to the existing archive.

Per-run time, requests, response bytes and event limits bound work. They yield with
saved progress and an understandable reason; no daily hard cutoff is added. A
single block that cannot be verified stops that window without skipping it. Retry
transport/provider failures within the existing bounded policy; fail on integrity
or policy mismatch. Report repeated lack of progress to the operator.

Historical `eth_call` must use historical blocks for pool, connector and Chainlink
state. Never substitute today's values. Preserve prior-block pricing and age rules.
Transport failure prevents coverage advancement; individual contract unavailability
remains explicit unpriced/unvalued data under the existing policy. Do not promise
that every historical trade will have an ETH/USD conversion.

## Aggregation and the join

Reuse the existing SQL, valuation logic, raw reader and Parquet rebuild verification.
Gather enough adjacent raw context on both sides of each publication window to
recompute every affected five-minute bucket. Context can overlap; canonical event
partitions cannot. Identify trades by the existing ordered chain event identity and
verify the resulting partition inventory has no overlapping block ownership.

At the first join, combine historical events with the original live archive for the
bucket containing the live start. Merely appending older rows leaves that bucket
partial; summing independently aggregated OHLC or volume is incorrect.

Before publishing the join, require the live worker to have progressed far enough
that its next and subsequent forward publications cannot rewrite that bucket. In
particular, the previous processed range's trailing bucket must be strictly later
than the join bucket. Derive this from committed manifests and progress, not an
elapsed-time delay. If it is not true, yield while live collection continues.
Test this invariant against the actual forward worker's context/filter algorithm.

Published backfill windows should end at bucket boundaries except for the explicit
join replacement and the requested outer edge. Select small enough windows for all
pool and market rows, manifest/partition references and progress updates to fit
DynamoDB transaction action and byte limits. The existing 90-candle cap alone does
not prove a backfill transaction fits. Count every operation and encoded payload;
reduce the next window when necessary. Large context must be handled by bounded
window selection, not unbounded archive reads or silent loss of boundary events.

## Atomic publication while live collection continues

Build and verify artifacts before acquiring the shared publication lease. Hold that
lease only for a short revalidation and transaction; do not hold it during RPC scans
or DuckDB work. Reuse the existing aggregation progress item's lease ownership and
expiry semantics, with the smallest extension needed to acquire it for backfill.
The independent job lease prevents duplicate backfill work; the shared lease
serializes publication with the forward worker.

After acquisition, re-read and validate scope, policy, manifest hashes, forward
checkpoint, expected backward frontier, and the join safety condition. If assumptions
changed, release/yield or rebuild the affected boundary; never overwrite blindly.

One transaction must:

- Write every affected pool and market row, including the join replacement if any.
- Commit the corresponding canonical historical manifest/partition references and
  job progress, preserving nonoverlapping archive ownership.
- Move `firstPublishedBucket` and `coverageFromTimestamp` backward only across the
  newly verified adjacent interval; update the reader-visible publication marker.
- Preserve live `nextBlock`, collector start/cursor, and upper publication coverage.
- Condition on current owner, unexpired lease, expected frontier, policy revision
  and captured forward state; release the publication lease on success.

Retain the existing API's continuous-interval semantics. Do not stage candle rows in
its serving partitions before the atomic visibility change. The API's before/after
progress comparison must detect every backward publication, including a join-only
replacement. Use an explicit monotonic publication revision shared by forward and
backfill writes if the current marker cannot guarantee this; settle and test the
minimal mechanism during implementation rather than relying on millisecond clock
uniqueness. Preserve the bounded reader and narrow IAM permissions.

A lost transaction response is resolved by reading durable job/frontier state; it
must not duplicate volume or regress coverage. A failed or expired publisher cannot
write after another owner advances progress. Uploaded but unreferenced artifacts
remain invisible and reusable; automatic garbage collection is not this milestone.

## Storage and operational evidence

Capture before/after measurements for raw archives, derived Parquet/evidence,
DynamoDB rows, and temporary/unreferenced outputs separately. S3 current object
bytes are distinct from versioned/billed storage; inspect versions when applicable.
DynamoDB table-size counters lag, so label estimates from bounded item reads rather
than reporting fresh zero counters as actual usage. Avoid recurring full-table scans.

The operator will inspect RPC provider usage. Also persist per-job requests by
method, response bytes, retries, captured events, blocks, windows, execution time,
and publication progress in structured receipts. Report valuation availability and
coverage, not just a successful command exit. No new dashboards, alarms, custom
metrics, or monitoring service are required.

Observed startup baseline on 2026-10-06: 7,149 raw S3 bytes and 40,510 derived bytes
across four objects; 27 DynamoDB items with approximately 21,863 bytes of item data.
This is an early snapshot, not a daily forecast or the future job's before-reading.
Refresh measurements at execution and separate concurrent live growth where possible.

## Implementation sequence and verification

1. Add pure range planning and job/checkpoint types, plus read-only preparation and
   status. Test timestamp search, bounds, stable identity and policy validation.
2. Add resumable historical collection with isolated state and immutable archives.
   Test provider range rejection, oversized responses, empty ranges, interruptions,
   duplicate runners, hash mismatch and unavailable historical state.
3. Add bounded backward aggregation and fenced atomic publication. Exercise the
   real forward worker concurrently using DynamoDB Local, native DuckDB and raw
   artifacts. Extend existing rehearsal tools rather than replacing their proof.
4. Verify the full 24-hour fixture against a single canonical rebuild through the
   production API parser/reader; document commands, assumptions and operator receipts.
5. Review correctness/consistency, simplicity, security and adversarial cases before
   proposing production execution. Record findings and fixes; no production run is
   part of this planning task.

Required failure and boundary cases:

- Mid-bucket live start; trades on both sides; exact five-minute boundaries; no-trade
  windows; multiple ranges within one bucket; long timestamp gaps.
- Forward collection advances during capture; forward publication happens before,
  during or after backfill lease acquisition; stale and expired owners are rejected.
- Kill/retry before upload, after upload, before commit and after a successful commit
  with lost response. Published results and checkpoints remain idempotent.
- One missing historical range never exposes a hole inside claimed coverage. Empty
  verified coverage remains distinguishable from missing data.
- Pool and unified market candles agree with a full raw/Parquet rebuild, including
  join-bucket OHLC, execution order, volume, conversion and custody observations.
- Historical source/metadata drift fails explicitly. No future observation prices an
  earlier trade; stale/missing valuation does not masquerade as zero USD value.
- Two-page API reads racing a backward transaction retry or return a coherent result;
  transaction action/byte and reader response limits are enforced.
- Subsequent forward runs retain older coverage and cannot regress the recomputed join.

Run focused history tests, type checking, relevant CDK assertions if permissions or
infrastructure change, and DynamoDB Local end-to-end rehearsals. Local tests do not
prove production IAM, historical provider availability, or operating cost.

## Completion criteria and later execution

Implementation is complete when a resumable fixture fill extends the same API's
coverage backward by 24 hours, matches a canonical rebuild, and survives the listed
failure/concurrency cases without changing live cursors or the launch marker.

A future authorized production exercise prepares and reviews the exact manifest,
checks historical RPC availability with a small bounded probe, records baseline
storage, runs bounded invocations to completion, and verifies authenticated pool and
market responses over the joined interval. Report exact block/time bounds, complete
versus partial coverage, unpriced volume, RPC usage and storage growth. If progress
fails, retain checkpoints and raw evidence and report the cause; do not reset live
state or present a partial backfill as complete.

## References

- [History architecture and operations](../fame-market-history.md)
- [API and unified market plan](2026-10-05-001-feat-market-history-api-plan.md)
- [Original archival plan](2026-10-03-001-feat-affordable-market-history-plan.md)
- `src/fame-market-history/{collector,storage,worker,worker-storage,api,keys}.ts`
- `src/fame-market-history/{analytics,valuation,revision}.ts`
- `scripts/market-history/{worker-rehearse,e2e}.ts`
