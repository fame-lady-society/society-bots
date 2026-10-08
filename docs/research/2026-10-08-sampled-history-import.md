# Sampled market history import

## Scope

PR #45 deployed forward collection/publication successfully. The saved local
rebuild ended at 2026-10-08 01:15 UTC, two hours before production's 03:15 UTC
start. This change fills that bridge locally and adds an operator-run historical
prepend using the existing API contract. No Lambda deployment is required before
import. Operator merge and production-write authorization remain pending; no
production data was changed during preparation.

## Prepared evidence

Ignored local job `.market-history-local/sampled-import-day-v1` covers
2026-10-07 03:15 UTC through 2026-10-08 03:15 UTC, exclusive:
`[1791342900,1791429300)`. A remote operator must transfer or recreate this local
evidence before running it.

- Reused 264 observations; fetched 24 with the pinned-block sampler. Incremental
  RPC: 231 requests, 3,234,152 response bytes (1 chain ID, 206 headers, 24 Multicalls).
- 219 checksummed native archives, 790,065 compressed bytes; 288 observations,
  48 local hourly pages, 56,723-byte Parquet archive.
- All 1,440 native pool/bucket comparisons matched production: 23 executions,
  288 complete event buckets. All 1,440 prices available in each currency;
  1,421 quiet pool/buckets priced in ETH.
- Read-only import preparation regenerated native activity from production
  archives and produced plan ID
  `9ce91486af0f8c90f23a21e597f5d6a2f1747272ab0f1662fe88e4a2b50ad36c`.

Public API probes returned three published buckets at 03:15, 03:20 and 03:25 UTC
in ETH and USDC. All 15 quiet pool/buckets had prices in each currency. That
proves forward progress from the reported two buckets, not historical import.

## Operator procedure

Use Node 24. Import itself needs no RPC secret and reads committed native archives
rather than trusting local serving-page trade totals.

```sh
export AWS_PROFILE=fls-power AWS_REGION=us-west-1
export FAME_HISTORY_TABLE=FameMarketHistory-HistoryD990305F-18XHQL85466VU
export FAME_HISTORY_BUCKET=famemarkethistory-historyarchive4304ea9e-dmwohucmgmln
yarn nodets scripts/market-history/import-sampled-history.ts \
  .market-history-local/sampled-import-day-v1
```

Default mode is read-only. After authorization, repeat with `--apply <planId>`
using the reviewed preparation result. Changed job/observation/bucket content
changes that ID and rejects application before any S3 write. For a new local
rebuild, `FAME_HISTORY_TO` pins an aligned exclusive end; the job remains one day
and immutable on resume.

The importer walks backwards from the current published start and retains the
newest 288 buckets. As live data grows, fewer old buckets are imported. A full
window is a no-op. Every resume prepares the entire frozen job to verify the same
approved plan.

After import, query both currencies ending at the returned `publishedThrough`:
expect 288 published buckets, quiet prices and unchanged native amounts. Also
query the wall-clock window; newest buckets can still await normal publication.

## Correctness and failure behavior

- Raw observations are create-only S3 objects, verified by SHA-256 and size.
- One DynamoDB transaction inserts the observation manifest, both immutable
  currency pages, publication manifest and separate
  `sampled:<policy>/import:<planId>` progress receipt.
- The transaction requires the prior publication generation and a timestamp
  before the live collector's initial start. It never changes the collected
  cursor, execution OHLC/volume or legacy API rows.
- Only the immediately preceding bucket can be added. Publication stays
  contiguous, forward `nextTimestamp` is unchanged, and live page references
  remain identical.
- Concurrent appends/imports cannot overwrite each other's generations. The CLI
  rereads changed generations after failures, retrying up to five conflicts.
  Other failures stop with completed work retained. A lost successful response
  resumes from the durable publication start.
- Native amounts use the live archive decoder. Missing/reverted price calls
  retain null coverage, partial native coverage remains partial, and no prices
  are invented.
- This initial fill does not overwrite/repair existing history. Conflicting
  observations fail closed. Policy changes need a reviewed rebuild. Failed
  transactions may leave unreferenced S3 objects, never visible API pages.

## Verification and challenged assumptions

175 history/script tests and TypeScript checking passed. DynamoDB Local with
checksummed simulated S3 verified competing imports, unchanged live cursor, both
directions of live/import publication races, no observation after a failed
transaction, retained native totals, and 288-bucket readers in both currencies.
The full worker rehearsal passed.

The old rebuild was not assumed contiguous with deployment: the bridge was
measured and rebuilt. Import does not assume live collection pauses or trust
precomputed local volume. Local tests and read-only production preparation are
separate from the still-pending production write and post-import verification.
