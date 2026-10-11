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

## Generation staging and activation

October has a distinct scope and price-policy revision. The deployed first three
job hashes, completed receipts, and two-pool policy remain unchanged. Deployment
never starts a job. Starting October requires completed, unleased September,
aligned raw/Parquet/sample/publication frontiers and the expected old candidate
active pointer.

After start, the worker first rebuilds July 13–October 11 into the new generation:

1. Validate each retained source archive and copy its native events and headers
   to a new scope, with source checksum lineage. No RPC log scan occurs: the new
   direct pools did not exist anywhere in this interval. Archive reuse refuses
   a range crossing either pool's creation block. Source storage keys are not
   copied into new manifests.
2. Run the existing bounded DuckDB/Parquet pipeline on the staged archives.
3. Remap retained sampled contract responses by full call identity. Preserve
   failures and block anchors; unsampled future pools/routes remain unavailable.
   No price is interpolated or fetched from a later block. Each reused sample
   records its source policy and evidence checksum.
4. Compare both currencies' market, pool series and totals against the source
   evidence before committing. Publish dated chart pages and activity indexes
   under the new policy. The private reader continues serving the old generation.
5. Atomically switch **only the candidate** active pointer after source and target
   frontiers align at October 11. The transaction also checks the unleased completed
   predecessor, current running job lease and target definition. A lost activation
   response is recovered by reading the active pointer on the next invocation.
6. Continue ordinary bounded collection from the retained edge block plus one,
   sampling and publishing through November 10. The October opening bucket uses
   the staged prior sample. Keep old objects, dataset definitions and receipts.

Replay is resumable using separate target raw, Parquet, collected and published
cursors, at most 2,048 steps per invocation plus the existing remaining-time and
lease checks. Collection retains its 256-step bound and existing RPC/byte limits.
Pause/resume works throughout; no daily spending cutoff exists. The replay uses
S3/DynamoDB/Lambda work and therefore is not free, despite requiring no new RPC
reads. There are 25,920 old five-minute buckets to republish. Its wall time depends
on actual AWS request latency and the five-minute worker schedule; do not reuse the
six-hour RPC ingestion estimate for this extra staging phase. Job counters remain
observed RPC requests/bytes, not billing credits or an AWS cost estimate.

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

`query` uses the candidate's active dataset. During staging it still exposes the
old corpus. After activation, verify July history and the October seam in both
currencies, then each pool's creation bucket and following day, native event
identity/counts, volume, and quiet prices. API cursors tied to the old policy reset
when the candidate pointer changes. Production promotion remains separate work;
this PR has no production promotion command.

## Validation

- Unit tests cover exact origins, active calls at each boundary, unchanged old
  job identity, pre-admission price/volume equivalence, unborn chart responses,
  opening-zero weights, corrupt/overlapping archives and storage-key stripping.
- `candidate-rehearse.ts` uses real DynamoDB Local and DuckDB with deterministic
  chain evidence and in-memory S3. It collects/publishes 297 samples, stages them
  through the actual adapters, queries dated chart/activity APIs in ETH/USDC,
  verifies source receipts/cursors are unchanged, and exercises lost upload
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

The full AWS 90-day staging and October collection are deliberately not run as
part of local validation. Those remain post-deployment candidate verification.

Provider-backed proof completed locally: each admitted pool has 288/288 prices and
candles in both ETH and USDC. The SPX day contains 95 swaps / 96 activity events;
the cbBTC day contains 7 swaps / 9 events. Combined capture/sampling used 2,999 RPC
requests and 32,882,083 response bytes in about 218 seconds. Offline native rebuild
then verified exact Parquet round trips with zero unknown events or invalid trades.
These are admission-day measurements, not a promise of October-wide coverage or
provider billing units. No production writes or candidate activation occurred.
