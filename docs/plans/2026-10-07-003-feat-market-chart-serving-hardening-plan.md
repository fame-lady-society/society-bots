---
title: "feat: Compact and faster market chart serving"
type: feat
status: in-progress
date: 2026-10-07
updated: 2026-10-08
---

# Market chart serving hardening

## Outcome

Make a 24-hour, five-minute chart small and responsive without changing the
FAME-balance-weighted index, losing pool drilldowns, or weakening completeness.
Keep the raw archives, observations and detailed derived history. Chart consumers
receive only the selected series and the summaries they display. Initial loads
return the requested window; subsequent updates use a publication cursor and
return only new or revised buckets, including historical repairs.

Approved for implementation on 2026-10-08. Production deployment remains an
operator action. The newer comparison-series UI is carried forward: each selected
series is fetched and cached separately; unselected pools are not prefetched.

## Evidence and baseline to establish

User reports approximately 731 KB and 1.2–1.5 seconds for one day. This is not yet
a controlled benchmark: transferred versus decoded bytes, request hop, cache
state, geography and cold starts remain unknown.

Verified current code:

- `src/fame-market-history/sampled-api.ts` pins a publication, then reads up to 288
  content-addressed bucket pages in five sequential groups of 64. All six calls,
  including the single publication read, use TransactGet. Full pool series and
  repeated metadata cross the origin API. Integrity checks and a 2 MiB ceiling
  apply. Grid assembly performs a repeated bucket search.
- `api-lambda.ts` returns `private, no-store` and serializes the full response.
- fls-www `server/historyClient.ts` requests upstream with `cache: no-store`, then
  validates/projects its response. The browser still receives every pool.
- The frontend proxy permits 30 seconds of shared caching for successful public
  chart data. Errors are no-store. `useHistory.ts` polls each minute, pauses in
  background, and keys by currency. Pool changes currently select local data.

Measure origin and frontend proxy separately for the same fixed, published day,
both currencies, then the rolling window with pending buckets. Record decoded
JSON bytes, encoded body bytes, transfer bytes, Content-Encoding, TTFB, total
latency, response/cache headers and publication identity. Use 20 serial warm
samples per representative case; report p50/p95 and sample count. Record observed
cold starts separately rather than presenting a cache-busted request as a cold
Lambda. Do not change production concurrency to manufacture cold starts.

Use local replay fixtures to time publication read, page reads, validation,
projection, JSON serialization and compression independently. During the read
rehearsal request ReturnConsumedCapacity and record retries/call counts. Use
existing logs and a bounded local report; no new paid dashboard, custom metric,
alarm, cache service or monitoring stack. Redact bearer credentials.

## Targets and acceptance gates

For Market, 288 buckets in either currency:

- At most 150 KiB decoded chart JSON and 40 KiB compressed body; target at least
  75% reduction relative to the measured equivalent baseline.
- Warm uncached origin p95 <= 750 ms and at least 30% below the measured baseline;
  warm cached proxy p95 <= 300 ms from the same benchmark location. These are
  engineering targets, not promised results. Report network-dependent limits.
- No increase in DynamoDB read capacity per origin miss, no additional RPC calls,
  and no change to collector work. Report cache hits and misses separately.
- Repaired or newly published data appears within the existing 30-second shared
  cache lifetime plus the existing active-tab polling interval. No long-lived
  stale response may hide a repair.
- Unchanged cursor polls perform zero bucket-page reads. A normal one-bucket
  publication advance reads only that new page and sends one published upsert,
  plus any newly entered pending grid slot. Historical repairs read/send only
  changed pages within the requested window. Manifest metadata reads are counted
  separately; cursor updates must not fetch all pages then filter the response.
- A one-bucket update targets <=8 KiB decoded, <=4 KiB compressed and warm origin
  p95 <=400 ms. Measure idle polls, forward progress, rollover and repair separately.
- Exact fixed-point values, gaps, coverage and counts match the existing reader.
  No conversion to floating point until chart rendering.

If the first bounded milestone misses these targets, publish measurements and
identify the remaining bottleneck before introducing another storage layout.

## 1. Compact chart contract

Introduce a dedicated chart projection (`view=chart`) in the existing history
service. Parameters: currency ETH|USDC, resolution=300, aligned from/to <=24h,
and `series=market|<reviewed-pool-id>` with market as the default. Reject unknown
selectors, duplicates and malformed bounds. No arbitrary lists or wildcard pool
selection in this chart contract.

A top-level envelope contains schema version, currency, bounds, resolution,
publication identity/frontier, policy revision, selected-series identity and
price/candle/conversion method. Include a small pool catalog once so radios need
no discovery request. Pool metadata and method descriptions do not repeat in
288 buckets.

Each bucket contains timestamp, publication/price/activity coverage, nullable
reference price, nullable OHLC, selected-series volume/inventory and execution
count. For Market these come from `market` and `totals`; for a pool they come
from that pool's row. Keep independent metric completeness labels. A missing
candle is not zero, and missing volume is not a quiet bucket.

For pool drilldowns, include each bucket's backend-computed market volume and
its completeness alongside selected-pool volume. Market rows reuse their volume
field. The consumer maintains exact 1h/6h/24h totals from these authoritative
bucket values, recomputing after upserts and expiry (at most 288 additions).
It never aggregates pools or invents conversion rules. This replaces the original
proposal for request-time server summaries, which would otherwise force a full
window read on every cursor update. Missing values remain incomplete, not zero.

The response omits other pools' samples, per-bucket weight arrays, raw balances,
route evidence, block hashes and duplicated policy fields. Those remain in
existing stored evidence and internal diagnostic/rebuild access. A separate HTTP
evidence API is not part of this milestone.

Keep named JSON fields and decimal strings; no tuple encoding, binary protocol,
lossy rounding or new schema framework. Define and test an explicit allowlist
projection, never spread stored records into the compact response.

Projection reduces network/parse cost but does NOT reduce stored item reads or
RCUs by itself. Do not claim otherwise.

## 2. Remove unnecessary sequential transactional reads

Pin the publication once with a strongly consistent GetItem. Fetch referenced,
immutable pages with strongly consistent BatchGetItem in groups of at most 100,
with at most three requests in flight. A day normally becomes one publication
round trip followed by three concurrent page batches. This is a bound, not a
promise that throttling never requires retries.

Map responses by complete primary key: BatchGet does not promise order. Retry
only UnprocessedKeys with jittered backoff, at most three retries and within a
single overall request deadline. Keep SDK retry behavior in the same budget;
do not multiply hidden retries. Missing referenced pages, mismatched identities
or checksums fail visibly; they must never become legitimate chart gaps.

The consistency argument is the pinned manifest plus immutable content-addressed
pages, not a transaction spanning several independent read calls. Verify writers
publish referenced pages before/atomically with the manifest and that expiration
cannot remove pages during an in-flight request. Preserve existing publication
CAS and repair behavior. Test a writer advancing and a repair replacing hashes
between every reader call: a response must belong wholly to its pinned manifest.

Build a timestamp map once for grid assembly. Retain read deadlines and bounded
body sizes; apply the compact body cap after projection and an independent input
budget before parsing stored pages. A small chart response must not conceal
unbounded origin reads as more pools are added.

AWS documents 100 items/16 MiB per BatchGet, partial results including a per-
partition size constraint, UnprocessedKeys retries, and separate consistency
options. Transactional reads consume more capacity than strongly consistent
standard reads. Rehearsal must measure actual rounding/item-size costs:
- https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html
- https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html

## 3. Publication cursors and incremental updates

Use the same chart route with optional `cursor`. The initial response is
`mode: snapshot` with the full requested grid and a cursor. Updates return
`mode: delta`, `baseCursor`, a new `cursor`, authoritative from/to boundaries,
publication frontier, timestamp-keyed `upserts`, and explicit `removedTimestamps`
for invalidations inside the retained window. The client also drops timestamps
outside the returned boundaries. No deletions may be inferred from an omitted
upsert. The normal update is one published bucket, not 288.

Bind the opaque, bounded cursor to chart schema, policy revision, publication
generation, currency, selected series and the previously delivered bounds. Use a
versioned encoded metadata token; it contains no credentials and confers no access.
Validate every field, hash, length and selector before constructing storage keys;
retain normal API authentication. It must not carry all 288 page hashes or rely
on Lambda memory or per-browser server sessions. Clients must treat it as opaque.

An update may keep the same bounds or advance a rolling window of the same width.
Use the old cursor bounds to determine what the client has and the new requested
bounds to determine its desired grid. A backwards move, disjoint range or window
resize requests a new snapshot. Currency/series changes use that selection's
cached cursor or a new initial load, never another selection's cursor.

### Detect changes before fetching pages

Retain immutable publication manifests keyed by generation in the existing table.
Before activating a generation, persist its manifest, then use the existing CAS
publication switch. Every writer must follow this order: live publication,
historical import, refill/repair and revision scripts. A failed CAS may leave an
unreferenced manifest; expiry cleans it up. Never expose a cursor before its
manifest is durable. The initial current manifest is also persisted before a
snapshot response can hand out its cursor.

Guarantee cursor validity for at least 24 hours after a generation is superseded;
refresh the prior manifest expiry atomically during each publication switch. Store an explicit expiry
and use DynamoDB TTL only for eventual cleanup, never as the validity check.
The active manifest remains available regardless of age. Carry enough activation
metadata to make identical retries preserve expiry, and distinguish the active
manifest from retained generations. Keep only manifest metadata/history, not
per-client state or copies of raw archives. Measure write/storage overhead,
including many generations during a 288-bucket repair, before production rollout.

For an update, strongly read/pin the current manifest. If generation and bounds
are unchanged, no bucket reads are needed. Otherwise load the retained base
manifest, compare its currency-specific page hashes with the current manifest
and compare old/new grid coverage. Fetch only new or changed current pages in
the requested window. Generate pending/outside-window gaps from metadata, without
page reads. A page becoming unavailable must send a gap replacement or explicit
removal; it cannot silently retain the client's formerly published value.

A publication change outside the requested range may return an empty delta with
a new cursor. An unchanged generation with a rolling-window move can still need
new gap slots and eviction boundaries. Timestamp-only cursors and last-trade
cursors are unsuitable: neither detects repairs to older buckets.

An expired or valid-but-no-longer-retained cursor returns `409 cursor-reset-required`
with no-store. The consumer clears that cursor and requests one full snapshot;
never return an empty success for an unknown base. Malformed tokens return 400;
policy/schema changes explicitly require reset. Infrastructure errors and corrupt
retained manifests remain errors, not reset loops. Do not treat every storage
failure as an expired cursor. Limit automatic reset to one per update attempt.

### Client merge and consistency

Keep the applied cursor and assembled buckets together in each selection's query
cache. Serialize updates per selection, cancel obsolete work and discard any
response whose baseCursor does not match the current cache. Atomically validate
and apply replacements, removals, bounds and next cursor. An out-of-order response
must never roll back a repair or advance the cursor without its data. Retry a lost
response using the unchanged base cursor; server deltas are deterministic for a
pinned target generation and idempotent to merge. Recompute displayed summaries
from the merged grid. Keep prior valid data on transient errors and label it stale.

No incremental mutation of raw evidence, execution OHLC or collection cursors is
needed. Snapshot and merged-delta results must be exactly equivalent for the same
publication and bounds.

## 4. Compression, revalidation and consumer fetches

Verify actual HTTP content encoding at both hops before adding compression.
Use platform compression where verified. If the origin lacks it, implement
bounded negotiated gzip at the Lambda response boundary and verify API Gateway
binary/base64 handling end to end. Respect Accept-Encoding and Vary, correct body
lengths, identity requests and 304 responses. Avoid double compression and test
decoded-body limits in the proxy. Do not add Brotli-specific infrastructure.

Keep origin authentication and private cache policy. Keep public shared caching
only on the frontend's deliberately public chart projection. No bearer token or
user-dependent data reaches shared cache entries. Successful response cache keys
include contract version, currency, series, bounds, cursor (when supplied) and
representation. Never share a delta cached for another base cursor. Error
responses remain no-store.

Cursors are the primary refresh protocol. Return a small empty delta for idle
cursor polls; it confirms the current bounds/frontier without reading bucket
pages. Retain ETag/If-None-Match for full snapshots and ordinary HTTP cache
revalidation, with validators covering publication, request and representation.
Do not substitute a 304 for a required cursor/bounds advance. Verify origin and
proxy conditional handling; any 304 must preserve the client's cached body and
must not be parsed as JSON.

Use existing TanStack Query support for per-currency/per-series caching and
cancellation. Add selected series to the key, fetch on radio selection, and retain
last successful data only for the same selection. Never relabel a Market or USDC
response as another pool/currency while loading. Use cached drilldowns on return;
do not prefetch every pool. Keep selected timestamp and viewport where possible.
Test keyboard radios, loading, retry, stale data and rapid switching, including
returning to a cached selection with a still-valid or expired cursor. Preserve
the existing active-tab polling cadence; incremental updates reduce work per poll
without requiring WebSockets or a faster collector.

## Verification and rollout

1. Capture baseline and implement the immutable reader improvement independently;
   retain exact existing output. Unit tests cover unordered/partial batches,
   throttling, bounded retries, cancellation/deadlines, corruption and concurrent
   publication/repair. Local DynamoDB rehearsal proves snapshot integrity.
2. Add compact projection, durable manifest retention, cursor protocol and frontend
   merge logic as one complete milestone; include every publication writer.
   Golden comparisons cover both currencies, all pool selectors, blended candles,
   quiet buckets, missing opening weights, partial metrics, pending/outside-window
   buckets and summary arithmetic. Add serialization size regression fixtures.
   Prove full-snapshot versus merged-delta equivalence across append, no-trade
   updates, multi-bucket catch-up, same-timestamp repairs, gaps, removals, rollover,
   outside-range changes, expiry, policy reset, failed CAS and lost/out-of-order
   responses. Assert the exact page keys read: zero for idle polls and only changed
   keys for updates. Check cache isolation by selector, currency and base cursor.
3. Run browser verification through the actual proxy, test both encodings and
   snapshot and cursor reads, record before/after latency/capacity and manifest
   retention write/storage overhead. Exercise publication
   advance and a local repair with unchanged bounds to challenge cache behavior.
4. Operator merges/deploys backend, verifies the new chart route, then deploys the
   frontend. Existing detailed route remains usable during this ordered cutover;
   no client fallback to it. Inventory external consumers first, then explicitly
   retire the obsolete public broad route in the completion change. Keep the
   detailed internal reader for rebuilds/diagnostics as a distinct responsibility,
   not a permanent compatibility adapter. No historical data rewrite is needed
   for chart values because both views derive from the same stored pages. Seed
   the active retained manifest before issuing cursors; older clients simply
   establish their first cursor with a snapshot.
5. Verify production header behavior, sizes, bounded latency and continued live
   collection/publication. Roll back the matching consumer/backend release if
   correctness fails; do not reset cursors or reingest chain data.

The first reviewable deliverable is the measurement report plus bounded reader
change, with parity tests. The compact contract plus repair-aware cursor and
consumer merge is the next deliverable; cursor support is in scope, not deferred.
Do not merge an incomplete consumer/backend contract combination.

## Follow-up only if measurements justify it

If immutable page reads still dominate or the input cap limits registry growth,
publish compact chart chunks as part of the existing worker. Prefer small,
content-addressed time chunks and an atomically switched manifest over rewriting
one full day on every tick. Reuse unchanged chunks; repair only touched chunks;
readers pin one generation. Specify chunk boundaries, write amplification,
retention, failure recovery and costs in that follow-up before choosing DynamoDB
versus S3. Do not introduce Redis, a second indexer, Athena queries per request,
or a new analytics database to solve this serving problem.
