---
title: "feat: Serve precomputed FAME history through the existing API"
type: feat
status: implemented
date: 2026-10-05
---

# FAME history API

## Implementation decisions (2026-10-05)

Update (2026-10-06): the operator requested automatic start selection. Manual CI
now chooses the finalized Base head on the first deployment and creates the
durable `/society-bots/market-history/start` marker with block hash/time. Subsequent
deployments and retries reuse it without requesting a newer head. A conditional
create prevents concurrent initialization from changing the boundary. No
`start_block` workflow input remains; selecting the start does not deploy anything
until the operator runs the deployment workflow.

The operator approved implementation and clarified that **both ETH and USD** are
required. The implementation below supersedes the initial USD-first proposal:

- Each market bucket has ETH and USD OHLC, VWAP, converted volume, priced/unpriced
  FAME volume and execution counts, native quote groups, and pool contributions.
- Archive two finalized boundary observations per collector range. Each boundary
  is one shared Multicall (51 contract reads for the current registry). Preserve
  the raw snapshot in archive metadata and Parquet evidence. A transport failure
  retains the cursor; an individual contract revert is an explicit unavailable source.
- Price executions using only an observation from an earlier block, at most
  1,800 seconds old. WETH is the ETH unit. Other quote assets take the explicitly
  selected independent routes in `valuation.ts`; none routes through FAME.
- USD uses Base's Chainlink standard ETH/USD proxy
  `0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70`, eight decimals, with positive,
  nonfuture round data and the same 1,800-second age limit. The official directory
  lists a 1,200-second heartbeat. USDC and frxUSD are never assumed to equal $1.
- Connector prices are observed marginal pool spots, not executable trade quotes
  or TWAPs. Solidly stable pricing uses the invariant derivative. CL connectors
  with zero active liquidity are unavailable. Thin-pool manipulation remains a
  documented limitation of this chart methodology.
- Liquidity is token custody balances valued at each pool's own FAME spot plus
  the independent quote conversion. This includes balances held for fees/donations;
  it is not executable depth or a reconstruction of every LP position. CL active
  liquidity is only a source-usability check, never substituted for token balances.
- Snapshot cadence follows collector ranges, not every trade. An observation at
  a range's end cannot price earlier trades. Old raw archives without snapshots
  remain explicitly unpriced except for direct WETH executions.
- API conversion metadata exposes the route policy and source addresses. Exact
  oracle rounds, rates and block hashes remain in immutable raw/Parquet evidence.
- Published market + pool rows share the existing atomic write. Reader permissions
  are Query and GetItem constrained to TransactGetItems (not an IAM action named
  TransactGetItems). The existing bot stack exports API/authorizer IDs; manual
  history CI requires those outputs and verifies stage AutoDeploy before deploying.

Read-only live source rehearsal at Base block 52,233,578 found all four quote
routes and five custody observations available, with a valid ETH/USD round:
four RPC requests, 59,930 response bytes, no AWS writes. This establishes current
read compatibility only, not historical archive-state availability or deployed cost.

Independent consistency, security, simplification and adversarial reviews found
and corrected transactional IAM authorization, outer Multicall failure handling,
failed identity subcalls, empty CL connector pricing, and divergent local API proof.
Final local checks: 112 history/script tests, 26 history/pool-state infrastructure
tests, root type checking and deploy build passed. DynamoDB Local verified atomic
publication, recovery, the production HTTP contract and two-page 288-bucket reads.
The offline Linux/amd64 Lambda image completed the Parquet rebuild proof with no
network, a read-only root filesystem and 512 MiB memory. Source-configuration drift
now fails before publication rather than relabeling old observations.

Remaining production proof is authenticated gateway behavior and collector/worker
operation after explicit CI deployment. Backfill and website rendering remain deferred.

## Outcome

Expose `GET https://api.fame.support/fame/history` for a website server or another
authorized service to read a built-in FAME market view and per-pool drilldowns.
The service owns aggregation across the configured pools. Return exact
numeric values, explicit missing/partial coverage, and publication watermarks.
The completed deliverable is a unified market price/volume chart and valued
liquidity history. Grouped quote-token series are an intermediate milestone and
drilldown, not the final substitute for a comprehensive chart.
The request path reads precomputed DynamoDB records only. It performs no chain
RPC calls, DuckDB work, S3 queries, backfills, or writes.

This is a follow-on to PR #39, based on inspected commit
`4476e588a9cc98fd978f53bfe1cb88e9d7633135`. That PR's checks passed; it remains
open at planning time. Neither those checks nor this plan establish a deployed
history service. This document proposes implementation; it is not approval to deploy.

The operator's priorities remain efficient algorithms, batched reads, durable
progress, and small working increments. No custom CloudWatch metrics, dashboards,
alarms, cost cutoff, new monitoring service, or Overclaw integration belongs here.
Keep normal diagnostic logs. The website continues to own chart rendering.

## First reviewable milestone

Deliver one authenticated endpoint with `view=market` and `view=pool`, integrated with the existing HTTP API,
and prove the path from collector archive to worker publication to API response.
Include partial candles with explicit labels; do not fabricate complete history.

Start with the entire configured market or one pool per request, resolution `300` seconds, and at most 288 buckets
(24 hours). This bounds DynamoDB work and JSON size while supporting a useful
daily chart. Clients request explicit adjacent time windows for older data.
Do not introduce cursor tokens or an arbitrary-resolution query language.

Deliver this scope in working layers: first the shared market/pool API and native
quote aggregates, then historical conversion and unified candles, then valued
liquidity history. All three layers belong to this plan. Defer public browser
access, website UI, backfill, canonical repair, and serving retention changes.
Liquidity observations are archived today but still need a time-indexed serving
representation; reading archives per HTTP request would undermine the cost requirement.

The 2026-10-05 scope correction makes the market view a first-milestone requirement,
not something the website must construct. A single converted price/TVL series has
additional data requirements described below; the API must expose their absence
explicitly until the corresponding producer work is complete.

## Built-in market view and remaining data gaps

`view=market` returns one aligned time series covering all pools in the configured
scope, plus server-computed window totals and a pool contribution breakdown.
`view=pool&pool=<id>` provides drilldown using the same coverage/units conventions.
The website renders either response; it does not fetch five series and invent
aggregation rules. Market means the declared indexed scope, not every FAME venue
on every chain or all history before collection started.

For each market bucket, materialize:

- Gross FAME traded (`baseVolumeAtoms`) and pool-swap count across included pools.
  This is venue turnover: a route/arbitrage touching two FAME pools counts both
  executions. It is not unique transaction volume, distinct traders, or net flow.
- Quote-token totals keyed by chain/address, with decimals. The current scope has
  frxUSD, SCALE, WETH and basedflick quotes. Never add their token amounts together
  or assume a stablecoin is exactly one dollar.
- Same-quote execution OHLCV groups. The two WETH pools can share a FAME/WETH
  series. Compute group OHLC from normalized trades in block/transaction/log order;
  averaging pool OHLC or combining their opens/closes loses the required ordering.
- Per-pool contribution counts, volumes and coverage, plus expected/included/
  missing pool IDs and rejected-event counts. Fully complete market coverage
  requires every expected pool and valid decoding for the bucket. Missing pools
  produce an explicitly partial observed total; do not silently treat them as zero
  or claim a percentage of total economic activity from a pool-count fraction.
- Explicit `unavailable` status/reason for unified-price and historical-liquidity
  fields before their prerequisites exist. Do not return zero as a placeholder.

Return both a bucket series and window totals computed by the API from those
bounded precomputed rows. Label window totals partial if any component bucket is
partial/missing. Pool contributions and quote groups are included, so callers can
explain exclusions without additional requests. No price exists for an empty
trade bucket; do not carry a last execution price into OHLC.

| Capability | What is available | Gap to close inside this service |
| --- | --- | --- |
| Combined activity and venue breakdown | Raw pool swaps, normalized amounts, chain order, pool scope | Worker market aggregation, materialized rows, coverage rules and API contract; included in the first milestone. |
| Same-quote price series | Two FAME/WETH pools plus other single-quote groups | Aggregate normalized executions by quote identity in the worker; included in the first milestone. |
| One common-currency price/volume series | Per-pool execution prices in different quote tokens | Persist historical quote-to-numeraire prices with timestamps, provenance and staleness bounds; choose a numeraire/source policy and convert each trade before OHLC/VWAP. Current snapshots cannot price old trades. |
| Historical combined liquidity/TVL | Archived reserve observations and CL state observations | Materialize deduplicated observations, align them to a common as-of time, flag stale/missing pools, and value actual token balances in a common currency. CL active liquidity is not TVL or directly additive to reserve balances. |
| Broader market/history coverage | Five configured Base pools from a chosen start | Add reviewed missing venues and historical ingestion separately, preserving scope/version and exclusions. |

For the common-currency layer, do not pick a single pool as a hidden
market price. Define `USD` (or another agreed numeraire), historical conversion
sources, maximum age, no-lookahead rules, thin/manipulated-market handling, and
eligible-pool policy before enabling the metric. Derive execution OHLC from
converted trades in chain order and VWAP from total converted quote value divided
by gross FAME volume. Report unpriced/excluded FAME volume and pool IDs separately;
never divide priced quote volume by a denominator that includes unpriced trades.
Publish conversion/policy versions with the result and reuse them during rebuilds.
This data pipeline is required to complete this plan, not a frontend calculation.

For liquidity, retain original observation times and use only observations at or
before the requested as-of time, with an explicit age policy. Do not mix current
snapshots into historical buckets or equate reserve value, active CL liquidity,
and executable depth. The exact first liquidity metric and conversion source are
decisions to resolve before implementing that next increment.

## Unified chart delivery layers

The operator confirmed the comprehensive market chart as the intended outcome.
Propose USD as the initial display currency; keep native quote amounts and source
identities so an ETH-denominated series can be added without another swap ingest.
Do not promise arbitrary currency conversion in the API. A USD label requires an
actual USD valuation anchor; a USDC-denominated route alone is not proof of a peg.

1. **Market foundation:** deliver the market/pool endpoint, native quote groups,
   volume/contribution breakdowns and coverage protocol described here.
2. **Conversion and unified chart:** inventory a valuation route for every quote
   token in the reviewed scope. Inspect the existing registry and landing-quote
   route authority for reusable identities and adapters; those current-state
   capabilities do not themselves provide historical prices. Select explicit,
   bounded routes to the currency anchor, with source/fallback priority and a
   proposed maximum of two hops. Resolve any token without a usable route before
   claiming full priced coverage. A full exchange router is unnecessary.
3. **Valued liquidity history:** publish sampled pool token balances and their
   common-currency values, then market totals with pool breakdowns. Reuse the same
   versioned valuation inputs. Resolve reserve-pool versus concentrated-pool
   balance accounting explicitly; CL active liquidity alone is insufficient.

Capture each shared connector/price input once per chosen finalized valuation
point and reuse it across pools and trades. Batch compatible contract reads and
cache persisted rates by source/block/version. Avoid per-trade receipt fetching,
per-request RPC, and duplicating a connector scan for each pool. Use the least
expensive sufficient observation method for each source; connector trade-complete
ingestion is not automatically required. Persist conversion evidence in S3 and
materialize the resulting market series in DynamoDB using the same offline/live
rebuild rules. Request count and provider response size must be measured with
representative routes before expanding collection.

Specify whether a valuation uses a contemporaneous oracle update, reconstructed
pool state, or an earlier sampled rate. Never use a future observation to price a
past trade. If rates are sampled, label converted candles as using sampled/as-of
valuation; complete swap coverage does not make FX valuation tick-exact. Expose
rate age, source, route version, priced/unpriced volume and completeness separately.

Conversion routes must not derive a quote token's anchor price through the same
FAME market being valued: that would make the price circular. Use an independent
anchor/path or mark the value unavailable. Avoid automatic best-price route changes
that make chart history unstable; review/version source changes and rebuild
affected buckets from saved evidence. Do not assume a thin pool is a reliable
valuation source merely because a path exists.

Build and test each layer end to end, but do not call the comprehensive chart
complete after layer 1. Completion requires one unified price/volume series,
historical liquidity totals with declared valuation semantics, per-pool drilldowns,
and explicit gaps for unavailable rates or observations. The frontend owns display,
not rate sourcing, routing, aggregation, or valuation rules. Longer materialized
resolutions can follow once this daily-chart path works.

## Verified pieces to reuse

| Owning source | Reuse / limitation |
| --- | --- |
| `src/fame-market-history/worker-storage.ts` | Candle partition `candles:<scope>:<pool>:300`, padded timestamp sort key, fenced atomic publication. Current progress lacks the complete time metadata needed by a response. |
| `src/fame-market-history/analytics.ts` | Candle fields, exact price/volume strings, coverage semantics, decoder provenance. Runtime imports load native DuckDB; do not import this module into the API handler. |
| `scripts/market-history/local-http.ts` | A local authenticated proof already exercises `/fame/history`. It serves an in-memory dataset, not the production storage/auth path. |
| `deploy/lib/http-api.ts` | Existing `api.fame.support` HTTP API and shared bearer-token Lambda authorizer for pool-state/quotes. The separate public landing snapshot route is not the authorization model for history. |
| `deploy/lib/fame-market-history.ts` | History table, producer Lambdas, separate manual CI deployment, ordinary logs and failure queue. |
| `src/fame-market-history/worker.test.ts` | Cross-range candle rebuild equivalence, crash recovery, and explicit capacity failures to retain. |

## Request and response contract

Example shape (timestamps are supplied by the caller):

```http
GET /fame/history?view=market&resolution=300&from=<unix-seconds>&to=<unix-seconds>
Authorization: Bearer <existing-service-token>
```

For drilldown, use `view=pool&pool=scale-equalizer-weth-fame` with the same time parameters.

- Require `view`, `resolution`, `from`, and `to`; require `pool` only for `view=pool`
  and reject it for `view=market`. Reject unknown/duplicate
  query parameters, a request body, non-decimal integer syntax, unsafe integers,
  negative timestamps, and `from >= to`.
- Bounds are UTC Unix seconds and must be divisible by 300. Use `[from, to)`.
  Require `(to - from) / 300 <= 288`. Permit the current open bucket by allowing
  `to` through the next five-minute boundary; reject later future windows.
- Resolve `pool` from the reviewed current history scope, independent of quote
  eligibility. Never accept caller-provided table names, scope IDs, or raw keys.
- Support only resolution 300. A future resolution requires its own materialized
  records and tests; do not silently aggregate it in the request handler.
- Return `schemaVersion`, view, scope ID and declared pool universe; for drilldown,
  pool/chain/address and base/quote addresses/decimals; for market, quote groups and contributions;
  resolution, requested bounds, decoder version/review status, metadata revision,
  publication revision, coverage watermarks, and ascending `points`.
- Preserve prices as decimal strings and token volumes as atom strings. FAME is
  the base; group/pool price is quote units per FAME. Cross-pool totals and
  same-quote prices follow the market rules above. No request-time conversion or
  carried-forward execution prices.
- Each existing point preserves OHLC, volumes, trade count, rejected-event count,
  and `coverage: complete | partial | missing` from publication. Include its
  `throughBlock` when useful to distinguish an older immutable bucket from the
  overall current publication watermark.
- A fully scanned no-trade bucket has zero count/volume and null OHLC. An absent
  bucket outside the published envelope is `missing`, with null OHLC/count/volume
  and reason `before-history-start` or `not-yet-published`. Do not encode unknown
  volume as zero. The API point type intentionally distinguishes missing data.
- A missing record *inside* the promised published envelope is an integrity
  problem: return a sanitized 503, not a synthetic complete or empty candle.
- `collectedThroughBlock` and `publishedThroughBlock` describe stored checkpoints.
  Their difference measures aggregation backlog only. Do not call it chain-head
  lag: this API does not contact the chain. Expose `publishedThroughTimestamp`
  and `publishedAt` so consumers can evaluate freshness themselves.
- An older requested window remains readable when collection is behind. Do not
  hide valid historical data merely because the newest publication is stale.

HTTP outcomes: 200 for a valid response including explicit partial/missing points;
400 for malformed/unsupported/out-of-bounds queries; 404 for an unknown pool;
401/403 from the existing authorizer for absent/invalid credentials; 503 with
`Retry-After` for unavailable history, inconsistent publication, or storage failure.
Before the first successful publication, return 503 `history-not-ready`.
Return fixed error codes, never SDK messages, tokens, raw keys, or stack traces.

Initially use `Cache-Control: private, no-store`. Do not build another cache service
or put the shared bearer token into browser JavaScript. The first website consumer
should request history server-side. Public cacheable chart delivery is a later,
separate design once the consumer and traffic are known.

## Bounded reads and consistent publication

Materialize market buckets under `market:<scope>:300` with padded timestamp sort
keys in the existing history table. Each bucket contains its quote groups and
pool contributions, so market reads do not fan out into five pool Queries.
Use one selected partition-key/range Query, not a scan or one Get per candle. Follow
`LastEvaluatedKey` only as necessary, with a maximum of two Query pages per attempt,
288 total items and a 2 MiB serialized response. Validate worst-case market rows
for the reviewed scope against these bounds and DynamoDB's per-item limit. Do not return a silently
truncated series if a bound is exceeded. Treat unexpected oversized stored rows
or internal page exhaustion as a sanitized service failure and log a fixed reason.
Reject oversized caller ranges before any storage access.

Strongly consistent Query reads alone are not a multi-item snapshot. The worker
can replace a partial boundary candle and advance progress in one transaction
while the API is reading. Use an optimistic read protocol:

1. Transactionally read active scope, aggregation progress, and collector cursor.
   Validate scope, metadata revision, and availability. Capture aggregation
   `nextBlock` and `sourceRevision` as the publication marker.
2. Query the requested candle range with `ConsistentRead: true`, using exact key
   conditions and no `FilterExpression`. Validate returned row identity, bounds,
   metadata revision and `throughBlock <= captured publishedThroughBlock`.
3. Transactionally reread active scope and aggregation progress. If their relevant
   publication identity changed, discard the entire result and retry once.
   Ignore lease-owner/lease-time changes: they do not publish new data. Collector
   advancement alone does not invalidate candles; report the captured watermark.
4. If the publication changes again, return 503 `history-updating`. Never combine
   pages from different attempts. Do not demand identical per-candle source
   revisions: earlier buckets legitimately retain their prior revisions.

At most two attempts mean at most four Queries and four transaction reads, before
bounded SDK retries. Set SDK attempts to two and bound request/connection timeouts
under a ten-second Lambda timeout. Most reads should use one Query and two small
transaction reads. Measure actual `ConsumedCapacity` in local/live rehearsals;
do not replace these limits with a daily allowance or another billing ledger.

This protocol assumes every candle mutation advances the same monotonic publication
marker transactionally. The current worker does; any future repair/backfill writer
must preserve that invariant. Test interleaving publication before, between and
after pages. A future repair must not reuse a marker (the ABA problem).

AWS documents [Query pagination](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Pagination.html)
and [read-committed isolation between transactions and Query](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).
Those are why pagination and the publication check are explicit here.

## Minimal producer changes

Extend the existing atomic aggregation progress update with:

- `firstPublishedBucket`: set on the first successful publication, retained after it.
- `coverageFromTimestamp`: conservative first covered time, using the existing
  first-block timestamp + 1 convention; initialize on first publication only.
- `publishedThroughTimestamp`: last verified block timestamp for this publication.
- `publishedAt`: successful publication attempt time, alongside its revision.

Add market aggregation to the existing worker using already normalized events and
the same boundary context. Publish affected market rows, pool candles and progress
in the same transaction. No second collector, RPC fan-out, or request-time DuckDB
job is introduced. Include the market-aggregation policy version in the publication
revision. Never advance the marker while market rows are absent or from an older
publication.

The existing `nextBlock`, source revision and metadata revision remain authoritative.
No new coverage table or query-time S3 fetch is needed. Publish the fields in the
same transaction as candles/progress, including the first and no-trade ranges.
Retain the eight-input bound and budget 90 total serving rows per transaction,
including both pool candles and market buckets, plus the existing five metadata/
condition operations. Check `(poolCount + 1) * affectedBucketCount <= 90` before
publication; the previous pool-only count is insufficient. Verify default ranges
fit and preserve explicit reconciliation for oversized timestamp gaps. Do not
split market and pool publication into transactions that can disagree.

Do not infer first-bucket identity from `coverageFromTimestamp`: adding one second
can cross a bucket boundary. Store it explicitly. Preserve partial coverage when
decoding rejects events; archival coverage is not proof of complete decoded OHLCV.

At implementation start verify whether the history stack has been deployed. If it
has not, tighten the initial schema directly. If records already exist, stop before
claiming readiness and propose a bounded one-time reconciliation from verified
archives. Do not reset cursors or add a permanent missing-field compatibility path.

## Deployment ownership and authorization

Keep the reader Lambda in the history stack, with Node 24, 256 MiB as an initial
size, a ten-second timeout, and normal seven-day logs. Grant only DynamoDB `Query`
and `TransactGetItems` on the history table. It needs no S3, RPC secret, write,
DuckDB/native dependency, or new service token.

Reuse the existing API Gateway bearer authorizer. The handler relies on that
gateway boundary; no public Function URL or alternate unauthenticated route.
Scope Lambda invocation permission to the existing API's GET history route.
Do not duplicate token configuration into a second authorizer.

The bot stack owns the API and its authorizer; the history stack owns history
resources. Add non-secret bot-stack outputs for the API ID and authorizer ID.
The manual history workflow resolves those outputs alongside the existing
pool-state table output and passes them to CDK. In the history stack, create the
API integration and CUSTOM-authorized route against those IDs with payload v2.0.
Do not import/recreate the API domain, take ownership of the bot stack's stage,
or introduce a reverse CloudFormation dependency from Bot-prod to history.

Verify the existing stage auto-deploy behavior during synthesis/rehearsal. Leave
existing pool/quote/landing routes and their authorizer/cache settings unchanged.
No new route throttling policy or reserved API concurrency is required initially;
bounded request work is the first control, and API Gateway/account service limits
still apply. Add capacity tuning only with measured consumer demand.

Deployment order: merge prerequisites; deploy the bot stack's added outputs;
deploy the history stack with the producer metadata and reader route; verify the
first publication and authenticated endpoint. If the collector was already active,
preserve its exact starting block. API reads never start or extend collection.
The route is enabled by deployment, with no feature flag. Production dispatch
remains an explicit operator action.

## Implementation sequence and evidence

1. Define pure request/response types, validation and projection in the history
   module. Extract shared DynamoDB key helpers into a data-only module: importing
   worker storage currently pulls in the worker/analytics runtime. Keep the API
   bundle free of DuckDB, S3 clients and collector RPC dependencies.
2. Add market aggregation, publication metadata and transaction tests. Compute
   cross-pool quote-group OHLC directly from normalized trades, and test ordered
   executions across pools, mixed quote currencies, multi-pool transactions,
   partial/missing pools, rejected events and pool-universe changes. Verify initialization,
   subsequent publication, no-trade history, crashes and lost responses.
3. Implement the DynamoDB reader and API Gateway handler with injectable storage
   for tests. Exercise invalid/duplicate parameters, exact 288-bucket bounds,
   both views, unknown pools, missing/partial/no-trade buckets, token precision, page limits,
   storage failures, and publication races. Reject corrupt rows rather than
   coercing them into chart values.
4. Connect the existing local HTTP proof to the production validation/response
   contract. Keep analytical offline resolution helpers internal. Extend the
   DynamoDB Local rehearsal to run the actual reader over actual worker-published
   rows, compare candles with the raw/Parquet rebuild, and assert read-only behavior.
5. Add deployment wiring and workflow discovery. CDK assertions cover route method,
   authorizer, payload format, invocation permission, read-only table IAM, ordinary
   logs, and absence of monitoring resources. Import the real reader bundle under
   Node to detect accidental native dependencies. Run existing bot-route tests.
6. Record measured request count, consumed read units, response size and latency
   for empty, one-day, and concurrent-publication reads. Confirm no RPC calls, S3
   reads, writes, or scans occur on the API path. Publish concrete JSON fixtures and
   curl examples for the website's later server-side integration.

After deployment, verify missing/incorrect/correct credentials through the real
gateway, exact data equality with committed candles, honest initial coverage,
and recovery after a new worker publication. CI/local proofs do not replace this
AWS/IAM/domain check. Do not claim production readiness from synthesis alone.

## Assumptions to challenge during review

- Same-quote prices are a useful intermediate delivery, but do not fulfill the
  comprehensive-chart outcome. Historical conversion and liquidity valuation are
  required layers of this plan. All-venue/all-time coverage remains separately bounded.
- Gross venue turnover is the intended volume definition. Unique user/order flow
  requires separate attribution and cannot be inferred from summed pool candles.
- Five-minute candles and 24-hour windows are enough for the first consumer.
  Weekly/monthly views need follow-on materialized resolutions, not larger scans.
- The existing service credential is appropriate for server-side callers. Public
  browser requests need a separate access/cache decision.
- Every writer updates the publication marker; otherwise the consistency protocol
  is invalid. Strong reads cannot fix an untracked writer.
- Market and candle records fit the proposed page/response bounds. Validate the largest real
  atom/price strings and rejected-event cases, not only the small captured fixture.
- The decoder remains provisional until deployed ABI validation is complete.
  Expose that provenance instead of presenting coverage as verified financial truth.
- Publication timestamps represent chain coverage and successful processing, not
  a promise of current chain-head freshness or a fixed five-minute display delay.

After the market foundation works end to end, complete the conversion and liquidity
layers above within this plan. Resolve source and balance-accounting choices from
the route inventory and bounded rehearsal rather than assuming all required rates
already exist. Then add hourly/daily candles and retention
for longer chart windows. Backfill and the website UI remain independent follow-ons.
