---
title: "FLS WWW handoff: FAME candles and volume"
date: 2026-10-07
status: ready-for-implementation-planning
producer: society-bots
consumer: fls-www
---

# FAME market chart implementation handoff

## Outcome and scope

Build a comprehensive FAME market chart in `fls-www`: five-minute candlesticks,
a USD/ETH switch, and trading volume below on a shared time axis.

The existing history API supports this view today. The chart must work with the
currently recorded history and automatically benefit when coverage is extended.
This handoff is documentation, not implementation or deployment.

Suggested placement: `/fame/chart`, linked from `/fame`, with the chart feature
isolated so it can later be embedded. Confirm navigation placement during UI work.
Do not require a connected wallet to view public market data.

## Verified integration context

Inspected `society-bots` main baseline `26951d1` and `fls-www` checkout `74c1aab`.
Recheck relevant heads and repository instructions before implementing.

`fls-www` uses Next.js 16, React 19, TypeScript and TanStack React Query already.
No financial chart package was found in its package manifest. Reuse existing UI,
query and formatting conventions rather than introducing another application layer.
Useful existing files:

- `src/app/fame/page.tsx`: current landing and layout integration.
- `src/app/api/fame/market-prices/route.ts`: public server-side market read and cache
  pattern; use as a reference, not as the history endpoint.
- `src/features/fame-swap/server/quoteService.ts`: existing server-only
  `FAME_POOL_API_URL` / `FAME_POOL_STATE_SERVICE_TOKEN` configuration.

Read-only production probe on 2026-10-07 returned HTTP 200 for a 24-hour request:
288 buckets, 251 complete, two partial, 33 `before-history-start`, two
`not-yet-published`; 24 gross pool executions and 11 buckets with ETH/USD prices.
Recorded coverage began 2026-10-06 20:25:16 UTC and reached 2026-10-07 17:26:19 UTC;
publication time was 17:44:13 UTC. These are a dated snapshot, not a freshness SLA.

## Chart library recommendation

Use the direct TypeScript API of **TradingView Lightweight Charts**, current v5
API family; verify and pin the released package version when installing. Its
candlestick and histogram series and native panes cover the main chart and volume
with a shared time scale. Use one chart instance: candle pane 0, volume pane 1.
Official examples document `chart.addSeries(HistogramSeries, options, 1)`.
[Pane guide](https://tradingview.github.io/lightweight-charts/tutorials/how_to/panes).

It is Apache-2.0 licensed with attribution requirements. Retain LICENSE/NOTICE and
the required TradingView link; leaving the attribution logo enabled satisfies the
link requirement, not every distribution obligation.
[Repository and attribution](https://github.com/tradingview/lightweight-charts),
[license](https://github.com/tradingview/lightweight-charts/blob/master/LICENSE).

Use the library directly without a second chart package or an unreviewed React
wrapper. React owns controls and legends; the chart owns its canvas and series.
Create once on client mount, resize with its container, and remove observers,
subscriptions and the chart on unmount. Validate Strict Mode remounts and avoid
recreating the chart or resetting zoom on each refresh.

## Layout and interactions

```text
FAME market        USD | ETH       1h  6h  24h      Updated / coverage
+---------------------------------------------------------------+
| OHLC / VWAP / selected time                                    |
|                                                               |
|    five-minute candles                              price     |
|                                                     scale     |
|                                                               |
+---------------------------------------------------------------+
|    volume histogram (same timestamps and horizontal zoom)      |
+---------------------------------------------------------------+
| time axis                 covered pools / publication time     |
```

Default USD, 24-hour window, five-minute interval. Currency changes update prices
and volume units together without resetting time selection.
Use price per **one FAME**, not per million tokens or per NFT. Format small prices
with meaningful significant digits; ETH candles must not all display as 0.00.

Crosshair tooltip shows timestamp/timezone, OHLC, converted volume, VWAP, execution
count and coverage/conversion status.

Volume colors may follow candle direction, not claimed buy/sell aggressor volume.
Use neutral styling when direction is absent. Partial coverage/conversion must be
identifiable by text or a pattern, not color alone. On narrow screens retain the
volume pane and legible axes. Supply an accessible text/table summary and
keyboard-operable currency/range controls; the canvas alone is insufficient.

## Existing history API: ready now

Upstream: `GET https://api.fame.support/fame/history`

```text
?view=market&resolution=300&from=<unix seconds>&to=<unix seconds>
```

`from` is inclusive, `to` exclusive; both must align to 300 seconds. Maximum
request span is 288 buckets / 86,400 seconds. First version uses one bounded request
for 1h/6h/24h; no unbounded scrolling fetches or 7d/30d controls yet. Pool drilldowns
exist with `view=pool&pool=<registry-id>` but are not required for the initial
comprehensive chart.

Use `end = floor(nowSeconds / 300) * 300`, `from = end - windowSeconds` for the
initial closed-wall-clock window. This still contains unpublished buckets because
collection follows finalized blocks. Show `publishedThroughTimestamp` separately
from response fetch time; do not claim real-time prices.

Response contains `schema: fame-history-api-v1`, `view`, bounds, `resolution`,
`chainId`, `scopeId`, `semantics`, `valuation`, `decimals`, `pools`, `progress`, and
**`buckets`** (not `candles`). Producer source of truth:
`src/fame-market-history/api.ts`, `valuation.ts`, `market.ts` and their tests.
Copy a reviewed public response type/validator into the consumer; do not import
producer AWS, DuckDB or server-runtime modules into the website.

| Chart datum | Response source | Meaning |
|---|---|---|
| Time | `bucket.timestamp` | Unix seconds; bucket start |
| Candle | `bucket.prices.find(p => p.currency === currency)` | Converted OHLC for executions across included pools |
| Volume | selected price row's `volume` | Gross execution notional in selected ETH/USD currency |
| VWAP | selected price row's `vwap` | Volume-weighted execution price per FAME |
| Completeness | `bucket.coverage`, price row `status` | Event coverage and FX availability are separate |
| Unpriced data | `unpricedBaseVolumeAtoms`, `unpricedTradeCount` | Excluded from converted price/volume |
| Progress | `progress.publishedThroughTimestamp`, `publishedAt` | Covered chain time versus publication time |

Converted ETH/USD OHLC/VWAP/volume values are **decimal strings**,
for example `"0.000224300955438316"`; do not divide them by 10^18 again.
`*Atoms` fields are integer strings and need the relevant token decimals. Keep
strings/BigInt for totals and tooltip precision; convert once to finite numbers at
the rendering boundary. Reject malformed/overflow values and validate OHLC order.
Never use native quote-group OHLC as the unified USD/ETH market series or sum the
market row and its pool contributions together.

Data handling requirements:

- Missing buckets can omit `prices` entirely. Render whitespace,
  with `before-history-start` or `not-yet-published` explanations as appropriate.
- A fully covered zero-trade bucket may have null OHLC and zero volume even when
  price status is `complete`. Keep a candle gap and a known-zero volume value.
- Never manufacture flat candles or replace missing/unavailable values with zero.
- Partial price rows represent only priced executions: show available values with
  an explicit partial label and unpriced counts/amounts. Do not label their volume
  as complete market turnover.
- Scope is the configured five pools, not every FAME venue. Gross execution volume
  can include multiple pool legs of one transaction; it is not unique wallet volume.
- Poll approximately every 60 seconds while visible, using existing React Query;
  pause in background, cancel obsolete requests and bound retries. Refresh enough
  of the requested range to pick up rewritten boundary buckets/backfill. Replacing
  288 points is acceptable if viewport/crosshair intent is preserved.
- Show loading, empty/no-trades, unavailable, stale and partial separately. Keep
  last good data on transient errors with its original timestamp and error state.
  `503 history-not-ready` is not an empty successful chart; `history-updating` can
  retry briefly. Authentication/configuration errors are server diagnostics.

## Server proxy and secret handling

Add a narrow Next.js route, proposed `/api/fame/history`, backed by a server-only
history client. Browser requests go to that route, never to the service with its
bearer token. Use configured upstream base URL and `FAME_POOL_STATE_SERVICE_TOKEN`.
Local Doppler is project **fls**, config **dev**, explicitly not `dev_personal`.
No secret values, NEXT_PUBLIC token, forwarded incoming authorization, arbitrary
upstream URL, or upstream raw error body may reach the browser or logs.

Validate allowed query fields/ranges before forwarding, allowlist the upstream
host/configuration, use a finite timeout and bounded response size, and return only
the reviewed market response contract. Reuse existing public-route throttling and
cache conventions. A short shared cache (~30–60 seconds) is appropriate for public
market data; errors are no-store. Do not cache historical windows permanently:
backfill or future repairs can change them. Client data fetching must not call RPC,
S3 or DynamoDB directly. No wallet session is necessary for this public read.

## Implementation and acceptance

`fls-www`: server history client/proxy, runtime contract validation, chart adapter,
React chart lifecycle, currency/range controls, volume pane and
responsive/accessibility behavior. Suggested new module `src/features/fame-chart/`
and `src/app/fame/chart/page.tsx`; adapt to current conventions during implementation.

Tests and proof required before release:

1. Adapter tests with real sanitized API fixtures: null/missing rows, zero trades,
   partial FX, tiny ETH prices, large atom strings, unsorted/duplicate timestamps,
   OHLC integrity, and correct selected-currency volume units.
2. Proxy tests for credentials staying server-side, query/range validation,
   upstream timeout/503/auth failures, bounded payloads and cache behavior.
3. Chart lifecycle and browser checks: initial load, USD/ETH switching, zoom/pan,
   crosshair alignment, sparse candles, refreshed last buckets, no viewport reset,
   Strict Mode remount, resizing/mobile, keyboard and screen-reader summary.
4. Production read-only acceptance: authenticated upstream through the website
   proxy, real nonzero candles and volume, publication time/coverage visible,
   errors visibly distinct from empty data. Check browser console and network for
   secret exposure. Local rendering alone is not production proof.

## Existing API smoke command

Run from any directory with Doppler access. Requests a closed 24-hour wall-clock
window, which can still include unpublished finalized-history buckets.

```sh
doppler run --project fls --config dev \
  --only-secrets FAME_POOL_STATE_SERVICE_TOKEN --no-fallback -- sh -eu -c '
  : "${FAME_POOL_STATE_SERVICE_TOKEN:?Missing API token}"
  end=$(( $(date +%s) / 300 * 300 ))
  printf "Authorization: Bearer %s\n" "$FAME_POOL_STATE_SERVICE_TOKEN" |
    curl --silent --show-error --fail-with-body --max-time 30 \
      --header @- \
      "https://api.fame.support/fame/history?view=market&resolution=300&from=$((end - 86400))&to=$end"
'
```

Producer documentation: [history API and operations](../fame-market-history.md).
Separate, still planning-only work: [backfill plan](../plans/2026-10-06-001-feat-market-history-backfill-plan.md).


## Bucket reference prices (implemented, pending backend deployment)

Market responses now always include `referencePolicy` (revision, designated pool
IDs/addresses, ETH/USD feed and maximum source age) and `referenceProgress` (null
until activation, then `startTimestamp`, `publishedThroughTimestamp`, `revision`).
Before the first publication, the latter two fields are null; buckets at or after
activation are `not-yet-published`, while older buckets are `before-reference-start`.
Each market bucket has `reference` with method `designated-pool-spot-with-asof-fx`,
policy revision, sampled block/hash/time, oracle round/time, and `values`:

| Field | Whole-asset units |
| --- | --- |
| `fameEth` | ETH per FAME (WETH represents ETH) |
| `ethUsd` | USD per ETH, Chainlink as-of round |
| `ethUsdc` | USDC per ETH, designated pool spot |
| `fameUsd` | USD per FAME |
| `fameUsdc` | USDC per FAME |

Each value is `{ value: string|null, status: "available"|"unavailable", reason: null|string }`.
Strings have 18 decimal places. Reasons are `before-reference-start`,
`not-yet-published`, `stale-source`, or `source-unavailable`. Availability can differ
between fields: a stale USD oracle does not remove healthy USDC prices.

Use the selected FAME reference as a separate line series or point value. It can
move when there were no FAME trades. Preserve existing trade candles and bottom
volume bars; never turn reference points into fabricated execution OHLC or volume.
Label USD and USDC distinctly. ETH/USD is oracle-derived and changes at the
oracle's cadence; ETH/USDC is a pool spot observation. These are finalized bucket
close samples, not an instant ticker, executable quote, or cross-pool consensus.
Render unavailable values as gaps and use reference progress separately from trade
progress. Historical buckets before activation have no reference samples until an
explicit future refill. The website proxy still performs no on-chain work.
