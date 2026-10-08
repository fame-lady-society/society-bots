# FAME-balance-weighted market index

Market is one blended series, with individual pools available through radio
selection. Its price is the sum of each converted pool spot price times its share
of the tracked pools' FAME balances. This is an inventory-weighted index, not an
executable quote or a measure of active liquidity depth.

## Method and assumptions

`market.method = fame-balance-weighted-spot-v1` accompanies `price`, nullable
`candle`, `coverage`, `weights`, `weightTimestamp`, and `missingPoolIds` on each
sampled-market bucket. Existing pool series and market totals remain unchanged.

Weights use the preceding bucket-end FAME balances, which describe the state at
the opening boundary. All pools hold the same FAME token, so atomic balances are
comparable without rounding. Weights stay fixed through the bucket and rebalance
at the next boundary. Consequently, changing inventory composition can change
the index between buckets even without a price change. This is deliberate and
must not be presented as the return of a self-financing portfolio.

Each pool's native opening spot price seeds the state. Direct pool spot events
are merged in block/log order. After each event, the weighted price is recomputed;
OHLC comes from that synchronized path. Averaging separately computed pool highs
and lows would invent extrema when pool peaks occur at different times. Closing
snapshots share one boundary and are applied together. No-event buckets show a
flat closing reference bar. Conversion routes use the current bucket's closing
rates throughout, including the opening price. These candles therefore exclude
intrabucket connector movement; they are not exact execution-time converted OHLC.

Unknown weights or unavailable closing prices/routes for positive-weight pools
make the market index unavailable rather than silently dropping and reweighting
those pools. Known zero-weight pools do not affect the index. Zero total weight
is unavailable. Missing opening state or incomplete/invalid direct event history
allows a closing price but no candle (`price-only`). Market activity totals remain
independent: a zero-weight pool can trade without moving the index. The first-ever
observation has no preceding balance snapshot and thus no index price.

FAME balances include inactive concentrated-liquidity inventory. They are the
user-selected weighting proxy, not executable depth. Reviewed pool membership
and reliable conversion routes still matter; an inventory-weighted price is not
manipulation resistant. Adding a pool requires the existing reviewed registry
and historical observation/rebuild process, not frontend aggregation.

## Cost and rollout

No extra RPC, oracle backfill, connector event scan, or liquidity tick read.
Existing archived direct-pool events and preceding/current observations supply
all inputs. Event replay adds bounded CPU and an in-memory event list; arithmetic
stays exact until the public decimal boundary. Public pages add small index
metadata, not raw event lists.

1. Merge and deploy the backend normally. Live publication then adds `market`.
2. With operator authorization, run `rebuild-sampled-candles.ts <output> --apply`
   against the production table/bucket to republish the existing window. The
   default mode is read-only. It checks all prior non-derived-index/non-candle
   fields, preserving pool prices, execution counts, volume and inventory.
   Existing publication CAS/idempotence and expiry handling apply; live collection
   and its cursor remain separate and unchanged.
3. Verify both currencies through the public API: every published bucket has the
   market contract, quiet buckets have reference prices, and activity totals match.
4. Deploy the prepared fls-www consumer. Its strict parser requires the new market
   fields; shipping it before republishing would reject older pages. No feature
   flag or obsolete API fallback is introduced.

## Local evidence

Read-only rebuild of 288 production buckets completed in 118 seconds. Both
currencies had all 288 market prices available and 11 non-flat composite candles.
Existing per-pool candles and all protected fields matched the published window.
No production writes were made. Fixtures are ignored under
`.market-history-local/blended-market-v1/{ETH,USDC}.json`.

Tests cover synchronized extrema, unequal weights, quiet conversion movement,
missing weights/routes/openings, partial coverage, zero weights, and duplicate
chain positions. The complete history suite passed 183 tests. Frontend tests use
these rebuilt fixtures, render the Market default and radio controls, and preserve
explicit gaps and independently reported market totals.

TypeScript and targeted ESLint passed. Fourteen frontend tests and fixture-backed
Chrome checks passed (Market default, pool radios, ETH/USDC switching and mobile
width), with no page errors. Local DynamoDB publication/replay rehearsals passed,
including stale writers, lost responses, full-window reads, and unchanged live
cursors. These checks do not establish deployed availability.
