# Serving retained FAME history

Historical serving is independent of genesis ingestion and pool admission (#52).
This change reads retained data for the current sampled policy. It adds no RPC
collection, contracts, scheduler, infrastructure, alarms, or pool activation.
Deploy it independently from `main`.

## API contract

`GET /fame/history?view=chart&currency=ETH&series=market&resolution=300&from=...&to=...`

The same route supports `currency=USDC`, individual pool series, `view=activity`
with the existing size/type filters and pagination, and `view=sampled-market`.
Callers choose any older aligned interval. Each request still covers at most
24 hours / 288 five-minute buckets. Fetch adjacent intervals to traverse more
history; this does not create a multi-year single response. No frontend changes
are included here.

The newest window keeps its existing one-publication-read fast path. An older
request reads at most two UTC-day directories and, at the live boundary, joins
the current publication. The live publication owns overlapping timestamps.
Immutable page checksums, compression, ETags, response limits and read deadlines
are retained. An unchanged historical chart needs no chart-page reads for a
304 response or empty cursor delta. Its ETag does not change with unrelated live
updates.

Missing observations and unmaterialized buckets remain explicit gaps; no RPC
lookup or fabricated zero is performed by the API. The existing gap value
`outside-published-window` also describes holes in dated history. Activity adds
`coverage.unavailableBuckets` entries with `reason: not-published` for these holes.
A window's `publishedThroughTimestamp` is its publication horizon, not a promise
that all earlier timestamps exist: consult individual bucket coverage.

## Storage and concurrency

- `sampled:<revision> / day:<UTC-midnight-seconds>` contains up to 288 sparse
  references to existing ETH/USDC chart pages. These directory records and
  immutable chart/activity pages have **no TTL**.
- `day-manifest:<generation>` retains immutable directory snapshots for cursor
  reconstruction. Both old and new generations receive a 24-hour TTL when
  superseded. Expired cursors require a new snapshot with HTTP 409.
- Live publish, revision and backwards import update the dated directory in the
  same transaction as their rolling publication. Each directory update compares
  its previously read body; concurrent writers cannot silently lose references.
- Archive materialization only commits buckets older than the current live
  window. That condition is checked inside the transaction. It never moves live
  collection, aggregation, or publication cursors. A conflict stops with an
  understandable failure; rerun the bounded interval safely.
- Activity chunks are staged before the atomic directory/page write. A failed
  transaction can leave unreachable immutable chunks but no readable partial
  publication. Independent days do not claim one cross-day atomic revision.

This adds bounded directory/snapshot writes per published bucket to the existing
DynamoDB table. Snapshots expire; durable storage grows with actual history.
There are no API-time S3 scans, RPC calls, database scans or new paid monitoring.
The writer still uses the existing bounded raw-range lookup and archive cache.

## Publish data already retained

After deployment, new live buckets enter dated storage automatically. Existing
older observations need materialization once; retention alone does not make their
pages discoverable. Choose an interval wholly before the live window's start.

```sh
export AWS_PROFILE=fls-power AWS_REGION=us-west-1
export FAME_HISTORY_TABLE='<history table>'
export FAME_HISTORY_BUCKET='<archive bucket>'
export FAME_HISTORY_FROM=1791331200
export FAME_HISTORY_TO=1791417600

# Read-only validation, receipt and per-bucket status; no RPC.
yarn nodets scripts/market-history/materialize-history.ts /tmp/history-receipt
# Commit dated pages/activity from exactly the same archived evidence.
yarn nodets scripts/market-history/materialize-history.ts /tmp/history-receipt --apply
```

Each run is limited to 24 hours. Replay an interrupted interval; completed buckets
are idempotent. The receipt distinguishes `missing-observation`,
`archive-not-ready`, `ready` and `published`. Storage/checksum/decoding failures
stop the run rather than being relabeled as gaps. No historical quote is inferred
from today's state. Prices, volumes, events and candles are rebuilt using the
existing sampled algorithm and verified archives, including the prior observation
when present. This does not change candle construction or conversion policy.

Deploying this code cannot erase existing data. The live rolling manifest is
unchanged by materialization. Rollback to the previous code merely stops exposing
the dated path; it does not delete archived observations or dated pages.

## Assumptions and boundaries to review

1. Directories are keyed by sampled policy revision. Pool/policy changes still
   require an explicit dataset transition; this PR does not stitch incompatible
   revisions into one response or synthesize missing six-pool observations.
2. Observations before reference collection began may be absent even when raw
   swaps exist. Such buckets remain gaps until a separate collection/rebuild job
   supplies evidence. Genesis collection is not required to serve existing dates.
3. Archive materialization must be rerun for older buckets already evicted before
   this code was deployed. A broad genesis job should invoke this same bounded
   serving step after producing retained evidence, without changing its API.
4. Directory CAS trades occasional retryable writer contention for no lost
   updates. A backfill must not run overlapping workers against the same day.
5. Cursor retention is 24 hours after supersession, independent of how old the
   underlying history is. It is not a retention limit on chart or activity data.

## Reproduce the existing-data end-to-end test

Start a disposable DynamoDB Local container bound to `127.0.0.1:18001`, then use
those same AWS read-only environment settings:

```sh
yarn nodets scripts/market-history/historical-serving-rehearse.ts /tmp/history-proof
```

The script rejects a non-loopback target, creates and deletes its own local table,
reads only `GetItem`/`Query` from the source table and S3 objects, and writes only to
DynamoDB Local. It reconstructs dated chart/activity pages, opens a temporary
loopback HTTP server around the actual API handler, verifies both currencies,
gzip, 304, incremental updates, transaction pagination and buy/size filters, and
checks chart trade counts against the transaction list. It closes the server and
deletes the local table even if validation fails. This proves the local handler
and real retained evidence, not deployed IAM/API Gateway behavior.

The deterministic worker rehearsal additionally exercises real DynamoDB Local
transactions: concurrent writers, publication failure/retry, historical replay
idempotence, live-overlap rejection, and 288-bucket reads. Unit tests cover sparse
gaps, midnight/live joins, checksums, cursor expiration, and pinned activity
pagination during repairs.

### Recorded validation (2026-10-09)

Source: retained production five-pool observations and raw archives. Destination:
disposable DynamoDB Local; production remained read-only.

| Check | Result |
| --- | --- |
| Historical interval | 2026-10-07 00:00–2026-10-08 00:00 UTC |
| Requested buckets | 288 |
| Available buckets, each currency | 243 |
| Explicit gaps before observations began | 45 |
| Candles, each currency | 242 (first bucket has no prior observation) |
| Activity events, each currency | 21, 16 bounded pages |
| Chart trade count vs activity swap rows | Equal |
| Buy + minimum-size filter | Matches unfiltered event selection |
| Compression / ETag / idle delta | gzip / HTTP 304 / zero upserts |
| RPC calls / production writes / live cursor writes | 0 / 0 / 0 |
| Automated unit and contract checks | 210 tests in 26 suites passed |
| CDK checks | 4 passed |
| Real local transaction rehearsal / TypeScript | Passed |

The preceding eight-hour replay also passed (96 buckets, five events, both
currencies). Receipts are generated locally by the rehearsal command; no archive
payloads or credentials are committed. Public API verification remains an
operator deployment step, followed by materialization of retained older ranges.

## Earliest available history and backwards navigation

`GET /fame/history?view=availability&before=1791417600` returns:

```json
{
  "version": "fame-history-availability-v1",
  "policyRevision": "<active sampled policy hash>",
  "earliestAvailableTimestamp": 1791344700,
  "latestAvailableTimestamp": 1791581700,
  "resolution": 300,
  "maxWindowSeconds": 86400,
  "before": 1791417600,
  "hasEarlier": true
}
```

The timestamps above illustrate the shape; read the endpoint for current values.
`before` is optional and exclusive. With it, `hasEarlier` is true iff at least one
published bucket is older than `before`. The boundary describes published chart
and activity-page references for this policy, not chain genesis, retained raw
coverage, price completeness, or a guarantee of uninterrupted observations.

For each earlier page, use the current page's `from` as `before`. Stop when
`hasEarlier` is false (or the current `from` reaches `earliestAvailableTimestamp`).
Otherwise request `[max(earliestAvailableTimestamp, before - 86400), before)`.
Continue through empty/interior gaps: **never stop based on
`outside-published-window` alone**. Refresh availability when navigating; later
materialization may move the earliest boundary backwards. A policy change requires
refreshing this metadata and discarding cursors from the previous policy.

Availability uses one consistent live-pointer read and a `Limit: 1` ascending
query of dated directories, with no table scan or page-body reads. It uses the
same authentication and `private, no-store` response policy. Existing ten-digit
Unix-second directory keys sort chronologically for Base history (through 2286);
an unexpected key fails closed instead of returning a misleading stop signal.

### Retain the pre-deployment live window once

New live buckets are retained automatically, but buckets already in the rolling
window at deployment may have no dated reference. Retain those existing references
once, so they cannot create new gaps as the window advances:

```sh
yarn nodets scripts/market-history/materialize-history.ts /tmp/live-retention --retain-live
yarn nodets scripts/market-history/materialize-history.ts /tmp/live-retention --retain-live --apply
```

This mode verifies both currency pages and activity indexes using bounded batch
reads. It adds only missing dated references in one transaction guarded by the
live publication generation and each day directory's prior body. It refuses a
conflicting reference, missing index or corrupt page. A concurrent live advance
aborts the transaction; rerun after inspecting the failure. No quotes, activity,
chart bodies, live pointers, or raw archives are rewritten. Repeating a completed
retention is a no-op. No runtime deployment is needed to run this operator mode.

During the October 9 production materialization, 502 older buckets passed
read-only validation and were published; two more were validated and published
at the advancing window boundary. Another 283 already-live buckets needed only
reference retention. October 7 public ETH and USDC requests each returned 243
published buckets, 242 priced candles and 21 events (11 buys, 10 sells); 45 buckets
before 03:45 UTC remained explicit gaps. The active dataset was unchanged and live
checkpoints advanced rather than being reset. The current earliest published
boundary is `1791344700` (2026-10-07 03:45 UTC), not chain genesis.
