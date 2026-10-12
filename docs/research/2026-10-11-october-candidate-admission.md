# October candidate admission

The reviewed job `october-30d-v1` covers **October 11–November 10, 2024**, end
exclusive. It adds two direct pools to the launch Uniswap V2/V3 pools:

| Pool                 | First included Base block | Creation (UTC)       | Conversion to ETH / USDC               |
| -------------------- | ------------------------- | -------------------- | -------------------------------------- |
| Aerodrome FAME/SPX   | 21,194,336                | October 17, 15:13:39 | SPX/WETH, then WETH/USDC when needed   |
| Aerodrome FAME/cbBTC | 21,374,567                | October 21, 19:21:21 | cbBTC/USDC, then USDC/WETH when needed |

The pool identities, token order, eight-decimal quote tokens and conversion
contracts come from `2026-10-10-pool-admission-origins.json` and its verified
admission evidence. PR #58 was merged into an old parent branch rather than
`main`; this PR carries its reviewed decoder, registry and route work forward.
It does not admit the later November pools.

## Dated membership and activation (revised October 12)

PR #64 is held. Its full-history replay has been removed from the replacement.
October uses a new scope/policy only for **October 11 onward**. The immutable
candidate definition contains closed history intervals pointing to their original
scope and policy. Existing raw archives, Parquet, observations, chart pages,
activity indexes, job hashes and completed receipts stay at their original keys.
The first interval points to the retained two-pool history; later expansions append
another dated interval rather than rewriting earlier intervals.

Starting October still requires completed, unleased September and aligned source
raw/Parquet/sample/publication frontiers. Deployment never starts a job.

1. Freeze October's start at September's final sample block (the last block before
   October 11). Record the new definition with its retained-history interval.
2. Map **one** previous observation to the new policy by complete contract-call
   identity, preserving failures and provenance. This supplies opening weights.
   Unborn pools/routes are not fetched or invented. Seeding is idempotent and does
   not advance either the collection or publication cursor.
3. Atomically change only the candidate active pointer. Check the running lease,
   predecessor completion/frontiers, target definition, opening observation and
   empty target raw/Parquet/publication state. A lost response resumes from the
   pointer. The reader immediately serves retained history even before the first
   new bucket is published.
4. Collect from the frozen boundary block. This deliberately rereads two edge
   blocks already captured by September, so the new bucket has complete coverage
   and the event at its first block is included. Timestamp ownership prevents
   double counting across the two history intervals. No earlier logs are fetched.
5. Sample, aggregate and publish October normally. Its own cursors begin at
   October 11; they do not start at July 13. Keep all source data and receipts.

Chart, sampled-market, activity and availability requests use this dated catalog.
A request crossing a boundary returns one ordered result. Activity pagination and
filters retain their global read limits. Chart deltas pin the contributing
manifests with their original policies; a changed catalog resets old cursors.
The earliest-history signal continues to point to the original retained history.
Queries remain bounded to 24 hours, 288 buckets, eight intersecting membership
intervals, and the existing byte/time budgets. There is no historical-copy phase,
new paid monitoring or daily cutoff. Legacy execution-only `market`/`pool` views
remain scoped to their own dataset; the comprehensive contract is `chart`,
`sampled-market`, `activity` and `availability`.

Adding a future pool at a future membership boundary requires only new data from
that boundary. Adding a previously omitted pool retrospectively still requires
collecting its missing events and rebuilding the **affected** interval; dated
membership cannot manufacture missing history. Raw capture remains batched by
scope for efficient RPC reads, but a logical market history can reference many
such immutable batches without copying them.

## Lifecycle and pricing assumptions

- Pool logs at the creation block are included. Shared range boundaries remain
  inclusive/exclusive exactly as in previous chunks; no whole creation bucket is
  discarded.
- Direct state and conversion routes are sampled only after the direct pool
  exists. Busy conversion pools are never scanned for logs or liquidity ticks.
  The sampler still uses one block-pinned Multicall per five-minute bucket.
- Unborn pools do not contribute missing prices, inventory or volume to the
  market. Individual chart requests return `published`, `reason: not-yet-created`,
  null price/candle, and known zero volume/inventory/trade count. Missing existing
  pool state or conversion remains an explicit gap, never a zero price.
- The index keeps its existing opening-FAME-balance weights. A pool born during a
  bucket has a known opening weight of zero and enters index weighting in the next
  bucket. Its trades and inventory enter totals immediately. Its individual candle
  has no invented pre-launch open; an event-derived first candle is partial.
- ETH/USDC conversions remain **bucket-end spot rates**, not execution-time FX.
  Native events and amounts are retained for future revaluation. Quote failures
  retain native activity with unavailable converted size.
- The public production dataset and IAM permissions are unchanged. The private
  reader recognizes reviewed new pool IDs during syntax validation, then enforces
  membership in the active dataset before reading them.

## Operator release sequence

1. Merge this PR after CI passes.
2. Run **History candidate** on `main`. Do not run the production **Market history**
   deployment. Verify the candidate worker and reader deployment succeeded.
3. Let August finish, verify its retained coverage, then explicitly start and
   verify September. Deployment preserves their job identities and progress.
4. Verify the two historical admission-day receipts below. Then explicitly start:

```sh
yarn nodets scripts/market-history/candidate-control.ts status fls-power october-30d-v1
yarn nodets scripts/market-history/candidate-control.ts start fls-power october-30d-v1
# same job argument for pause/resume/status
```

`query` uses the candidate's active dataset. After activation it reads the old
corpus in place. Verify July history and the October seam in both
currencies, then each pool's creation bucket and following day, native event
identity/counts, volume, and quiet prices. API cursors tied to the old policy reset
when the candidate pointer changes. Production promotion remains separate work;
this PR has no production promotion command.

## Validation

- Unit tests cover exact origins, active calls at each boundary, unchanged old
  job identity, pre-admission price/volume equivalence, unborn chart responses,
  opening-zero weights, invalid membership boundaries, cross-boundary chart deltas,
  activity pagination/filters, cursor policy tampering and earliest-history signals.
- `candidate-rehearse.ts` uses real DynamoDB Local and DuckDB with deterministic
  chain evidence and in-memory S3. It collects/publishes 297 samples, appends a
  dated definition, captures two new buckets through the actual adapters, and
  queries chart/activity APIs in ETH/USDC. It verifies old database rows and object
  checksums are unchanged, and exercises lost upload
  responses, resume, lease ownership, pause and incomplete-activation rejection.
  The month-frontier activation test seeds checkpoints explicitly; it is a
  transaction test, not proof of a locally replayed 90-day corpus.
- `october-admission-rehearse.ts` performs read-only RPC capture of the creation
  bucket plus 24 hours for each admitted pool, retaining raw logs, samples and
  ETH/USDC responses locally. It has no AWS storage clients. Provider-backed
  results are recorded in [the receipt](2026-10-11-october-admission-receipt.json).
- Candidate CDK tests verify physically separate storage and no production
  permissions. The Linux runtime packaging check imports the bundled handler and
  executes DuckDB independently of macOS native bindings.

October collection on AWS has not run as part of this fix. Merge and deploy the
replacement first; then explicitly resume/start reviewed chunks. There is no
90-day staging step. Production collection, storage and active pointer are unchanged.

Provider-backed proof completed locally: each admitted pool has 288/288 prices and
candles in both ETH and USDC. The SPX day contains 95 swaps / 96 activity events;
the cbBTC day contains 7 swaps / 9 events. Combined capture/sampling used 2,999 RPC
requests and 32,882,083 response bytes in about 218 seconds. Offline native rebuild
then verified exact Parquet round trips with zero unknown events or invalid trades.
These are admission-day measurements, not a promise of October-wide coverage or
provider billing units. No production writes or candidate activation occurred.
