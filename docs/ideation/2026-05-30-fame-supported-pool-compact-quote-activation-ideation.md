---
date: 2026-05-30
topic: fame-supported-pool-compact-quote-activation
focus: activating all supported pools with compact quotes and reducers
mode: repo-grounded
---

# Ideation: FAME Supported Pool Compact Quote Activation

## Grounding Context

`society-bots` owns the producer side of FAME indexed pool state and compact quote rows. The registry artifact is generated from `www`, not hand-curated here ([docs/fame-pool-state-index.md](../fame-pool-state-index.md)). The current documented scope is seven quote-model reserve pools, compact reserve quote rows, CL head snapshots, and exactly one CL replay compact quote pool: `slipstream-usdc-weth-100`.

The current registry and companion `www` artifact are not the same shape. `society-bots` has 21 pools: seven reserve compact quote pools, one CL replay compact-configured pool, eleven other CL head-only pools, and two tracked-only pools. `www` has 26 pools; the six currently absent from the `society-bots` generated registry are `slipstream-spx-weth`, blocked `slipstream-usdc-weth-migrating-50`, `slipstream-msusd-usdc-a`, `slipstream-weth-mseth`, `slipstream2-msusd-mseth`, and `slipstream2-msusd-usdc-c`.

The present one-pool assumption is explicit. `society-bots` rejects any replay surface that is not `slipstream-usdc-weth-100`, and also asserts exactly one replay pool. The indexer loop is more general than that constraint: it derives `replayPools` from registry rows, then runs checkpoint, steady-state, repair, candidate-row, drift-check, and trusted-promotion logic across that set. `www` also keeps a singleton `CL_REPLAY_CAPABLE_FAME_POOL_IDS` list and derives compact quote capability from that list plus the reserve quote-model pool list.

The compact quote contract is the hot path, while raw `/fame/pool-state` and `cl-replay-v1` state remain proof/debug surfaces. Reserve rows emit `constant-product-quote-v1`; CL rows emit `cl-quote-v1` only when the replay pointer is fresh and matching maintenance is trusted, source-registry-compatible, cursor-current, and state-hash-compatible. Shadow or untrusted reducer output returns `unavailable` with `producer-untrusted`.

Important current gap: this `society-bots` checkout can emit `producer-untrusted`, while the inspected `www` checkout does not include `producer-untrusted` in its `FamePoolQuoteUnavailableReason` parser. That means widening CL quote attempts could turn a normal untrusted row into an invalid-response batch fallback until the producer/consumer wire contract is aligned.

External grounding supports a cautious expansion model. Uniswap V3 offchain state reconstruction depends on `slot0`, liquidity, ticks, and tick bitmap reads; replay depends on initialized tick crossing and event streams. Uniswap V3 reducers need `Initialize`, `Mint`, `Burn`, and `Swap`; Uniswap V4 uses PoolManager/PoolId state and hook-aware semantics; Aerodrome Slipstream is UniV3-derived but has dynamic/custom fee and factory quirks. Parallel pools and reversed route order must remain explicit because token-pair identity alone is not enough.

## Topic Axes

- Pool eligibility and registry promotion
- Protocol-specific reducer semantics
- Compact quote API and `www` fallback contract
- Promotion, parity, and evidence gates
- Runtime scale and operational safety

## Ranked Ideas

### 1. Shared Activation Ledger

**Description:** Create one generated activation ledger that classifies every upstream `www` pool as reserve compact quote, CL head-only, CL replay candidate, CL compact quote, tracked-only, blocked, or unsupported. `society-bots` and `www` would derive their indexing and compact-quote allowlists from this ledger rather than duplicating singleton constants. This is the best umbrella idea because it turns “all supported pools” from a verbal claim into reviewable data.

**Axis:** Pool eligibility and registry promotion

**Basis:** `direct:` current docs say the registry is generated from `www`, current code hardcodes only `slipstream-usdc-weth-100` as replay-capable in both repos, and the inventory shows 26 upstream pools versus 21 producer registry pools.

**Rationale:** Activation should not mean “every CL pool quotes now.” It should mean every pool has a durable status and the supported statuses produce the expected compact behavior.

**Downsides:** This is a schema and cross-repo coordination move, so it will touch tests and generation in both repos before it improves quote coverage.

**Confidence:** 92%

**Complexity:** Medium

**Status:** Unexplored

### 2. Producer/Consumer Contract Alignment First

**Description:** Before expanding CL compact quote coverage, align the versioned `/fame/pool-quotes` contract so every producer `unavailable.reason` parses in `www`, especially `producer-untrusted`. Make untrusted reducer output a normal per-row fallback signal, not an invalid response. This is a narrower idea than the ledger, but it is the safest first move because it removes a known activation footgun.

**Axis:** Compact quote API and `www` fallback contract

**Basis:** `direct:` `src/fame-swap-pool-state/cl-quote.ts` includes and emits `producer-untrusted`, while `../www/src/features/fame-swap/solver/quotes/indexedQuoteApiClient.ts` does not parse that reason.

**Rationale:** Expanding reducers will intentionally create candidate and untrusted rows. If the consumer cannot parse those rows, the fallback contract becomes noisier and less diagnostic exactly when activation broadens.

**Downsides:** This does not itself activate another pool; it is enabling contract hygiene.

**Confidence:** 95%

**Complexity:** Low

**Status:** Unexplored

### 3. Protocol-Family Reducer Manifests

**Description:** Split CL replay eligibility by explicit protocol-family manifests: Slipstream v1, Slipstream2, Uniswap V3, and later Uniswap V4 only if PoolManager and hook semantics are intentionally modeled. Each manifest should name event inputs, pool identity shape, fee source, tick/bitmap requirements, reducer invariants, and quote eligibility constraints. The reducer loop can stay generic, but the semantic contract becomes visible before a pool is promoted.

**Axis:** Protocol-specific reducer semantics

**Basis:** `external:` Uniswap V3 and Slipstream share CL mechanics but differ in fee/factory behavior; Uniswap V4 uses PoolManager and hooks, not pool-contract-local state in the same shape. `direct:` the current `clReplayPools()` filter only admits `aerodrome-slipstream` replay pools.

**Rationale:** This prevents the dangerous middle ground where more pools are allowed because the code is loop-shaped, while their protocol differences are still implicit.

**Downsides:** It can become too abstract if it is not tied to the next concrete supported pool family.

**Confidence:** 88%

**Complexity:** Medium

**Status:** Unexplored

### 4. Per-Pool Promotion Ladder

**Description:** Treat each CL pool as moving through an evidence ladder: head snapshot, replay candidate, drift-clean trusted maintenance, compact quote emission, route-lab proof, and parity proof. A pool can run reducer maintenance in production while remaining excluded from compact quote serving until it passes the promotion gates. This converts the existing reducer machinery into a repeatable activation path.

**Axis:** Promotion, parity, and evidence gates

**Basis:** `direct:` the indexer already has candidate rows, checkpoint/steady-state/repair modes, state-hash drift checks, trusted promotion, `producer-untrusted`, route-lab proof, CL replay parity, and delta replay smoke evidence.

**Rationale:** The existing system already knows how to fail closed. The missing product shape is a per-pool promotion story that reviewers and operators can read without inferring it from logs.

**Downsides:** It adds process around activation; teams may be tempted to bypass it for apparently simple pools.

**Confidence:** 90%

**Complexity:** Medium

**Status:** Unexplored

### 5. Cross-Repo Pool Delta Report

**Description:** Add an operator or CI report that compares the full `www` pool artifact, the `www` compact quote capability set, and the generated `society-bots` registry. It should classify every mismatch as blocked, tracked-only, unsupported, head-only, replay-candidate, or compact-quote-active. The first report should make the current 26-to-21 gap boringly explicit.

**Axis:** Pool eligibility and registry promotion

**Basis:** `direct:` the current inventory has six `www` pools absent from `society-bots`, including one explicitly blocked migrating pool and several unclassified Slipstream/Slipstream2 pools.

**Rationale:** This is the smallest durable way to keep “all supported pools” honest over time. It catches drift before it becomes a broken activation assumption.

**Downsides:** It is mostly visibility unless paired with the activation ledger.

**Confidence:** 86%

**Complexity:** Low

**Status:** Unexplored

### 6. Runtime Scale Gates

**Description:** Make runtime health a promotion dimension for each replay pool: event volume, checkpoint size, provider read count, candidate write status, event-gap frequency, drift frequency, repair duration, and trusted-promotion lag. A pool can be syntactically eligible but operationally inactive until it stays healthy within bounded thresholds. The existing `FAME_POOL_STATE_CL_REPLAY_*` controls become activation controls instead of only operator knobs.

**Axis:** Runtime scale and operational safety

**Basis:** `direct:` indexer logs already include replay metrics, maintenance metrics, candidate write status, state hash, scan ranges, applied event count, and replay failure statuses; docs already require delta replay smoke evidence.

**Rationale:** Activating multiple CL pools changes the problem from correctness-only to correctness plus throughput. Runtime health keeps one dense or noisy pool from degrading the quote surface for all pools.

**Downsides:** Requires enough production-like data to set thresholds without guessing.

**Confidence:** 82%

**Complexity:** Medium

**Status:** Unexplored

### 7. Route-Order and Parallel-Pool Preservation Fixtures

**Description:** Add activation evidence that proves compact quote expansion preserves exact pool id, token orientation, fee/factory identity, and route order for parallel pools. This matters for same-pair pools like USDC/WETH variants and for future Slipstream2 or Uniswap V3/V4 pools that share assets but differ economically. The fixture set should fail if the consumer collapses by token pair or normalizes away direction.

**Axis:** Protocol-specific reducer semantics

**Basis:** `external:` official route quoting prior art treats parallel pools as distinct graph edges; CL pools can differ by fee tier, factory, and hook/protocol generation. `direct:` current route and compact quote code keys by pool id and token direction, but expansion pressure creates a risk of over-normalization.

**Rationale:** “Supported” should mean a specific market surface is supported, not merely a token pair. This protects route quality when more supported pools become compact-quote-capable.

**Downsides:** Fixture design may require carefully chosen same-pair pools and can lag until the missing pools are represented in the registry.

**Confidence:** 78%

**Complexity:** Medium

**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | One-pool assumption burn-down | Useful checklist, but duplicated by Shared Activation Ledger and Protocol-Family Reducer Manifests. |
| 2 | Remove head-only limbo | Strong framing, merged into Per-Pool Promotion Ladder. |
| 3 | Compact quote contract matrix | Duplicates Shared Activation Ledger plus Producer/Consumer Contract Alignment First. |
| 4 | Replay repair automation | Operationally useful, merged into Runtime Scale Gates. |
| 5 | Unsupported pool reasons as durable data | Important detail, merged into Shared Activation Ledger and Cross-Repo Pool Delta Report. |
| 6 | Blocked-pool semantics in generated registry | Important detail, merged into Cross-Repo Pool Delta Report. |
| 7 | Flight recorder for parity evidence | Strong metaphor, merged into Per-Pool Promotion Ladder. |
| 8 | Broad stable-pool quote support | Scope overrun; stable math is explicitly outside current supported-pool activation. |
| 9 | Broad Uniswap V4 compact quote activation | Too risky as a near-term survivor because v4 hooks and PoolManager semantics need their own manifest before quote promotion. |
| 10 | Public route rewrite around compact quotes | Scope overrun; `www` should preserve live fallback and route authority. |

