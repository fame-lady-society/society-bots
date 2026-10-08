# Compact chart serving and publication cursors

## Implemented contract

`GET /fame/history?view=chart&currency=ETH|USDC&resolution=300&series=market|<pool-id>&from=...&to=...`
returns a `fame-chart-v1` snapshot with a cursor. The next request includes that
cursor and current rolling bounds. A delta contains only new/revised bucket
upserts and authoritative window boundaries. Quiet periods still have samples;
missing values remain explicit gaps. The chart's blended pricing math is unchanged.

A cursor binds publication generation, policy, schema, selected series, currency
and prior bounds. It is opaque metadata, not an authorization credential. The
same bearer authorization applies. Malformed input fails before key construction.
A missing/expired retained generation returns `409 cursor-reset-required`; the
consumer retries once without a cursor. Storage corruption remains a 503.

Readers pin one manifest and compare currency-specific page hashes before any
bucket reads. Idle polls read only the current manifest. Changed polls read that
manifest, the retained base manifest, and only changed bucket pages. Full loads
use one manifest read and three concurrent strongly consistent batches of up to
100 pages. Unordered results and UnprocessedKeys are handled within bounded
retries/deadlines. Page checksums and identities remain mandatory.

All publication writers (forward, prepend and revise) atomically retain previous
and next manifests with the publication switch. Manifest bodies are immutable;
expiry refreshes when a generation is superseded. The active manifest is always
available even if its retained copy expires. This also bootstraps an existing
publication without any reader write permission or historical price rebuild.
TTL applies only to new manifest items via `expiresAt`; raw data/pages have no
new expiry. Cursor expiration is checked explicitly, independently of TTL cleanup.

The frontend keeps per-currency/per-series snapshots in TanStack Query. It merges
upserts by timestamp, expires old grid entries and applies cursors with data
atomically. Wrong-base deltas are rejected. A currency switch cannot relabel
cached prices. The existing comparison-series controls are retained; each selected
series fetches independently and carries its own cursor. Market volume per bucket
is supplied by the backend even for a pool view, avoiding full-window summary
reads. Client range summaries add exact backend bucket values, not pool quotes.

Successful frontend responses keep the 30-second public cache; origin responses
remain private. Query keys include selection, bounds and base cursor. Errors are
no-store. Snapshot weak ETags revalidate at the origin before bucket reads;
idle cursor requests return an explicit empty delta. Origin gzip is negotiated
and returned using the API Gateway binary envelope. Never log credentials.

## Measurements (2026-10-08)

These are separate proof boundaries, not an apples-to-apples deployed speedup.

| Measurement | ETH | USDC |
|---|---:|---:|
| Existing production origin, first body bytes | 1,152,741 | 1,167,626 |
| Existing origin median, 20 serial requests | 1,053.5 ms | 1,002.5 ms |
| Existing origin nearest-rank p95 | 1,265 ms | 1,074 ms |
| Compact 288-bucket Market fixture, JSON bytes | 119,586 | 120,459 |
| Same compact fixture, gzip bytes | 11,899 | 13,519 |
| New reader from local client to production DynamoDB, median | 268.5 ms | 265.5 ms |
| Same local-to-AWS reader p95, 20 reads | 294 ms | 390 ms |
| Same local-to-AWS idle cursor poll | 119 ms | 121 ms |

The old origin returned identity encoding even when gzip was requested. Baseline
first request is included; no cold-start claim is made. Compact fixture bodies are
about 90% smaller decoded and about 99% smaller compressed than the original
origin response; these are different time windows with equivalent 288-bucket
shape. Individual pool snapshots range up to 140,135 JSON bytes and 13,546 gzip
bytes. Fixture idle responses are about 1.3 KB decoded and read zero bucket pages.

Production AWS read-only rehearsal measured 588 read-capacity units for each full
window (576 for pages, 12 for the manifest), versus 12 for an unchanged cursor.
One changed page requires its page capacity plus current and retained manifests.
The equivalent transactional full read would require twice the strongly consistent
capacity; this last comparison is a billing-model calculation, not a measured old
reader capacity trace. New origin/proxy deployed p95 targets remain unverified.

Retaining manifests adds two transactional manifest puts per successful switch
(roughly two 46–48 KiB items at a full window), including repairs. A full day's
288 live generations retains roughly 13–14 MiB of manifest bodies; a 288-generation
repair adds a similar amount until expiry. TTL cleanup is asynchronous, so actual
storage can temporarily exceed the retention interval. No paid monitoring or new
cache service was added. Existing pages and archives are unchanged.

Reproduce offline with `yarn nodets scripts/market-history/measure-chart.ts
<input-directory> <output-directory>` using both saved fully published detailed
API responses. Read-only AWS measurement uses `measure-chart-live.ts` and the
existing table/profile environment; it reports capacity/calls and no bodies.
Ignored receipts live under `.market-history-local/`.

## Validation and rollout

Local tests cover snapshot/idle/append, same-timestamp repair, rolling gaps,
expired/mismatched cursors, malformed requests, unordered/partial batch reads,
retry exhaustion, missing pages, gzip/identity negotiation and snapshot 304.
The DynamoDB Local rehearsal exercises manifest retention through actual atomic
publication/revision and observes a repair through a cursor without changing live
collection. The frontend validates compact fields with an explicit allowlist and
tests stale-base rejection, exact merged-snapshot equivalence, gaps and rollover.

Operator order:
1. Merge/deploy backend/IAM/TTL together. Verify `view=chart` in both currencies,
   gzip/identity and a cursor poll; verify forward collection/publication.
2. Deploy the frontend chart. Do not deploy it before the new contract exists.
3. Measure the deployed origin and proxy, including cursor updates and cache hits.
   Confirm the 150 KiB decoded / 40 KiB compressed snapshot and latency targets.
4. Inventory other consumers before removing the old public detailed route. It
   remains during cutover; there is no automatic frontend fallback. Internal
   detailed reading is still required by diagnostics/rebuilds.

No production mutation or deployment was performed during implementation. No
backfill is needed. Production gateway gzip behavior and frontend CDN hit latency
must be verified after deployment; local gzip tests do not establish those facts.

Final local validation: 188 history tests, four deployment/import tests, 16 frontend
tests, TypeScript, targeted ESLint and the frontend production build passed.
Repository-wide frontend lint passed with four existing warnings outside the
chart. The scoped build logged an unrelated missing OpenSea key during listings
SSR, but completed successfully. Fixture-backed browser checks proved selected
pool-only initial fetches, actual cursor polling, expired-cursor snapshot recovery,
currency switching and mobile width with no page errors.
