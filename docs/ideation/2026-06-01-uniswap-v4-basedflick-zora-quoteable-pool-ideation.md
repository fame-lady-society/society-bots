---
date: 2026-06-01
topic: uniswap-v4-basedflick-zora-quoteable-pool
focus: safely enabling BASEDFLICK/ZORA as a valid quoteable pool without broad V4 compact quoting
mode: repo-grounded
---

# Ideation: BASEDFLICK/ZORA V4 Quoteability

## Grounding Context

`society-bots` currently treats `uniswap-v4-basedflick-zora` as present, head-snapshot-readable, and unsupported for compact quotes. The registry row has `venueFamily: "UniswapV4"`, `poolKey` / pool id `0x0fe6333346fcd0ffa4be3fda91f271bda52c6755f604b06483b709666d363628`, token0 ZORA, token1 BASEDFLICK, `feeBps: 300`, `tickSpacing: 200`, `stateViewAddress: 0xa3c0c9b65bad0b08107aa264b0f3db444b867a71`, `activationStatus: "unsupported"`, `stateSurface: "cl-head-snapshot"`, and no replay or quote model.

The companion `fls-www` checkout has the exact V4 PoolKey ingredients for the same pool: PoolManager `0x498581ff718922c3f8e6a244956af099b2652b2b`, StateView `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71`, pool id `0x0fe6333346fcd0ffa4be3fda91f271bda52c6755f604b06483b709666d363628`, `currency0` ZORA, `currency1` BASEDFLICK, `fee: 30000`, `tickSpacing: 200`, hook `0xd61a675f8a0c67a73dc3b54fb7318b4d91409040`, and `hookData: "0x"`.

Current route activation deliberately keeps this pool live. `docs/fame-pool-state-index.md` says compact evidence for `slipstream-basedflick-fame` does not imply V4 support, and the selected route still depends on live quoting for `uniswap-v4-basedflick-zora`. The May 30 supported-pool ideation rejected broad V4 compact quote activation because PoolManager, PoolId, hook, fee, and StateView semantics needed their own reviewed reducer model.

The new evidence narrows the problem. The PoolKey fee is static `30000` rather than Uniswap v4's dynamic-fee sentinel `0x800000`; Uniswap's `LPFeeLibrary` defines `DYNAMIC_FEE_FLAG = 0x800000` and treats fees as hundredths of a bip. The hook address decodes to `afterInitialize` and `afterSwap`, with no `beforeSwap`, `beforeSwapReturnDelta`, or `afterSwapReturnDelta`. Uniswap v4 hook permissions are encoded in the hook address; return-delta flags are separate low-bit permissions. Uniswap v4 StateView exposes `getSlot0`, `getLiquidity`, `getTickBitmap`, and tick reads needed to assemble offchain CL state.

Recent overlapping ideation background:

- `2026-05-30-fame-supported-pool-compact-quote-activation-ideation.md` established activation ledgers, per-pool promotion, and a broad V4 rejection until semantics are reviewed.
- `2026-05-20-slipstream-usdc-weth-100-cl-replay-ideation.md` established the safe pattern for one-pool CL replay: same-block state capsule, exact math, fallback matrix, and parity before promotion.
- `2026-05-29-fame-delta-cl-replay-index-ideation.md` and the current commits turned per-pool activation evidence into route-bounded smoke gates.

Relevant external sources:

- Uniswap v4 LP fee library: https://github.com/Uniswap/v4-core/blob/main/src/libraries/LPFeeLibrary.sol
- Uniswap v4 hook permissions: https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol
- Uniswap v4 dynamic-fee docs: https://developers.uniswap.org/contracts/v4/reference/core/libraries/LPFeeLibrary
- Uniswap v4 pool-data guide: https://developers.uniswap.org/docs/sdks/v4/guides/pool-data

## Topic Axes

- Pool-specific activation boundary
- Hook and fee safety proof
- V4 state and replay shape
- Parity and route-lab evidence
- Rollout and fallback behavior

## Ranked Ideas

### 1. Single-Pool Passive-Hook Manifest

**Description:** Create a reviewed manifest for only `uniswap-v4-basedflick-zora`, parallel to the selected Slipstream manifest but not generalized to all V4 pools. The manifest should lock PoolManager, StateView, pool id, currencies, static `fee: 30000`, tick spacing, hook address, decoded hook flags, empty hookData, and allowed activation statuses. It should fail closed if any V4 pool lacks this exact reviewed shape.

**Axis:** Pool-specific activation boundary

**Basis:** `direct:` the current manifest model only permits `slipstream-basedflick-fame`, while the BASEDFLICK/ZORA row already has exact PoolManager, StateView, PoolId, currency, fee, tick, hook, and hookData metadata in the companion artifact.

**Rationale:** This is the cleanest way to break the broad-V4 barrier without deleting it. The implementation can say, "this one PoolKey is reviewed," rather than, "Uniswap V4 is supported."

**Downsides:** It introduces a second one-pool manifest. That is intentional for safety, but it should be named as a pilot rather than disguised as a reusable V4 abstraction.

**Confidence:** 92%

**Complexity:** Medium

**Status:** Unexplored

### 2. Static-Fee Passive-Hook Classifier Gate

**Description:** Add a pure classifier that derives V4 quote eligibility from metadata: `fee !== 0x800000`, fee is valid, hookData is empty, no `beforeSwap`, no `beforeSwapReturnDelta`, and no `afterSwapReturnDelta`. The classifier can expose labels like `v4-static-passive-hook-candidate`, `v4-dynamic-fee`, `v4-before-swap-hook`, or `v4-return-delta-hook` for activation reports and smoke evidence.

**Axis:** Hook and fee safety proof

**Basis:** `external:` Uniswap v4 defines dynamic-fee capability with `DYNAMIC_FEE_FLAG = 0x800000`, and hook permissions are encoded by address bits with separate swap and return-delta flags. `direct:` the requested pool has static `fee: 30000`, `hookData: "0x"`, and no before-swap or return-delta flags.

**Rationale:** The gate makes the "why this pool is easier" argument machine-checkable. It also preserves pushback on dynamic-fee and swap-mutating hooks by giving those pools explicit non-promotion reasons.

**Downsides:** The classifier is only metadata safety. It does not prove the hook implementation cannot revert or perform other execution-affecting side effects.

**Confidence:** 90%

**Complexity:** Low-Medium

**Status:** Unexplored

### 3. V4 State Capsule Reusing CL Replay Math With V4 Identity

**Description:** Build a V4 replay state capsule for this pool that mirrors the existing CL replay capsule, but uses PoolManager/PoolId/StateView identity instead of a pool contract address. Capture same-block `getSlot0` including protocol fee and LP fee, `getLiquidity`, tick bitmap words, initialized tick liquidity records, block hash, state hash, and source registry id. Feed that into the existing CL quote math only after v4 fee/protocol-fee semantics are explicitly mapped.

**Axis:** V4 state and replay shape

**Basis:** `direct:` `society-bots` already reads V4 `getSlot0` and `getLiquidity` for head state, but currently discards protocol fee and LP fee for quote purposes. `external:` Uniswap's v4 pool-data guide describes `getTickBitmap` and initialized tick assembly through StateView.

**Rationale:** Static fee and passive hook bits make the swap math close to v3-style CL math, but the state identity is not v3. A V4 capsule prevents PoolManager/PoolId/protocol-fee details from being smuggled through a Slipstream-shaped reducer.

**Downsides:** This is the highest implementation cost. It needs a V4-specific state reader and a careful protocol-fee review before any compact quote is authoritative.

**Confidence:** 84%

**Complexity:** High

**Status:** Unexplored

### 4. Same-Block Local-vs-Live Parity Harness

**Description:** Before serving compact quotes, run a parity harness that compares local replay against live V4 quote/simulation for both directions and representative route amounts. Pin the same block, PoolKey, hook address, empty hookData, exact currencies, static fee, and route leg orientation. Require exact output parity or keep the pool live-only.

**Axis:** Parity and route-lab evidence

**Basis:** `direct:` the existing Slipstream promotion path already depends on same-block replay evidence, route-lab selection, and delta replay smoke gates. `reasoned:` a passive-hook V4 pool can still be mis-modeled through fee units, protocol-fee handling, tick crossing, token orientation, or PoolKey mismatch, so parity is the cheapest falsification test.

**Rationale:** This turns the conceptual shortcut into evidence. If parity passes, the team can confidently activate a route-bounded compact leg; if it fails, the failure explains exactly which V4 semantic is still missing.

**Downsides:** Live V4 quote/simulation infrastructure may be slower than the final compact path, but this is a validation cost, not a runtime requirement.

**Confidence:** 91%

**Complexity:** Medium

**Status:** Unexplored

### 5. Shadow-Then-Route-Bounded Activation

**Description:** Keep `uniswap-v4-basedflick-zora` live in selected public quotes while `society-bots` emits shadow `cl-quote-v1` rows for that pool behind a non-public activation status. Route-lab should record live output, local output, delta, fallback reason, and whether the selected route would have remained the same. Promote only when the route-bounded smoke evidence shows compact V4 does not change the selected route outcome except by removing a live read.

**Axis:** Rollout and fallback behavior

**Basis:** `direct:` current activation evidence is already route-bounded: it proves `slipstream-basedflick-fame` compact quote use while keeping the V4 leg live. `reasoned:` a shadow lane lets the system collect V4 evidence without turning a hook mistake into a user-visible quote bug.

**Rationale:** This is the operationally safest rollout shape. It acknowledges that BASEDFLICK/ZORA is special without making first-pass local V4 math production-authoritative.

**Downsides:** Shadow rows add temporary complexity and can be mistaken for support unless status names and docs are blunt.

**Confidence:** 86%

**Complexity:** Medium

**Status:** Unexplored

### 6. Execution-Safety Gate For AfterSwap Hooks

**Description:** Treat "no return delta" as an amount-output proof, not as a full execution proof. Add an execution-safety gate that requires empty hookData, route materialization to use the same PoolKey, and a route-lab/fork simulation proving the Universal Router path succeeds with this hook. Keep this separate from quote math parity.

**Axis:** Hook and fee safety proof

**Basis:** `external:` Uniswap's hook model still calls `afterSwap` when that permission bit is set, even when the hook does not return a delta. `direct:` `fls-www` already tracks V4 hook address and hookData capabilities in candidate/materialization code.

**Rationale:** The hook may not be able to change returned swap amounts via deltas, but it can still revert or impose side conditions. Quoteability should not imply executability unless the route path has also proven execution with the configured hookData.

**Downsides:** It may feel redundant if the route is already live today, but making the proof explicit protects future refactors and hookData changes.

**Confidence:** 88%

**Complexity:** Low-Medium

**Status:** Unexplored

### 7. V4 Non-Promotion Matrix For Everything Else

**Description:** As part of the pilot, classify the other V4 pools and future V4 candidates with explicit reasons: dynamic fee, before-swap hook, return-delta hook, non-empty hookData, missing PoolKey, missing StateView, missing tick data, or unreviewed protocol fee. Keep those statuses visible in activation reports without blocking BASEDFLICK/ZORA.

**Axis:** Pool-specific activation boundary

**Basis:** `direct:` the smoke cleanup now derives non-promotion evidence from activation reports instead of hardcoded exclusions. `reasoned:` making every other V4 rejection explicit prevents the single-pool pilot from becoming an accidental precedent.

**Rationale:** This turns "not broad V4" into data. It also gives the next disputed pool a concrete checklist instead of a philosophical argument.

**Downsides:** Some reasons will initially be conservative and may need to evolve as more V4 hook patterns are reviewed.

**Confidence:** 83%

**Complexity:** Low

**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Broad V4 compact quoting | Scope overrun; the available evidence is specific to one static-fee, passive-hook PoolKey. |
| 2 | Treat static fee alone as sufficient | Unjustified; hook flags, protocol fee, PoolKey identity, tick state, and execution success still matter. |
| 3 | Ignore `afterSwap` because no return-delta flag is set | Too weak; no return delta helps quote math, but `afterSwap` can still affect execution by reverting or side effects. |
| 4 | Hardcode BASEDFLICK/ZORA directly in the quote adapter | Duplicates policy in code and bypasses the activation-ledger pattern that just replaced hardcoded smoke exclusions. |
| 5 | Simulate every quote and call that support | Fails the compute goal; this is just live quoting with different labels, not compact quote activation. |
| 6 | Move all V4 hook semantics into `society-bots` before any pilot | Too expensive relative to the one-pool evidence; a passive-hook pilot should stay narrower. |
| 7 | Wait for every V4 pool to be solved before enabling this one | Overly conservative; the classifier/manifest approach can support this pool while preserving non-promotion for others. |
| 8 | Use current CL head snapshots as quote input | Already covered by docs as insufficient; head snapshots lack tick bitmap/initialized tick data for exact CL replay. |

## Risks

- The artifact fee says `30000`, while nearby Zora source notes may refer to a `10000` default fee in another context. Activation should prove the exact PoolKey fee for this pool, not assume a protocol-wide default.
- V4 `slot0` includes protocol fee and LP fee. Local replay must either model protocol-fee behavior or prove it is zero / irrelevant for this pool and route direction.
- No return-delta hook flags reduce quote-output risk, but `afterSwap` can still revert. Quote parity and execution simulation are separate gates.
- PoolId/PoolKey mismatch would be easy to miss because there is no pool contract address. The manifest must lock every PoolKey field, not only pool id.
- A single-pool pilot could accidentally become a broad V4 precedent unless activation statuses and tests name the boundary directly.

## Follow-Up Questions

1. Should a BASEDFLICK/ZORA compact quote still require a final route simulation before execution, even after local quote parity passes?
2. Do we want a new activation status for shadow V4 support, or should this remain `unsupported` until it is fully compact-quote-active?
3. Which live authority should the parity harness compare against: Universal Router simulation, a V4 quoter path, or both?
4. Should hook source/bytecode verification be required before promotion, or is decoded permission bits plus route execution evidence enough for this pool?

