---
date: 2026-05-20
topic: slipstream-usdc-weth-100-cl-replay
focus: first fully indexed replayable Slipstream CL pool for FAME quoting
mode: repo-grounded
---

# Ideation: Replayable Slipstream USDC/WETH Pool

## Grounding Context

`society-bots` now owns the server-side FAME pool-state read model. Its current concentrated-liquidity lane is intentionally a head snapshot: pool identity, fee metadata, tick spacing, `sqrtPriceX96`, current tick, active liquidity, source, source registry id, and `observedThroughBlock`. The docs explicitly say this is not local CL replay authority and does not include tick bitmap/window data.

`slipstream-usdc-weth-100` is already present in `society-bots` as an address-backed Slipstream pool at `0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59`, with WETH as `token0`, USDC as `token1`, `tickSpacing: 100`, and `stateSurface: "cl-head-snapshot"`.

`www` is behind the `society-bots` registry contract: its generator still emits schema v1, marks CL pools as tracked-only with `unsupportedReason: "concentrated-liquidity"`, does not request `stateSurfaces`, and its indexed client/parser only accepts constant-product reserve rows. Its live Slipstream adapter already has the right execution authority: it reads `slot0`, reads active liquidity as evidence, calls the live Slipstream quoter, and owns route attribution and fallback.

External grounding points to a clear replay shape. Slipstream is Uniswap V3-like enough to use the V3 swap loop model: find next initialized tick from bitmap, run exact integer `SwapMath`, cross ticks by applying `liquidityNet`, and produce `amountOut`, `sqrtPriceX96After`, and initialized ticks crossed. The important Slipstream-specific wrinkle is dynamic fee: the replay state must include the exact fee value and source observed at the same block, not just the registry `feeBps` float.

Relevant sources:

- Uniswap V3 whitepaper: https://blog.uniswap.org/whitepaper-v3.pdf
- Uniswap V3 pool data guide: https://developers.uniswap.org/docs/sdks/v3/guides/pool-data
- Uniswap concentrated-liquidity concepts: https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity
- Uniswap V3 core source: https://github.com/Uniswap/v3-core
- Uniswap V3 quoting guide: https://developers.uniswap.org/docs/sdks/v3/guides/swapping/quoting
- Aerodrome Slipstream source/spec: https://github.com/aerodrome-finance/slipstream
- DynamoDB sort-key versioning: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-sort-keys.html

## Topic Axes

- Indexed CL state acquisition and maintenance
- DynamoDB and API contract
- Quote replay math ownership
- Freshness, invalidation, and fallback
- Validation, rollout, and telemetry

## Recommendation

Build one production-safe vertical slice: a same-block full replay capsule for `slipstream-usdc-weth-100`, served as raw `cl-replay-v1` state from `society-bots`, consumed by a `www`-owned Slipstream replay adapter in shadow mode first, then promoted only after exact same-block parity against the live Slipstream quoter.

The first implementation should use periodic safe-block full snapshots for this one pool, not event-driven tick maintenance. With `tickSpacing: 100`, scanning the full compressed bitmap space is plausibly cheap enough to measure and run for one high-impact pool. It is also much easier to verify than a birth-to-head event reducer. Event-driven maintenance becomes a later optimization after the full snapshot, state shape, and replay math prove parity.

## Ranked Ideas

### 1. Same-Block Full Replay Capsule For One Pool

**Description:** Add a dedicated `cl-replay-v1` snapshot path for only `slipstream-usdc-weth-100`. Each capsule is captured at one safe block and contains pool identity, token order, current `slot0.sqrtPriceX96`, current tick, active liquidity, exact dynamic fee in protocol units, fee source, initialized tick bitmap words, initialized tick records, block number, block hash, parent hash, source registry id, and a deterministic `stateHash`.

**Axis:** Indexed CL state acquisition and maintenance

**Basis:** `direct:` current CL head snapshots intentionally stop before tick bitmap/window indexing and local CL replay. `external:` Uniswap V3-style replay requires head state, bitmap, initialized ticks, liquidity changes, and exact integer math. `reasoned:` for one pool with tick spacing 100, a periodic full safe-block snapshot is simpler to prove correct than an event-only reducer.

**Rationale:** This is the smallest state that can support exact-input replay across tick crossings without a live quoter call. The full initialized-tick snapshot also answers the key "outside indexed range" problem by making the initial range all initialized ticks for the pool, while still allowing `www` to fail if a quote reaches min/max tick or missing data.

**DynamoDB shape:**

```text
pk = pool:8453:address:0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59
sk = cl-replay-v1:latest
sk = cl-replay-v1:block:<blockNumber>:<blockHash>:manifest
sk = cl-replay-v1:block:<blockNumber>:<blockHash>:bitmap:<wordPosition>
sk = cl-replay-v1:block:<blockNumber>:<blockHash>:ticks:<chunkIndex>
```

The manifest row should carry:

```json
{
  "stateKind": "cl-replay-v1",
  "replayModel": "slipstream-cl-replay-v1",
  "poolId": "slipstream-usdc-weth-100",
  "chainId": 8453,
  "poolAddress": "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59",
  "token0": "0x4200000000000000000000000000000000000006",
  "token1": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "tickSpacing": 100,
  "sqrtPriceX96": "<decimal string>",
  "tick": 0,
  "liquidity": "<decimal string>",
  "swapFeePips": "<integer protocol fee units>",
  "feeSource": {
    "kind": "slipstream-pool-or-factory",
    "address": "0x..."
  },
  "observedThroughBlock": 0,
  "observedBlockHash": "0x...",
  "parentBlockHash": "0x...",
  "bitmapWordCount": 0,
  "initializedTickCount": 0,
  "tickChunkCount": 0,
  "stateHash": "0x...",
  "sourceRegistryId": "<poolsHash>:<routesHash>",
  "updatedAt": "2026-05-20T00:00:00.000Z"
}
```

Tick chunk rows should store ticks as ordered arrays with `tick`, `liquidityGross`, and `liquidityNet` decimal strings. Bitmap rows should store `wordPosition` and the exact `uint256` word as a decimal or hex string. All rows for one capsule must share block number, block hash, source registry id, and state hash.

**Downsides:** Full snapshot reads may be heavier than head snapshots and need chunked Dynamo writes because of item-size limits. The first task must measure bitmap word count, initialized tick count, total payload size, snapshot duration, and provider throttling before any production promotion.

**Confidence:** 88%

**Complexity:** High

**Status:** Unexplored

### 2. Raw `cl-replay-v1` API Surface, Not A Quote Endpoint

**Description:** Extend `POST /fame/pool-state` with an opt-in state surface such as `stateSurfaces: ["cl-replay-v1"]`. The API returns replay primitives and eligibility metadata, not `amountOut`. `www` remains quote authority and decides whether to replay locally or call the live Slipstream quoter.

**Axis:** DynamoDB and API contract

**Basis:** `direct:` the existing helper already uses authenticated server-only access, `sourceRegistryId`, freshness status, and normal fallback statuses. `direct:` `www` owns live Slipstream adapter behavior and route attribution today. `reasoned:` a raw state contract can power quotes, route pruning, heatmaps, charts, and dashboards without creating a second quote engine in `society-bots`.

**Rationale:** The API should expose enough state for replay while avoiding route/business logic drift. A quote endpoint in `society-bots` would hide important route-level behavior from `www`, make attribution harder, and create two places where quote bugs can live.

**API request shape:**

```json
{
  "currentBlock": 46200000,
  "currentBlockHash": "0x...",
  "maxFreshnessBlocks": 25,
  "stateSurfaces": ["cl-replay-v1"],
  "pools": [{ "poolId": "slipstream-usdc-weth-100" }]
}
```

`currentBlockHash` can be optional for old surfaces, but `www` should supply it for CL replay once its quote context captures block hashes.

**API response shape:**

```json
{
  "sourceRegistryId": "<poolsHash>:<routesHash>",
  "currentBlock": 46200000,
  "effectiveMaxFreshnessBlocks": 25,
  "pools": [
    {
      "status": "fresh",
      "stateKind": "cl-replay-v1",
      "replayModel": "slipstream-cl-replay-v1",
      "poolId": "slipstream-usdc-weth-100",
      "chainId": 8453,
      "poolAddress": "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59",
      "token0": "0x4200000000000000000000000000000000000006",
      "token1": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "tickSpacing": 100,
      "sqrtPriceX96": "<decimal string>",
      "tick": 0,
      "liquidity": "<decimal string>",
      "swapFeePips": "<integer protocol fee units>",
      "feeSource": {
        "kind": "slipstream-pool-or-factory",
        "address": "0x..."
      },
      "observedThroughBlock": 46199998,
      "observedBlockHash": "0x...",
      "stateHash": "0x...",
      "bitmapWords": [
        { "wordPosition": 0, "word": "0x..." }
      ],
      "initializedTicks": [
        {
          "tick": -100,
          "liquidityGross": "<decimal string>",
          "liquidityNet": "<decimal string>"
        }
      ],
      "completeness": {
        "bitmapWordCount": 0,
        "initializedTickCount": 0,
        "tickChunkCount": 0
      },
      "maxFreshnessBlocks": 25
    }
  ]
}
```

Malformed, missing, stale, incomplete, unsupported, registry-mismatched, or future-observed state should keep using the existing normal status vocabulary where possible. Add specific machine-readable reasons for CL replay misses.

**Downsides:** Returning full tick state through the API may hit payload or latency limits. The first smoke should enforce a maximum payload size and fall back live if the bundle is too large, while keeping the indexed Dynamo state intact.

**Confidence:** 86%

**Complexity:** Medium-High

**Status:** Unexplored

### 3. `www`-Owned Slipstream Replay Adapter And Exact Math Module

**Description:** Implement `slipstreamClReplay.ts` in `www` as a pure deterministic module: `quoteExactInputFromSlipstreamState(state, tokenIn, amountIn, sqrtPriceLimitX96?)`. It should use only `bigint`, port Solidity rounding semantics exactly, handle direction-specific tick crossing, dynamic fee, price impact, final tick, `sqrtPriceX96After`, and initialized ticks crossed. Then wrap it in an indexed adapter that only activates for `slipstream-usdc-weth-100`.

**Axis:** Quote replay math ownership

**Basis:** `direct:` `www` already owns route solving, live adapters, route-lab, quote wire serialization, and fallback. `external:` Uniswap V3 replay has tricky exact math: `FullMath`, `SqrtPriceMath`, `SwapMath`, negative tick compression, and boundary semantics. `reasoned:` keeping the first math owner in `www` avoids packaging overhead until a second consumer proves the need for a shared package.

**Rationale:** `society-bots` should produce state; `www` should produce quotes. A shared package is a good later extraction once the first pool is stable, but the first production-safe milestone should keep the quote bug, parity harness, and route attribution in the same repo.

**Parity threshold:** exact equality. For production use, require `amountOut`, `sqrtPriceX96After`, and initialized ticks crossed to match the live Slipstream quoter at the same block when the quoter exposes those fields. A one-wei mismatch is a bug to investigate, not a tolerance to accept. Shadow mode can record deltas, but hot-path indexed replay should require exact deterministic parity.

**Downsides:** Exact math is the hardest part of the slice. Pulling in `@uniswap/v3-sdk` may help with data types, but the implementation still needs careful review against Slipstream fee behavior and Solidity rounding.

**Confidence:** 82%

**Complexity:** High

**Status:** Unexplored

### 4. Strict Replay Eligibility And Fallback Matrix

**Description:** Add one typed gate before `www` uses indexed replay. The gate checks source registry id, pool identity, token direction, freshness, `observedThroughBlock <= currentBlock`, block hash when comparable, complete chunks, exact fee presence, parser validity, supported replay model, and state hash. Any failure delegates to the existing live Slipstream quoter and records one fallback reason.

**Axis:** Freshness, invalidation, and fallback

**Basis:** `direct:` existing indexed reserve behavior already falls back for stale, malformed, mismatched, or unavailable helper state. `external:` replayable CL state is more fragile than reserve state because a missing tick or wrong fee can produce a plausible but wrong quote. `reasoned:` explicit failure reasons turn safety behavior into operational learning.

**Rationale:** This keeps user-facing quote correctness boring. It also tells the team whether indexed CL misses are due to stale snapshots, provider limits, payload limits, missing fee state, parity failure, or out-of-range math.

**Fallback reasons to standardize in `www`:**

- `not_configured`
- `source_registry_mismatch`
- `missing_replay_state`
- `stale_replay_state`
- `future_observed_block`
- `block_hash_mismatch`
- `incomplete_tick_state`
- `invalid_replay_payload`
- `unsupported_replay_model`
- `unsupported_direction`
- `missing_dynamic_fee`
- `math_error`
- `zero_or_invalid_output`
- `parity_check_failed`
- `payload_too_large`

**Invalidation model in `society-bots`:**

- Reject or mark stale on parent-hash mismatch while advancing snapshots.
- Do not write fresh partial capsules.
- Do not serve replay state if any chunk for the manifest is missing.
- Treat registry source changes as a new state lineage.
- Treat fee-source read failure as not replayable.
- Keep old `cl-head-snapshot` behavior separate so diagnostic state is not confused with replay authority.

**Downsides:** More status vocabulary increases client/parser/test work. The payoff is worth it because generic live fallback would hide the most important rollout blockers.

**Confidence:** 90%

**Complexity:** Medium

**Status:** Unexplored

### 5. Shadow Parity Harness And Route-Lab Rollout Gate

**Description:** Before hot-path use, add a validation harness that requests the indexed replay state, runs local replay in `www`, and compares it to the live Slipstream quoter at the same block. Cover both USDC->WETH and WETH->USDC with tiny, normal, large, and boundary-seeking amount buckets. Include route-lab shadow mode and optional production shadow telemetry, but keep served quotes live until gates pass.

**Axis:** Validation, rollout, and telemetry

**Basis:** `direct:` `www` route-lab already has recorded/live/indexed modes and documents this pool as an enabled USDC/WETH Slipstream connector. `external:` Uniswap QuoterV2-style static calls are the validation oracle pattern. `reasoned:` a first CL replay slice should graduate by evidence, not confidence.

**Rationale:** This defines "fully replayable" as a measurable property. It also keeps the first production milestone safe: the system can gather parity data, latency data, and fallback reasons without changing user-facing quotes.

**Validation matrix:**

- Directions: WETH -> USDC and USDC -> WETH.
- Amounts: dust, common UI amounts, current route-lab representative buckets, large amounts likely to cross ticks, and one stress amount expected to fail or reach coverage limits.
- Comparison fields: `amountOut`, `sqrtPriceX96After`, initialized ticks crossed, final tick if available locally, fee value, block number, block hash, snapshot age, replay latency, live quoter latency.
- Expected result: exact match for fields exposed by live quoter; otherwise live fallback.

**Rollout gates:**

1. Direct helper smoke returns fresh `cl-replay-v1` for the pool.
2. Route-lab shadow matrix passes both directions at the same block.
3. No parser/schema drift between `society-bots` and `www`.
4. Production shadow shows exact parity for representative traffic.
5. Only then enable indexed replay for this pool behind a server-side flag.

**Downsides:** Shadow mode adds more work before visible speedup. That delay is the right price for not shipping a plausible but wrong CL quote.

**Confidence:** 91%

**Complexity:** Medium

**Status:** Unexplored

### 6. Pool Index Health And Replay Telemetry

**Description:** Add operator-facing telemetry for the pool index: last observed block, snapshot age, block hash, initialized tick count, bitmap word count, dynamic fee value/source, payload size, snapshot duration, provider read counts, replay attempts, indexed-used count, live fallback count by reason, parity failures, and replay/live latency deltas.

**Axis:** Validation, rollout, and telemetry

**Basis:** `direct:` existing helper debug already reports status counts and source registry matching. `reasoned:` one-pool observability becomes the template for more CL pools, cached route pruning, quote heatmaps, historical charts, and market-state dashboards.

**Rationale:** This converts the pool from a hidden backend cache into a market-state index with a health signal. It also makes later expansion much cheaper because each new pool gets the same freshness, parity, and route-attribution vocabulary.

**Downsides:** Dashboards can sprawl if built before the core state and parity are stable. Start with structured logs and route-lab markdown/JSON output, then promote to a dashboard after the signal is useful.

**Confidence:** 84%

**Complexity:** Medium

**Status:** Unexplored

## Concrete Next Implementation Plan

1. Fix cross-repo registry drift first.
   - Update `www` registry generation to emit the current pool-state schema fields: `stateSurface`, `tickSpacing`, `stateViewAddress`, and explicit CL replay capability for only `slipstream-usdc-weth-100`.
   - Keep all other CL pools as head snapshot or tracked-only until they are intentionally promoted.

2. Add `society-bots` `cl-replay-v1` state storage.
   - Add manifest, bitmap, and tick chunk item types.
   - Add parser and writer tests that reject partial, mixed-block, or malformed state.
   - Add ABI reads for `tickBitmap`, `ticks`, and exact dynamic fee at the same safe block as `slot0` and `liquidity`.
   - Scan full bitmap space for this pool at first. With tick spacing 100, the compressed bitmap word count is small enough to measure directly; if initialized tick count or payload size is unexpectedly high, keep Dynamo chunking and make the API return `payload_too_large` until a windowed API is designed.

3. Extend `POST /fame/pool-state`.
   - Add `stateSurfaces: ["cl-replay-v1"]`.
   - Return full replay state only for this pool.
   - Preserve existing reserve and CL head behavior for current clients.
   - Add freshness and completeness reasons for CL replay.

4. Add `www` parser and adapter without changing served quotes.
   - Update `indexedPoolStateClient.ts` to request and parse `cl-replay-v1`.
   - Add a new indexed Slipstream replay adapter that activates only for `slipstream-usdc-weth-100`.
   - In shadow mode, always compare replay to live quoter and serve live results.

5. Implement exact replay math in `www`.
   - Port or wrap the V3 swap math with strict `bigint` semantics.
   - Handle dynamic Slipstream fee from indexed state.
   - Return `amountOut`, `sqrtPriceX96After`, final tick, initialized ticks crossed, price-impact evidence, and a typed failure reason.

6. Add validation and smoke checks.
   - Add a route-lab flag or mode for `slipstream-usdc-weth-100` shadow replay.
   - Compare local replay against live Slipstream quoter at the same block across both directions and amount buckets.
   - Gate hot-path use behind exact parity and structured telemetry.

## Tests And Smoke Checks

### `society-bots`

- Registry parser accepts `cl-replay-v1` only for the explicit pool and rejects replay capability without fee, tick spacing, pool address, or supported venue.
- Snapshot reader uses one safe block for `slot0`, `liquidity`, fee, bitmap, and ticks.
- Snapshot writer refuses mixed block numbers, missing block hash, missing fee, missing bitmap words, missing tick chunks, or inconsistent state hash.
- Dynamo helpers store and batch-read manifest, bitmap rows, and tick chunks; unprocessed keys remain an incomplete read error.
- API parser accepts `stateSurfaces: ["cl-replay-v1"]` without breaking `cl-head-snapshot`.
- API returns `fresh`, `stale`, `unknown`, or `unsupported` correctly for current block, future observed block, stale observed block, missing chunks, and registry mismatch.
- Indexer result logs include replay snapshot counts, tick count, bitmap word count, dynamic fee, provider read count, payload size, and failures.
- Live smoke: authenticated helper request for `slipstream-usdc-weth-100` returns fresh `cl-replay-v1`, non-empty bitmap/tick data, exact fee, and a matching `sourceRegistryId`.

### `www`

- Registry generator emits schema-compatible replay metadata for `slipstream-usdc-weth-100` and does not promote other CL pools.
- Indexed pool-state client sends `stateSurfaces: ["cl-replay-v1"]` when CL replay shadow mode is enabled.
- Parser accepts CL replay rows and rejects malformed addresses, non-decimal integer strings, missing fee, missing chunks, or unsupported replay model.
- Pure replay math golden tests cover both directions, exact tick boundary behavior, negative tick compression, fee rounding, zero output, and at least one tick crossing.
- Indexed Slipstream adapter falls back live for each standardized fallback reason.
- Route API debug reports shadow replay parity without leaking helper URL, token, calldata, or raw RPC errors.
- Route-lab shadow matrix compares live quoter and indexed replay at the same block for representative USDC/WETH amounts.
- Public quote wire tests ensure mixed indexed/live routes do not claim fully indexed route context.

## Rejected Alternatives

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Event-driven tick maintenance first | Correct long-term, but too much hidden state-machine risk before a same-block full snapshot proves quote parity. |
| 2 | Bounded active tick window as the first and only state | Useful as a payload optimization, but weaker than the requested one-pool "boil the ocean" slice. Full bitmap scan for tick spacing 100 should be measured first. |
| 3 | `society-bots` quote endpoint | Reduces client payload, but creates a second quote authority and makes route attribution, slippage, and fallback behavior harder to reason about. |
| 4 | Shared package before first parity proof | Likely useful after the second consumer exists, but it adds packaging and versioning overhead before the math is proven. Start in `www`, then extract. |
| 5 | Approximate parity threshold | Rejected for production. Deterministic same-block replay should exactly match live quoter output fields; mismatches are bugs or incomplete state. |
| 6 | Generic CL replay for all Slipstream/V3/V4 pools | Scope overrun. This slice should make one high-impact pool boringly correct before broad coverage. |
| 7 | Historical charts in the first milestone | Unlocked by capsules, but not required for hot-path quote proof. Keep sampled history as follow-on work. |
| 8 | Route-level cached quote receipts instead of pool state | Useful for repeated exact requests, but it does not create a replayable market-state index or teach the system CL math. |

## Risks

- Stale tick state: mitigated by same-block snapshots, no partial writes, strict freshness, and live fallback.
- Provider limits: full bitmap plus initialized tick reads may hit RPC/multicall limits. Measure word count, tick count, call count, and duration before enabling production cadence.
- Block consistency: all state reads and live parity calls must use the same block. Store block hash and parent hash; reject reorg/mismatch.
- Dynamic fee drift: registry `feeBps` is not enough. Store the exact fee integer and source at block; missing fee means no replay.
- Quote parity: rounding and tick-boundary semantics are the highest-risk math areas. Require exact amount and post-price parity before hot-path use.
- Route attribution: mixed replay/live routes must not claim fully indexed context. Attribution remains per selected leg.
- API payload size: full tick state may exceed comfortable response size. Dynamo chunking is required; API fallback on oversized response is safer than truncation.
- Registry drift: include schema/state-surface compatibility in tests so `sourceRegistryId` is not the only cross-repo contract.

## Unlocks

- More CL pools can reuse the capsule, eligibility, and parity harness once the first pool is proven.
- Cached route pruning can use fresh price/liquidity/tick coverage before expensive live quote calls.
- Quote heatmaps can replay many amounts from one capsule.
- Historical liquidity and price charts can sample capsule manifests over time.
- Route-level performance telemetry can distinguish live-quoter bottlenecks from index freshness or math coverage.
- Market-state dashboards can expose pool health, fee movement, tick density, freshness, and fallback reasons.

## First Production-Safe Milestone

The first production-safe milestone is not "serve indexed CL quotes." It is:

1. `society-bots` serves fresh `cl-replay-v1` full replay state for `slipstream-usdc-weth-100`.
2. `www` can parse it and run local replay in shadow mode.
3. Route-lab proves exact same-block parity across both directions and representative amounts.
4. Production shadow telemetry shows exact parity and useful fallback reasons.
5. A server-side flag can then enable hot-path indexed replay for only this pool, with live quoter fallback on every failure path.

## Explicitly Out Of Scope

- Generic CL replay for all Slipstream, Slipstream2, Uniswap V3, or Uniswap V4 pools.
- Event-driven birth-to-head reconstruction as the first implementation.
- `society-bots` owning final quote output or route selection.
- Approximate CL math, floating-point math, or tolerance-based production matching.
- Public exposure of raw helper diagnostics, helper credentials, calldata, or RPC errors.
- Stable-pool math, native-wrap changes, exotic route promotion, or router contract changes.
- Historical dashboards and quote heatmaps beyond telemetry needed to validate this first pool.
