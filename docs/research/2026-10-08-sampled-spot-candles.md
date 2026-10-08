# Restore spot candles without connector event indexing

The sampled endpoint retains each pool's price, volume and inventory, and adds
`candleMethod: pool-spot-events-at-bucket-end-rate` and a per-series nullable
`candle: {open,high,low,close,coverage}`. Currency remains ETH or USDC. These are
pool spot candles, not execution-price candles or a mixture of different pools.

V2/Solidly Sync events supply reserves; stable pools use the same invariant
marginal price as the reference sampler. Slipstream Swap/Initialize events supply
sqrtPriceX96. Token orientation and decimals use reviewed metadata. Fraction
arithmetic stays exact until the public decimal boundary. The prior bucket's
reference seeds the opening state when available; ordered state changes supply
extrema, and the current reference closes the candle. The current bucket's
conversion rate is applied to all four native prices. No additional RPC requests,
oracle data, connector event scans, or liquidity tick reads are introduced.

Coverage:
- `complete`: complete event archive, valid state prices and opening reference.
- `partial`: observed event prices and closing reference, but no opening state.
- `reference-only`: no trades or observed state changes; a flat closing-reference
  bar. This does not claim that conversion pools were flat during the bucket.
- `null`: missing/partial events, missing end price/conversion, unusable observed
  state or missing corresponding state events for recorded trades.

Quiet liquidity changes can produce real candles even with zero trades. Hollow
frontend candles indicate partial opening state. Gold dots retain closing spot
samples, including where no trustworthy candle can be constructed. All converted
candles exclude intrabucket changes in conversion pools. They are not exact
converted OHLC; the label states this limitation.

## Publication and rollout

Collection policy and raw observation namespace remain unchanged. New publication
uses a prior observation read (cached within the worker) and existing raw event
reads. Current immutable serving pages need recomputation; there is no need to
fetch chain history again or reset live collection.

`scripts/market-history/rebuild-sampled-candles.ts <local-output-directory>` is a
read-only production rehearsal using FAME_HISTORY_TABLE, FAME_HISTORY_BUCKET,
AWS_PROFILE and AWS_REGION. It writes local ETH.json and USDC.json fixtures and
checks every non-candle field against the currently published API before any
mutation. Its `--apply` mode requires operator authorization and revises the
existing window using content-addressed pages and publication-generation CAS.
Live appends retain their frontier; expired buckets are skipped. Identical
revisions are no-ops. Five publication conflicts stop resumably instead of
silently overwriting another writer. The fixed initial window bounds the run.

Rollout order: merge/deploy backend; run the approved candle rebuild; verify the
public contract in both currencies; then cut over the prepared frontend. The
frontend parser intentionally requires the candle contract, so it must not ship
before that rebuild. No frontend feature flag or old execution API fallback.

## Verification

Unit tests cover exact orientation/decimals, stable invariant, square-root prices,
state extrema versus execution amounts, fixed conversion, reference-only bars,
missing opening state and invalid/partial archives. The local DynamoDB rehearsal
covers atomic page revisions, stale generation rejection, idempotence, retained
native counts, unchanged collection cursor, unchanged forward publication
boundary and full 288-bucket reads. Production data is only read during rehearsal.

Read-only production rehearsal completed for 288 published buckets: 38 non-flat
candles across ETH and USDC (19 per currency), 2,842 reference-only bars, zero
partial/missing candles. All existing non-candle fields matched. Outputs are
ignored under `.market-history-local/spot-candles-v1/{ETH,USDC}.json`.

Validation: 178 backend/history tests (including three spot tests), TypeScript,
four deployment/import tests, and local DynamoDB transaction rehearsals. The
fls-www chart changes remain in its existing dirty checkout, preserving unrelated
swap work. Thirteen frontend tests, TypeScript, targeted ESLint, production build
and browser checks with the real rebuilt fixtures passed. Browser tests covered
currency/pool switching and mobile width; screenshots showed the non-flat candle
bodies. This is fixture-backed browser proof, not a deployed candle API claim.
