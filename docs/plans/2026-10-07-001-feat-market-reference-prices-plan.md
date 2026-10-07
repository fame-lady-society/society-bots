---
title: "feat: Persist bucket-aligned ETH and FAME reference prices"
type: feat
status: implemented-local
date: 2026-10-07
---

# Bucket-aligned market reference prices

## Goal

Extend `society-bots` market history with on-chain reference prices for every
five-minute bucket, including buckets with no FAME trades. Consumers can chart
FAME repricing between executions as ETH and USDC markets move on Base.

Record FAME/ETH, ETH/USD, ETH/USDC, FAME/USD and FAME/USDC. USD and USDC are distinct
units: never assume one USDC equals one dollar. Preserve execution OHLCV and its
meaning. A reference observation is a sampled point, not a fabricated trade candle.

Implementation is locally validated, pending review and deployment. No historical
refill or production writes have been performed. The separate backward-backfill
plan remains a separate workstream.

## Current foundation

The existing collector already archives two valuation observations per collected
range: at the preceding block and final collected block. `valuation-rpc.ts` batches
FAME pool states, connector prices, token identity/decimals, balances and the
Chainlink ETH/USD round in one Multicall per observation. The current registry
produces roughly 51 subcalls per full valuation batch.

`valuation.ts` uses these observations to convert actual executions and value pool
balances. When no trades occur, converted OHLC stays null. Observation blocks follow
collector ranges rather than exact five-minute boundaries. The API serves bounded,
precomputed DynamoDB results; requests perform no RPC or aggregation.

Reuse the RPC transport, pinned-block reads, exact integer math, raw archive,
Parquet evidence, worker and API validation patterns. Do not add another scheduler,
chain indexer, chart-request RPC path, or daily spending cutoff.

## Price policy: explicit initial reference

Proposed initial reference uses existing registered sources:

| Series | Definition/source |
|---|---|
| FAME/ETH | Marginal spot price from `scale-equalizer-weth-fame` |
| ETH/USD | Existing Base Chainlink ETH/USD feed at the sampled block |
| ETH/USDC | Marginal spot price from `uniswap-v3-usdc-weth-5bps`, correctly oriented |
| FAME/USD | FAME/ETH multiplied by ETH/USD at the same block |
| FAME/USDC | FAME/ETH multiplied by ETH/USDC at the same block |

Treat WETH as the ETH unit for these pool-derived prices. All prices are per one
whole asset, with explicit base and quote units and decimal-string serialization.
Reuse the correct reserve invariant, token ordering and decimals rather than a
symbol-based reserve ratio. The WETH/USDC CL source needs slot0 and positive active
liquidity; this feature does not require enumerating ticks or simulating execution.

This designated-pool reference is intentionally a different series from the
multi-pool execution candles. Expose its pool ID and method to consumers. Do not
label it an all-venue consensus, TWAP, executable quote, or oracle. Before adopting
the source, review its current liquidity, recent divergence from other tracked
FAME pools and manipulation sensitivity using bounded read-only evidence. Record
the choice and test it. If unsuitable, revise the documented policy before
implementation; do not silently switch pools at runtime.

No automatic fallback or new cross-pool weighting algorithm in this increment.
An unavailable designated source produces an unavailable dependent price. Other
independent prices can still be present. Changing sources later requires an explicit
policy revision and an honest boundary in historical provenance.

The dollar series inherits the oracle's update cadence. A new block read does not
force a fresh oracle round. The USDC series reflects its pool's changing spot rate,
including movements relative to ETH that the USD oracle may not yet reflect.

## Bucket and finality semantics

For bucket `[T, T+300)`, select the last canonical block with timestamp strictly less
than `T+300`, after that boundary can be resolved from finalized chain data. Prove
selection with the next block's timestamp at or beyond the boundary. Save both the
observation block identity and boundary evidence. Do not substitute execution time,
current head, or a later block for the requested bucket.

Resolve blocks with bounded header search using known adjacent ranges; reuse/cache
headers across buckets. Never assume a fixed block interval. When catching up or
backfilling, enumerate every elapsed five-minute boundary rather than only the last
one. Persist progress so small collector ranges cannot strand a boundary between
runs. Exactly one canonical reference observation belongs to each bucket/policy.

The last block before a boundary may be old during a chain gap. Apply the existing
1,800-second maximum observation-age bound initially, with separate freshness
validation for the oracle round. Missing/too-old evidence is explicit unavailable
coverage, not carried-forward pricing. Samples can repeat legitimately when valid
on-chain state or oracle rounds are unchanged; retain their actual source times.

Reference prices remain finalized history and therefore trail wall-clock time.
This plan does not promise an instant/latest-head ticker or sub-five-minute OHLC.
Show covered chain time separately from collection/publication time. Unclosed or
not-yet-finalized buckets return pending/unavailable reference status.

## Collection, storage and resumability

Integrate boundary work into the existing bounded collector invocation. Preserve
its forward event cursor and launch marker. Add a separate persisted reference
frontier so a quote-read failure cannot permanently skip a bucket or corrupt event
coverage. Event collection may continue while the reference frontier retries;
expose the two progress states separately.

Prefer one deduplicated Multicall per selected block. Reuse an existing boundary
valuation when its block and source fields exactly match. Otherwise perform a
compact reference batch for the two pool states, validity checks and oracle round.
Do not repeat balance reads or unrelated routes just for these reference points.
Reuse reviewed static metadata only with its existing identity/version validation;
do not remove safety checks merely to meet a request-count target.

The existing full valuation archive stores derived quote-to-ETH values but not all
connector pool evidence. Extend the new reference evidence to retain the actual
pool state/results, token metadata identity, oracle round/updatedAt, block/hash,
policy revision and boundary evidence needed for a deterministic rebuild. Computing
ETH/USDC by inverting an already rounded route value is not an acceptable substitute
for preserving and correctly orienting its source state.

Archive immutable reference evidence in S3 and include it in Parquet/evidence
rebuilds. Put reference job/manifests and serving rows in their own key namespaces
in the existing table, keyed by scope, bucket and policy where appropriate.
Conditional writes, hash verification and an atomic reference-progress commit must
make upload retries and lost transaction responses idempotent. Do not overwrite an
existing published bucket with different evidence without an explicit repair path.

RPC transport/provider failures retain retryable progress. Contract reverts, zero
liquidity or stale oracle data become documented source-unavailable outcomes when
confirmed at the selected block. Never translate an outer RPC failure into a
successfully sampled empty price. Existing per-run limits yield durable progress;
provider usage and failure reasons remain observable in structured logs.

## Aggregation and publication

Derive reference values using integer arithmetic with the existing precision and
rounding conventions. A failed ETH/USD source must not suppress valid ETH/USDC or
FAME/ETH; a failed FAME source must not suppress valid ETH prices. Record per-series
availability and reasons, not one ambiguous overall success bit.

The worker publishes reference rows and a reference publication marker atomically.
Do not rewrite hundreds of execution candles merely to add a reference field.
Keep the reference policy/revision separate from the execution metadata revision:
adding this series must not invalidate the deployed trade archive or require a
full trade-history rebuild. Existing archives remain evidence for their actual
policy; never relabel approximate range observations as exact bucket samples.

The boundary sampler and rebuild operate even when the event range is empty. The
same reference evidence must produce identical results from raw and Parquet-only
inputs. A worker crash leaves immutable artifacts retryable and invisible until
its publication transaction succeeds.

## Consumer contract: always available in market responses

Decision: include a `reference` envelope for every bucket in `view=market`, without
an opt-in query parameter. Consumers choose whether to plot it; the backend stores
it regardless of usage. Keep current execution `prices`, `tradeCount` and volume
semantics unchanged. Pool-view changes are out of scope.

Proposed shape (final schema validated in implementation):

```ts
reference: {
  method: 'designated-pool-spot-with-asof-fx';
  policyRevision: string | null;
  sampledBlock: number | null;
  sampledBlockHash: string | null;
  sampledAt: number | null; // Unix seconds
  values: {
    fameEth: ReferenceValue;
    ethUsd: ReferenceValue;
    ethUsdc: ReferenceValue;
    fameUsd: ReferenceValue;
    fameUsdc: ReferenceValue;
  };
}
// Decimal string in quote units per one whole base asset.
type ReferenceValue = {
  value: string | null;
  status: 'available' | 'unavailable';
  reason: string | null;
};
```

Use a closed reason enum in the implementation, including not-yet-published,
before-reference-start, stale-source and source-unavailable. Response-level policy
metadata supplies exact pools/feed, units and oracle freshness rules; bucket-level
oracle round and update time supply provenance for USD values. Persist source-state
evidence in archives rather than inflating every API bucket with all raw calls.

Add reference start/through timestamps and a monotonic reference publication
revision to response progress. The reader performs bounded reference queries in
addition to its execution reads and includes reference progress in its consistent
snapshot/recheck. Reject malformed/missing rows inside claimed reference coverage.
Outside it, construct an explicit unavailable envelope; do not reinterpret that as
missing trade coverage. Preserve valid execution history when references have not
started yet, and valid reference points when no executions occurred.

Keep the existing maximum 288-bucket window and overall 2 MiB response ceiling.
Measure total query pages, response bytes and latency for a full market response
with both series. Update bounded page/read limits only with evidence; avoid
per-bucket GetItem calls, extra round trips for static metadata, and server-side
RPC. Include transaction-read IAM assertions if the snapshot keys change.

Website consumers can plot FAME/USD or FAME/USDC reference lines across quiet
periods, with FAME/ETH and ETH reference data available for comparison. Currency
labels must distinguish USD and USDC. Do not synthesize trade candles or trading
volume from reference movement. A price change due solely to ETH/USDC can coexist
with zero FAME executions.

## Rollout and old buckets

Begin guaranteed boundary sampling at an explicitly recorded aligned activation
boundary. All subsequent closed finalized buckets receive either values or an
explicit source-unavailable result; transport errors stay pending until resolved.

Older buckets return before-reference-start until a separately authorized reference
refill samples their exact historical blocks. That refill uses its own progress and
does not reset live trade cursors. The planned backward event fill should call the
same boundary sampler so a newly filled day includes reference evidence in the
same operation. Exact historical pricing cannot be promised from existing sparse
range observations alone.

Deploy through the existing history CI workflow after tests and review. Verify the
API throughout rollout against already published rows, new reference rows and
independent frontier lag. No migration that erases or re-labels existing records,
feature flag, monitoring service, or production execution is part of this plan.

## Performance and cost acceptance

There are 288 five-minute boundaries per day. A compact Multicall at every boundary
is at most 288 planned reference eth_call requests/day before overlap reuse,
retries, and block-header discovery. It is not a total system request forecast.
Current collection already performs two full valuation batches per range; measure
incremental cost rather than counting the whole existing pipeline again.

Reusing the existing batch at the same block costs no extra eth_call. Other sampled
blocks add a compact call; block lookup also adds requests and must be counted.
Provider billing can depend on execution/computation and historical access, not
just HTTP request count. Do not promise a dollar figure from request counts alone.

Measure a one-day rehearsal: calls by method, subcalls, bytes, retries, header-cache
reuse, collection/worker duration and peak memory, S3 growth, serving-row growth,
DynamoDB read/write consumption and full API payload/latency. Compare with the
current collector on the same range. The operator checks provider billing/usage.
No paid alarms, dashboards, custom metrics or hard daily cutoff are added.

## Tests, review and implementation order

1. Freeze source and unit policy; add boundary resolver and arithmetic tests.
2. Implement deduplicated reference reads, immutable evidence and resumable
   frontier. Reuse existing primitives with focused modules, not a generic engine.
3. Add raw/Parquet derivation, atomic reference publication and consistent API reads.
4. Rehearse one day locally/emulated; document measured incremental work. Update
   the chart handoff with the finalized reference contract after implementation.
5. Review source selection, correctness, security, cost and concurrency assumptions
   before proposing a supervised production rollout.

Required tests include: zero FAME trades while ETH/USDC changes; unchanged FAME/ETH
with changing converted FAME prices; USDC/USD divergence without a $1 assumption;
reversed token order and six/eighteen decimals; reserve invariant and CL validity;
stale or failed oracle with healthy USDC pricing; failed FAME source with healthy
ETH pricing; partial activation bucket; exact timestamp boundary; chain gaps;
catch-up across multiple buckets/ranges; no future block leakage; archived policy
mismatch; crash/retry/lost-response idempotency; concurrent publishers and readers;
old execution rows with no reference evidence; 288-bucket query/payload limits;
and raw-versus-Parquet rebuild equivalence.

Success: every bucket since activation has explainable reference coverage,
independent of FAME trading, and consumers receive correctly labeled FAME and ETH
prices in USD and USDC without per-request on-chain work. Trade history remains
intact, reproducible, and semantically unchanged.

## References

- [Market history implementation and operations](../fame-market-history.md)
- [Chart handoff](../handoffs/2026-10-07-fls-www-market-chart.md)
- [Backward-backfill plan](2026-10-06-001-feat-market-history-backfill-plan.md)
- `src/fame-market-history/{collector,valuation-rpc,valuation,analytics,worker,worker-storage,api}.ts`
- `src/fame-swap-pool-state/registry/` and existing source identities


## Implementation receipt (2026-10-07)

The existing collector and worker now execute independent bounded reference work.
A create-once DynamoDB cursor records the first full bucket after activation;
collection and publication each advance through at most four buckets per run.
Failed runs resume from committed progress. The original execution checkpoints,
schedulers, IAM scopes, infrastructure sizes, and history rows are unchanged.

Every sample uses one compact Multicall with 12 unique contract reads, plus bounded
cached header search and canonical-boundary verification. The two full existing
valuation batches remain independent: this increment does not share their transient
results across lanes. This adds up to 288 reference eth_call requests per day before
retries, plus headers. It avoids coupling price progress to execution range sizes;
identical-block reuse is an unimplemented optimization, not a claimed saving.
The 96-request reference bound is per invocation and resumable, not a daily cutoff.

Raw JSON and ZSTD Parquet contain the source policy, addresses, block/successor
proof, and exact ABI results. Each Parquet file currently contains one JSON evidence
record, not flattened analytics columns. Derivation runs locally without RPC;
publication is atomic with the independent reference frontier. The market API
always includes a reference envelope and source policy. Pool responses are unchanged.

Read-only qualification at Base block 52309326 (timestamp 1791407999) returned:

- FAME/ETH: 0.000000086160353298 from the designated WETH pair.
- ETH/USD: 2570.2828; ETH/USDC: 2571.308586365055646285.
- FAME/USD: 0.000221456474123772; FAME/USDC: 0.000221544856239394.
- The designated pair held about 7.38 WETH and 85.66 million FAME; its FAME/ETH
  price differed by about 0.47% from the other direct WETH pair. All five tracked
  pool prices spanned about 2.7% at this block. This is one observation, not a
  longitudinal manipulation/divergence study. Pool spot remains manipulable and
  is appropriate as a labeled chart reference, not a trusted settlement oracle.
- The complete qualification used 15 requests (one chain ID, 12 headers, two
  eth_call) and 155,934 response bytes; the compact sample was one of those calls.
  This is not a production daily cost measurement.

Validation: 138 focused tests passed, root TypeScript passed, four deployment tests
and deployment TypeScript passed. Real DynamoDB Local transactions exercised
competing collectors, failed uploads, lost successful responses, and stale
publishers. A 288-bucket HTTP response used three query pages and 1,551,836 bytes,
below 2 MiB. Offline Linux x86_64 Lambda execution passed with the existing and
reference Parquet proofs concurrently at 512 MiB, one CPU, and no network; the
reference fixture Parquet was 1,835 bytes. The fixture is not a production storage
forecast or worst-case memory/load proof.

Before declaring production acceptance: deploy through the existing CI workflow,
observe several closed buckets advancing in both frontiers, verify API values and
missing states, and inspect ordinary structured logs plus provider usage. A full
provider-backed one-day incremental cost/storage/latency comparison remains open;
the 288-bucket rehearsal is deterministic/emulated. No paid monitoring, automatic
source switching, historical refill, or repair writer was added.


Local review tightened Solidly ABI widths, source-policy provenance, cursor
validation, no-skipped-bucket commits, invalid/empty CL state handling, and API
retry behavior when only reference publication advances. An external Grok review
was attempted but returned no findings/output after roughly eight minutes and was
stopped. Do not count that attempt as completed independent review. Independent
review remains a pre-deployment acceptance item.
