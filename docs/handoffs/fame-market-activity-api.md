# FAME market activity feed

The backend exposes one row per decoded swap or liquidity principal change across the tracked direct FAME pools. Multiple rows may link to the same transaction. This is an event feed, not a deduplicated transaction list or an account trade history.

## Request

Use the existing server-side bearer token and `GET /fame/history`:

```text
?view=activity&currency=USDC&resolution=300&from=<aligned-start>&to=<aligned-end>&type=all&limit=50
```

- `currency`: `ETH` or `USDC`. USDC is the on-chain dollar-denominated quote; do not label it oracle USD.
- `from`, `to`: Unix seconds, five-minute aligned, half-open interval, at most 24 hours; `to` must be a closed bucket boundary. Availability follows the chart's rolling published window.
- `type`: `all` (default), `buy`, `sell`, `add`, `remove`.
- `pool`: optional registry pool ID; omit for the comprehensive market feed.
- `min`, `max`: optional inclusive event-size bounds in the selected currency. Nonnegative decimal strings, up to 18 fractional places. No floats/exponents. Missing prices do not pass a size filter, including `min=0`.
- `limit`: 1–100, default 50.
- `cursor`: opaque `nextCursor` from the previous response. Keep all other request parameters unchanged.

No frontend changes are included in this backend PR. Keep the token on the frontend server. The existing gateway authentication and API read permissions apply. Gzip is supported; responses are private/no-store at the origin.

## Response and rendering

Rows are in descending chain order (block number, log index). Each has:

- `id`: chain ID, block hash and log index; use as the row key. Do not deduplicate by transaction hash.
- `poolId`, `type`, `eventName`, `timestamp`, `blockNumber`, `transactionIndex`, `logIndex`, `transactionHash`.
- `fameAtoms`, `fameDecimals`, `quoteToken`, `quoteAtoms`, `quoteDecimals`: exact native amounts. Quantities are unsigned; `type` describes direction.
- `size`: decimal string or null in the requested currency.
- `sender`, `recipient`, `owner`: decoded event fields when present, otherwise null. They may identify a router/position contract; do not label these as the ultimate trader or wallet owner.
- `valuationTimestamp`: nominal end of the five-minute bucket.

Link each row's transaction hash to the Base explorer. Buy means FAME left the pool; sell means FAME entered it. Mint means liquidity add; Burn means liquidity remove. Single-sided concentrated-liquidity changes are supported. Zero-liquidity Burns, Sync, Initialize, Collect and fee events do not create additional add/remove rows. Burn records principal removal; later Collect can transfer owed principal and fees and is deliberately not counted again. This does not capture liquidity-position ownership transfers, wallet transfers, gas costs or swap routes as a single user action.

`nextCursor` is null only when the scan has ended. A bounded scan may return fewer than `limit` rows, **including zero rows with a non-null cursor**. Continue loading with that cursor; do not interpret an empty page as the end. Limit automated traversal per user action and allow Load more for sparse filters.

Pagination pins immutable chart/event data to the original `publicationId`, including while live publication or historical chart repair occurs. Retained generations expire after 24 hours from supersession. A changed query/policy, expired manifest or incompatible cursor returns HTTP 409 `cursor-reset-required`; restart without a cursor. A new first-page request sees the latest publication. For refresh, fetch a fresh first page with a new window, reset its older-page cursor, and replace that result set; this endpoint is not an incremental chart-delta endpoint. Poll in step with chart publication rather than each render.

`coverage.unavailableBuckets` names unindexed buckets encountered on this page; `partialBuckets` identifies incomplete archive coverage. `outsidePublishedWindow` and `notYetPublished` flag unavailable edges. Coverage is scan-local, not a guarantee about the entire day. `scanned` reports index reads, chunks, examined events and unpriced matching events encountered; it is not a total result count. Missing prices remain null and must not be rendered as zero.

## Valuation and accuracy

Native event amounts come from verified, deduplicated pool logs. Swaps use the actual quote leg once; liquidity size is the sum of both token legs, with FAME valued at that pool's bucket-end spot price. Both use the same historical bucket-end conversion routes as the chart. The response declares `valuationMethod: bucket-end-spot`.

These are **sampled conversions**, not execution-time USD oracle values. They preserve the approved cheap approach: no extra chain calls or busy conversion-pool log indexing. Missing marks/routes produce null sizes. A quiet FAME/WETH pool can still have ETH sizes without a USDC route. Existing decoder family review remains provisional; unknown/invalid events make coverage partial instead of silently declaring completeness.

## Storage, indexing and rollout

The publisher decodes the existing archive once and reuses that result for candles and activity. It writes immutable chunks of at most 100 events, then a bucket index keyed by both chart-page hashes and the activity version. Only then does it activate the chart publication. Writes are idempotent, chunk concurrency is four, and failures leave the publication retryable. An activity indexing failure can delay publication; it never skips the bucket or advances the collector. New collector RPC behavior is unchanged.

Readers access only the existing DynamoDB table: one current manifest (plus one retained manifest for an older cursor), one batch of at most 16 bucket indexes, and at most eight chunks / 1 MiB of chunk data. Reads are strongly consistent, checksum verified, deadline bounded, and retry only unprocessed batch keys. Chunk metadata skips irrelevant event types and chunks below the minimum size. No scans, S3 reads, new database/index, alarms, service or RPC dependency is added to the request path.

Existing chart data and execution OHLC/volume are preserved. Old buckets initially report `activity-not-indexed`; materialize their sidecars from the archives. The command defaults to **read-only**:

```sh
AWS_PROFILE=fls-power AWS_REGION=us-west-1 \
FAME_HISTORY_TABLE='<existing-history-table>' \
FAME_HISTORY_BUCKET='<existing-history-bucket>' \
yarn nodets scripts/market-history/index-activity.ts /tmp/activity-proof
```

Optional `FAME_ACTIVITY_FROM`/`FAME_ACTIVITY_TO` narrow the range within the pinned published window. Inspect the receipt, then run the same command with `--apply` to write only activity chunks/indexes. It does not change observations, charts, live cursors, collector checkpoints or manifests, and uses zero RPC calls. Interrupted writes are safe to rerun. Buckets that fall out of the rolling window during a long run can leave harmless unused immutable indexes. Indexes/chunks follow the existing immutable serving-page retention model (no new TTL); raw archives remain the rebuilding source. Bump the activity version when changing interpretation/valuation semantics.

Deploy through the existing CI workflow after operator merge. New publications produce activity automatically; run the historical sidecar materializer, then verify both currencies, all event types present in the receipt, inclusive size bounds and cursor traversal through the authenticated API. No historical chain backfill is required for already archived ranges.

## Validation evidence (2026-10-08)

A read-only production-archive rehearsal covered `[1791357000, 1791443400)` (288 buckets). All buckets had complete archive coverage. It found 24 swaps: 12 buys and 12 sells, all priced in both ETH and USDC. There were no liquidity additions/removals in this particular window; those paths were exercised with actual ABI-encoded fixtures for every supported venue and both token orientations.

Materialization would create 288 index items plus 12 event chunks, totaling 58,856 bytes of JSON bodies (excluding DynamoDB keys/overhead). These are observed sizes, not a provider billing estimate. The read-only replay took about two minutes locally and made no RPC calls or AWS writes. New steady-state publication adds one small index write per five-minute bucket plus chunks only when events exist; no additional chain collection is required.

DynamoDB Local exercised forward publication, lost responses, immutable chunk writes, idempotent sidecar indexing, historical imports, revisions and cursor pagination while preserving chart and collector state. S3 was simulated in that rehearsal. Production archive decoding was tested separately above; authenticated activity HTTP serving remains a post-deploy check.
