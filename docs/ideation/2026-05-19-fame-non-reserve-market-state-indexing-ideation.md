---
date: 2026-05-19
topic: fame-non-reserve-market-state-indexing
focus: next bite-sized society-bots + www indexing/cache capability for FAME DeFi quoting after constant-product reserve indexing shipped
mode: repo-grounded
---

# Ideation: FAME Non-Reserve Market-State Indexing

## Grounding Context

`society-bots` now owns the server-side FAME pool-state read model for `www`: a generated Base pool registry, a scheduled indexer Lambda, DynamoDB latest rows and cursor rows, an authenticated `POST /fame/pool-state` API, passive health signals, and rollout docs. Here `www` means the GitHub project `fame-lady-society/www`; on this machine, the companion checkout is `../fls-www`, not `../www`. The current shipped quote-model lane is intentionally narrow: constant-product reserve state for Uniswap V2, volatile Solidly/Equalizer, and volatile Aerodrome V2 pools.

The generated `www` registry currently contains 21 reviewed Base route-candidate pools: 7 quote-model reserve pools and 14 tracked-only pools. The remaining tracked-only universe is the useful shape of this ideation: 5 Aerodrome Slipstream pools, 4 Uniswap V3 pools, 3 Uniswap V4 pools, 1 stable Solidly pool, and 1 native wrap primitive. Twelve of the remaining pools are concentrated-liquidity pools.

The helper registry is not a pure copy of the broader `../fls-www` reviewed pool artifact. `../fls-www/src/features/fame-swap/artifacts/base-v1-pools.json` has 26 reviewed pool rows and currently includes six pool ids not present in the `society-bots` helper registry: `slipstream-spx-weth`, `slipstream-usdc-weth-migrating-50`, `slipstream-msusd-usdc-a`, `slipstream-weth-mseth`, `slipstream2-msusd-mseth`, and `slipstream2-msusd-usdc-c`. The helper registry also includes `native-wrap-weth`, which is a route primitive rather than a pool row in that broader artifact. This means the next slice should not add independent discovery in `society-bots`; it should make the generated `www` helper export declare the route dependencies and state surfaces that `society-bots` is allowed to index.

`www` remains authoritative for reviewed route metadata, venue capability, route validation, quote safety, parity tests, and public quote responses. `society-bots` should provide fast, fresh, well-attributed market state and cache services. Stale, unknown, unsupported, malformed, mismatched, or unavailable helper output must make `www` fall back to its live path.

Existing safety semantics should be preserved. Freshness is based on `observedThroughBlock` compared with the quote request's `currentBlock`, not on the last reserve-change block. Future-block helper rows are stale for an older quote context. `fresh`, `stale`, `unknown`, and `unsupported` are normal per-pool response statuses; malformed input, auth failure, incomplete DynamoDB reads, and dependency failures are transport-level failures.

`www` live route-lab already validates non-reserve quote/state paths: Uniswap V3, Uniswap V4, Slipstream, Slipstream2, Solidly stable `getAmountOut`, `slot0`/StateView pre-price, active liquidity evidence, and route simulation where needed. Indexed mode today only asks `society-bots` for reserve state and replays fresh V2-style reserves locally.

A recent Doppler live route-lab run made the latency shape concrete. At Base block `46212817`, a small USDC -> FAME case selected `uniswap-v3-usdc-weth-5bps` plus `uniswap-v2-fame-direct`; the optimizer evaluated 320 logical quote plans, made 180 unique exact quote reads, hit exact-quote cache 96 times, and did not use indexed pool state. The next slice should prove, in route-lab shadow mode, which candidate legs had fresh indexed market state, which live reads could have been avoided, and which stale/unsupported/unknown reasons still force fallback before production route behavior changes.

External grounding:

- Uniswap V3-style local quote state starts with `slot0`, active `liquidity`, current tick, tick spacing, tick bitmap words, and initialized tick liquidity data. Full tick capture can be expensive through normal RPC calls.
- Uniswap V4 has a similar concentrated-liquidity shape but uses `PoolId`/`PoolKey` plus StateView reads such as `getSlot0`, `getLiquidity`, tick bitmap, and tick info. Hooks and dynamic fees should stay conservative: cache observations or quoter outputs, but do not promise generic local replay.
- Slipstream is V3-like enough for a common concentrated-liquidity snapshot lane, but fee/tick-spacing metadata should come from `www` registry and validated adapter knowledge rather than inference.
- Generated registry metadata should declare the state surface for each exported route dependency: constant-product reserve, CLMM snapshot, stable shadow, deterministic native wrap, unsupported, or unknown. Quote receipts should carry registry provenance, but they are exact request artifacts rather than pool state surfaces. `society-bots` should not infer these capabilities from pool shape or overloaded unsupported reasons.
- Solidly/Aerodrome stable pools are closer to reserve indexing than CLMM replay, but their invariant is not constant product; they need reserves, decimals/normalization, stable flag, fee metadata, and `www` parity before promotion to a local quote model.
- Quoter caches are not pool state. They are exact amount/path/block/version artifacts and need explicit provenance, TTL, block validity, and live fallback.
- DynamoDB exact-key latest rows fit the next slice. TTL cache rows and short history rows are plausible later; Valkey, DAX, streams, and full analytics storage should wait for measured need.

Primary external sources:

- Uniswap V3 pool data: https://developers.uniswap.org/docs/sdks/v3/guides/pool-data
- Uniswap V4 pool data: https://developers.uniswap.org/docs/sdks/v4/guides/pool-data
- Uniswap V4 hooks: https://developers.uniswap.org/docs/protocols/v4/concepts/hooks
- Aerodrome liquidity formulas: https://github.com/aerodrome-finance/docs/blob/main/content/liquidity.mdx
- Aerodrome Pool implementation: https://github.com/aerodrome-finance/contracts/blob/main/contracts/Pool.sol
- DynamoDB condition expressions: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html
- DynamoDB read consistency: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html
- DynamoDB TTL: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html

## Topic Axes

- Concentrated-liquidity latest state
- Stable-pool state
- Quoter and route-level cache
- Freshness/history/API semantics

## Ranked Ideas

### 1. Concentrated-Liquidity Snapshot State

**Description:** Add a typed latest-state lane for Slipstream, Uniswap V3, and Uniswap V4 pools that stores header-level concentrated-liquidity state: pool address or V4 pool key/id, token identity, venue family, fee/tick-spacing metadata from the `www` registry, `slot0`/StateView price, current tick, active liquidity, `observedThroughBlock`, source, and registry id. Require the generated `www` helper registry to declare each indexed pool's state surface before the collector reads it; broader reviewed pools that are not exported as route dependencies remain out of `society-bots` scope. Do not index tick bitmaps or initialized ticks in this first bite, and do not claim local CLMM quote replay. `www` consumes the row as fresh market-state evidence and still calls its validated quoter/live adapter for output safety when needed.

**Axis:** Concentrated-liquidity latest state

**Basis:** `direct:` the registry has 12 tracked-only concentrated-liquidity pools, while `www` live route-lab already reads `slot0`, V4 StateView, and active liquidity evidence for these families. `external:` Uniswap V3/V4 pool-data docs identify price, current tick, liquidity, and tick data as the offchain state ladder; the header fields are the smallest common first rung.

**Evaluation:** This unlocks faster route preflight, price-impact pre-state, route-lab coverage, and pool-health checks for the largest remaining pool family. It supports real-time quoting indirectly, not by producing final CL quotes, and it starts historical chart capture because price/tick/liquidity snapshots are chartable. `www` can safely consume it by accepting only matching `sourceRegistryId`, matching pool identity, `observedThroughBlock <= currentBlock`, and a strict freshness bound; otherwise it falls back live. DynamoDB can use the existing table with `pk=pool:<chainId>:<poolAddress-or-poolKey>` and `sk=clmm-snapshot-v1#latest`, plus a cursor keyed by lane. The API should return typed entries such as `stateKind: "clmm-snapshot-v1"` with `status: "fresh" | "stale" | "unknown" | "unsupported"`. The indexer shape is a sibling scheduled collector that batch-reads V3/Slipstream pool contracts and V4 StateView at one safe block. Acceptance should include route-lab shadow coverage by registry id, venue family, state surface, freshness status, unsupported reason, and live-read-avoidability before production quote behavior depends on these rows. It sets up active tick-window indexing, CL price/liquidity charts, and later local replay. It should be the next bite because it covers 12 pools with a small, shared, non-authoritative state contract.

**Downsides:** It does not by itself eliminate quoter calls for final CL output. V4 hooked or dynamic-fee pools need explicit capability flags so the row is never overinterpreted. It adds a second state lane and API type before there is full local quote parity.

**Confidence:** 92%

**Complexity:** Medium

**Status:** Unexplored

### 2. Exact Quote Receipt Cache

**Description:** Add a short-lived cache for `www`-validated quote receipts keyed by exact route or leg identity, token direction, amount in, block context, source registry id, quoter/adapter version, and quote mode. `www` remains the writer and safety authority: it can populate the cache after a live validated quote or request a cache hit before falling back live. `society-bots` stores the receipt, provenance, TTL, and validity block, but does not compute the quote.

**Axis:** Quoter and route-level cache

**Basis:** `direct:` `www` already validates live V3/V4/Slipstream/Solidly stable quote paths, and current `www` optimizer caches only within a single request. `external:` quoter outputs are amount/path/block-specific artifacts, not reusable pool state.

**Evaluation:** This is the most direct sub-1s latency lever for repeated quote requests, especially CLMM and V4 cases where generic local replay is intentionally not bite-sized. Required data is exact key material, `amountIn`, `amountOut`, selected route/leg ids, quote context block, `sourceRegistryId`, adapter/quoter version, source type, dependencies, expiry, and optional evidence summary. It supports real-time quoting more than historical charts; history value is secondary through hit/miss and receipt audit logs. `www` consumes it only when the exact request, registry id, quote version, block/freshness window, and route safety rules match; malformed or stale receipts fall back live. DynamoDB shape can be `pk=quote:<registryId>:<quoteKeyHash>`, `sk=receipt-v1`, with an `expiresAt` TTL attribute and conditional writes from `www`. The API shape should be separate from pool state or typed inside a batch market-state v2 response. It sets up cache hit-rate measurement, single-flight leases, route-level cache warming, and support for V4 hooks without modeling them. It should not be the first slice if the team wants durable market-state/charts before quote cache behavior; otherwise it is the fastest visible latency win.

**Downsides:** Exact-key caches can have poor hit rates if amounts vary heavily. It introduces write-back behavior from `www` to `society-bots`, which is a new cross-repo contract. It must be carefully labeled as a receipt, not quote authority.

**Confidence:** 86%

**Complexity:** Medium

**Status:** Unexplored

### 3. Stable Solidly Shadow State

**Description:** Promote the single stable Solidly pool from opaque `tracked-only` to a `stable-shadow-v1` latest-state lane that stores reserves, token decimals or normalization metadata, stable flag, fee metadata, `observedThroughBlock`, and source registry id. Keep stable quote math and parity in `www`; `society-bots` only provides fresh inputs and attribution until route-lab proves local stable replay. This is a contained bridge between reserve indexing and non-reserve quote models.

**Axis:** Stable-pool state

**Basis:** `direct:` the registry has exactly one stable Solidly tracked-only pool, `scale-equalizer-usdc-frxusd`, and current docs explicitly exclude stable math from `society-bots`. `external:` Aerodrome/Solidly stable pools use a different invariant from constant product and require normalized reserve math.

**Evaluation:** It unlocks a small real-time solver capability: `www` can attempt stable math or compare against live `getAmountOut` using fresh indexed inputs, while falling back live until parity is established. It can support charts for stable pool reserves and implied price, but it is less chart-rich than CL snapshots. Required data is reserves, token decimals or decimal multipliers, stable flag, pool fee, pool identity, block, source, and registry id. `www` consumes it as `shadow` or `inspectable`, not final quote-model state, unless the registry and route-lab later promote it. DynamoDB can reuse reserve latest-row patterns with `sk=stable-shadow-v1#latest`; the indexer can extend the existing getReserves reconciliation to include stable pools plus metadata validation. It sets up stable quote-model promotion and expands the typed market-state API. It is tempting as the next bite because it is only one pool and close to existing code, but it should rank below CL snapshots because it covers much less of the remaining FAME universe.

**Downsides:** Small coverage gain. It risks looking easier than it is if local stable math is rushed. It may distract from the larger CLMM state surface that route-lab already uses heavily.

**Confidence:** 82%

**Complexity:** Low-Medium

**Status:** Unexplored

### 4. Typed Market-State Batch API v2

**Description:** Introduce a typed batch response that can carry multiple market-state kinds in one authenticated call: `constant-product-reserves-v1`, `clmm-snapshot-v1`, `stable-shadow-v1`, `native-wrap-v1`, and `quote-receipt-v1`. Each entry has explicit `stateKind`, freshness, source registry id, block attribution, support level, and fallback semantics. This turns the existing reserve-only helper into an incremental market-state API without making `society-bots` a quote service.

**Axis:** Freshness/history/API semantics

**Basis:** `direct:` the current API already has per-pool statuses, registry identity, producer freshness bounds, and fallback-safe transport semantics. `reasoned:` adding non-reserve lanes without typed entries would blur incompatible guarantees across reserves, CL snapshots, quote receipts, and deterministic wrap legs.

**Evaluation:** It unlocks safer `www` consumption rather than a new solver algorithm: `www` can ask once for all route dependencies and decide per entry whether to quote locally, use a receipt, call live, or reject. It supports real-time quoting and is a foundation for later historical/chart APIs, but it is mostly a contract shape. Required data depends on each state kind; the shared envelope is the important slice: `stateKind`, `status`, `supportLevel`, `observedThroughBlock`, `sourceRegistryId`, `currentBlock`, reason codes, source reader, raw primitive fields, and derived summary fields. `www` can safely consume this by exhaustively switching on `stateKind` and treating unknown kinds as live fallback. DynamoDB can stay lane-specific while the API joins exact-key rows into one response. It sets up every other idea on this list and prevents accidental overloading of `unsupported`. It should be built with the first new lane, not as an abstract API-only project.

**Downsides:** If built alone, it produces little latency value. It requires coordinated type updates in `www`. The v2 envelope must stay small enough that it does not become a generic market-data platform prematurely.

**Confidence:** 88%

**Complexity:** Medium

**Status:** Unexplored

### 5. Block-Cohort Freshness Receipts

**Description:** Add response-level and per-entry freshness receipts that summarize market-state coherence: requested `currentBlock`, service safe head, effective freshness bound, min/max `observedThroughBlock`, source registry id, lane, status counts, and explicit stale reason. For multi-pool routes, `www` can quickly determine whether all helper state belongs to an acceptable block cohort or whether live fallback is required.

**Axis:** Freshness/history/API semantics

**Basis:** `direct:` the current reserve API already depends on `observedThroughBlock` and caller `currentBlock`; broader routes will mix reserve, stable, CL, wrap, and quote-cache data unless coherence is made explicit.

**Evaluation:** It unlocks faster and safer route validation, not quote math. Required data is mostly metadata already present or planned: per-entry observed block, lane cursor, service head/safe head, requested block, freshness bound, and reason codes such as `ahead-of-current-block`, `beyond-freshness`, `registry-mismatch`, or `partial-read`. It supports real-time quoting and operational diagnostics; history only appears when receipts are retained. `www` can consume it by enforcing either strict same-cohort rules for sensitive paths or looser max-lag rules for preview paths, always with live fallback. DynamoDB shape is unchanged; API aggregation logic computes receipt summaries from exact-key rows. The same status counts should feed a graduation queue for tracked-only pools: tracked, fresh, stale, missing, unsupported, cache-backed, and quote-ready by registry id, venue family, state surface, and missing primitive or parity gap. It sets up market-state snapshots, route-lab evidence, and later cache invalidation. It should accompany any non-reserve lane because block alignment becomes harder as state kinds multiply.

**Downsides:** It is enabling infrastructure, not a standalone user-visible latency win. Overly strict cohort rules could increase live fallback frequency. The receipt vocabulary needs careful tests so it does not become another ambiguous status layer.

**Confidence:** 90%

**Complexity:** Low-Medium

**Status:** Unexplored

### 6. Active Tick-Window Cache

**Description:** After header-level CL snapshots, index a bounded window of tick bitmap words and initialized tick info around each concentrated pool's current tick. Label it as partial state with explicit window bounds and observed block. `www` can use it for route-lab experiments, shallow quote prechecks, liquidity-depth charts, or local replay only when the requested trade stays inside the indexed window.

**Axis:** Concentrated-liquidity latest state

**Basis:** `external:` Uniswap V3-style local replay needs tick bitmap and initialized tick liquidity data, and fetching all ticks can be expensive. `reasoned:` common FAME quote sizes often interact with liquidity near the active tick before crossing far-away ranges, so a bounded window is a plausible incremental ladder.

**Evaluation:** It unlocks eventual local CL solver capability for small or bounded quotes and improves liquidity-depth charting. Required data is current tick, tick spacing, bitmap word range, initialized tick indexes, `liquidityGross`, `liquidityNet`, window bounds, observed block, and source registry id. It supports both real-time quoting and historical charts if snapshots are retained. `www` consumes it only when the quote path can prove the simulated swap remains inside the indexed window; otherwise it falls back live. DynamoDB can store a latest window row per pool plus optional chunk rows keyed by pool and bitmap word. The indexer must read around the safe-block active tick, not full history. It sets up local V3/Slipstream replay and richer charts. It should not be the immediate next bite because the header snapshot is a cleaner prerequisite and safer API contract.

**Downsides:** More protocol-specific and easier to get wrong than header snapshots. The window-size policy may be contentious. V4 hooks and dynamic fees can still prevent local quote authority even with tick data.

**Confidence:** 74%

**Complexity:** High

**Status:** Unexplored

### 7. Short-TTL State-Hash Journal

**Description:** Keep each accepted latest row append-ready by using a consistent observation envelope: pool or quote key, source registry id, chain id, observed block, source reader, state kind, raw primitive fields, derived summary fields, state hash, status counts, source, and expiry when applicable. Optionally write compact history rows whenever a latest state or quote receipt changes, but keep this as a short TTL diagnostic/journal table pattern, not a full analytics backfill. Use it for route-lab evidence, cache invalidation debugging, freshness charts, and measuring whether a heavier history system is justified.

**Axis:** Freshness/history/API semantics

**Basis:** `direct:` there is no historical capture today, while rollout already requires smoke/soak evidence and non-regressing `observedThroughBlock`. `reasoned:` a small state-hash journal gives enough temporal signal for debugging and charts without changing the quote hot path.

**Evaluation:** It does not directly unlock faster quotes, but it improves solver confidence and cache operations by explaining why helper state changed or fell back live. Required data is the shared observation envelope plus a hash of each state payload, status, write time, and TTL when retained. It supports historical charts in a limited near-term sense and provides evidence for future comprehensive charts. `www` does not need it on the quote hot path; route-lab or operator tooling can query diagnostics, while live fallback remains unchanged. DynamoDB can add `sk=history#<stateKind>#<observedBlock>#<hash>` rows under existing pool keys or a separate partition prefix, with TTL for retention. It sets up DynamoDB Streams/S3/analytics later if the history proves useful. It should trail the first real state/cache lane, not precede it.

**Downsides:** Operational value can be overestimated if nobody inspects it. It adds write volume. It is not a substitute for a real time-series or charting system.

**Confidence:** 78%

**Complexity:** Low-Medium

**Status:** Unexplored

## Recommendation

The next bite-sized chunk should be **Concentrated-Liquidity Snapshot State**, implemented together with the minimal pieces of **Typed Market-State Batch API v2** and **Block-Cohort Freshness Receipts** needed to consume it safely. That slice advances the largest remaining pool surface without importing CL quote authority into `society-bots`.

The scope boundary is important: this first slice includes the generated registry state-surface declaration needed by CL snapshots, the `clmm-snapshot-v1` latest rows, the minimum v2 response entries and freshness receipt fields needed to read those rows safely, and route-lab shadow coverage that proves fresh/stale/unsupported/cache-eligible/live-read-avoidable outcomes. It explicitly defers exact quote receipts, stable shadow state, active tick windows, short-TTL journals, full historical analytics, and production quote-path reliance until the CL snapshot lane has evidence.

The strongest next-after or parallel latency feature is **Exact Quote Receipt Cache**. It is the fastest route to sub-1s repeat quotes, but it introduces a new write-back contract from `www`; it should either follow CL snapshots or be scoped as a separate `www`-validated cache experiment with route-lab hit-rate evidence.

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Full CLMM tick universe indexing | Too large for the requested bite-sized slice; header snapshots and active tick windows are safer increments. |
| 2 | Generic V4 local replay | V4 hooks, dynamic fees, and custom accounting make generic local replay unsafe without explicit modeling and parity tests. |
| 3 | CL evidence gate rows as standalone work | Useful rollout metadata, but it belongs inside route-lab proof or typed state entries after a CL lane exists. |
| 4 | Route validation cache, quote live | Duplicates route-lab/registry evidence unless attached to exact quote receipts or route dependency manifests. |
| 5 | Route-state dependency manifest | Promising later, but it risks duplicating `www` route authority before state/cache demand is proven. |
| 6 | Map-routing route tile cache | Interesting analogy, but route topology is already generated and owned by `www`; not the next society-bots state slice. |
| 7 | Native wrap deterministic state as the next chunk | Correct and low-risk, but too small to materially improve quote latency or market-state coverage by itself. |
| 8 | Stable `getAmountOut` evidence cache | Mostly a narrower form of exact quote receipts; keep the stable-specific version only if stable shadow state is chosen. |
| 9 | Cache miss lease / single-flight live quotes | Good operational enhancement for quote receipts, but not useful before the receipt cache exists. |
| 10 | Valkey, DAX, or MemoryDB cache tier | Premature until DynamoDB/API latency and quote-cache hit rates prove the need. |
| 11 | DynamoDB Streams to full historical charting | Strategically aligned but too broad; start with latest rows and optional short-TTL hash history. |
| 12 | Public market-state/chart API | Future product surface, not the next internal quoting/cache capability. |
| 13 | Independent pool discovery in society-bots | Violates the authority split; `www` remains source of reviewed route-candidate metadata. |
| 14 | Promote stable Solidly directly to quote-model | Needs `www` stable math parity first; shadow state is the safer bite. |
