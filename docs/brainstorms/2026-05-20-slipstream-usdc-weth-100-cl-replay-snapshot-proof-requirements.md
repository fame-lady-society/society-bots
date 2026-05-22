---
date: 2026-05-20
topic: slipstream-usdc-weth-100-cl-replay-snapshot-proof
---

# Slipstream USDC/WETH CL Replay Snapshot Proof

## Summary

Build a snapshot-first proof that makes `slipstream-usdc-weth-100` locally replayable in shadow mode. `society-bots` will produce complete same-block replay state for this one pool; `www` will compare local replay against the live Slipstream quoter before any user-facing quote path can use indexed CL replay.

---

## Problem Frame

FAME quoting is moving toward faster, richer market-state indexing, but concentrated-liquidity pools still require live quoter calls for correct output. The current `society-bots` CL head snapshot surface is useful for diagnostics because it exposes current price, tick, active liquidity, fee metadata, freshness, and provenance. It is not enough to replay swaps that cross initialized ticks.

The high-impact candidate is `slipstream-usdc-weth-100`, because USDC routes often depend on that connector and `www` already validates it through the live Slipstream quoter. The immediate risk is false confidence: a partial CL index could look fresh while still producing plausible but wrong quotes because it missed dynamic fee state, initialized tick data, block consistency, or exact rounding behavior.

---

## Actors

- A1. `society-bots` pool-state indexer: Captures and serves block-attributed indexed state for the reviewed pool universe.
- A2. `www` quote system: Owns quote math, route attribution, live fallback, route-lab validation, and public quote behavior.
- A3. Operator/reviewer: Uses logs, route-lab output, and smoke checks to decide whether indexed replay is trustworthy.
- A4. FAME swap user: Benefits indirectly through faster quotes only after shadow parity proves correctness.

---

## Key Flows

- F1. Snapshot state is captured
  - **Trigger:** The pool-state indexer reaches a safe Base block.
  - **Actors:** A1
  - **Steps:** The indexer captures all replay primitives for `slipstream-usdc-weth-100` at one block, verifies completeness, records block identity, and publishes only complete state.
  - **Outcome:** A replay snapshot is either fresh and complete or unavailable for replay; partial state is not served as replay-capable.
  - **Covered by:** R1, R2, R3, R4

- F2. Shadow replay is evaluated
  - **Trigger:** `www` has a quote context that includes `slipstream-usdc-weth-100`.
  - **Actors:** A2
  - **Steps:** `www` requests replay-capable state, validates freshness and provenance, runs local replay if eligible, compares with the live Slipstream quoter at the same block, and serves the live quote while shadow mode is active.
  - **Outcome:** The system records parity, latency, and fallback evidence without changing user-facing quote behavior.
  - **Covered by:** R5, R6, R7, R8, R9

- F3. Promotion is considered
  - **Trigger:** Route-lab and shadow telemetry show stable parity.
  - **Actors:** A2, A3
  - **Steps:** The operator reviews exact-match parity, fallback reasons, snapshot freshness, and payload cost, then enables indexed replay only for this pool when the gate is satisfied.
  - **Outcome:** Indexed replay can enter the hot path behind a server-side control, with live quoter fallback preserved.
  - **Covered by:** R10, R11, R12

---

## Requirements

**Snapshot state**

- R1. The first replayable CL scope is exactly `slipstream-usdc-weth-100`; other CL pools remain observational, unsupported, or live-quoted.
- R2. The replay snapshot must include enough same-block state for exact-input replay across initialized tick crossings: head price, current tick, active liquidity, tick spacing, initialized tick bitmap data, initialized tick liquidity data, exact dynamic fee, pool identity, token order, and block identity.
- R3. Replay state must be captured against one safe block. Mixed-block state, missing block identity, missing dynamic fee, missing tick data, or incomplete chunk reads must make the replay state unavailable.
- R4. The initial milestone uses periodic safe-block full snapshots, not event-driven tick maintenance. Event maintenance may be explored later only after snapshot parity is proven.

**API and consumption contract**

- R5. `society-bots` exposes replay state as raw indexed state, not as a quote endpoint. It must not decide route selection, output amount, slippage, or user-facing quote readiness.
- R6. Existing reserve and CL head snapshot behavior must remain safe for current clients; clients that do not opt into replay-capable state must not accidentally treat CL head state as replay authority.
- R7. `www` validates replay state before use: source registry match, pool identity, token direction, freshness, not observed ahead of the quote context, replay model support, complete tick state, exact fee presence, and parser validity.
- R8. Any failed validation in `www` must fall back to the live Slipstream quoter and emit one structured fallback reason suitable for route-lab or operator telemetry.

**Replay and parity**

- R9. `www` owns local Slipstream replay math and compares it against the live Slipstream quoter in shadow mode before serving indexed replay results.
- R10. Production promotion requires exact same-block parity for exposed comparison fields, especially `amountOut` and post-swap price when the live quoter exposes it. Tolerance-based production matching is out of scope.
- R11. Shadow validation must cover both WETH to USDC and USDC to WETH, across tiny, common, larger, and tick-crossing amount bands.
- R12. While shadow mode is active, user-facing quote behavior remains live-quoter-backed even when local replay succeeds.

**Telemetry and handoff quality**

- R13. The proof must expose enough evidence for an operator to answer whether indexed replay is currently safe for this pool: snapshot age, observed block, state completeness, dynamic fee freshness, fallback reasons, parity result, and live-vs-replay latency.
- R14. The requirements and release evidence must make the first milestone clear: fresh replay state plus shadow parity, not broad CL indexing or user-facing indexed CL quotes.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given the indexer captures all required replay primitives for `slipstream-usdc-weth-100` at one safe block, when the state is served to a replay-capable client, the response is replay-eligible and carries block identity and completeness evidence.
- AE2. **Covers R3, R8.** Given one tick chunk or the dynamic fee read is missing, when `www` evaluates the replay state, it skips local replay, records the corresponding fallback reason, and uses the live Slipstream quoter.
- AE3. **Covers R5, R9, R12.** Given local replay matches the live quoter in shadow mode, when a user requests a quote, `www` still serves the live-quoter result until promotion is explicitly enabled.
- AE4. **Covers R7, R8.** Given replay state is observed through a block greater than the quote context block, when `www` evaluates freshness, it treats the state as unusable for that quote and falls back live.
- AE5. **Covers R10, R11.** Given the route-lab matrix runs both directions and representative amount bands, when any deterministic comparison field mismatches, the pool is not eligible for hot-path indexed replay.
- AE6. **Covers R13, R14.** Given the proof is ready for review, when an operator reads the route-lab or smoke output, they can see snapshot freshness, parity status, latency comparison, and every live fallback reason.

---

## Success Criteria

- `society-bots` can produce complete same-block replay state for `slipstream-usdc-weth-100` without weakening existing reserve or CL head behavior.
- `www` can locally replay representative exact-input Slipstream quotes in shadow mode and compare them to the live quoter at the same block.
- Route-lab or smoke evidence shows both directions, representative amount bands, exact-match parity where expected, and typed fallback where replay is unsafe.
- Planning can proceed without re-deciding the first milestone, quote authority boundary, parity threshold, or event-driven maintenance scope.

---

## Scope Boundaries

- No event-driven tick maintenance in the first milestone.
- No generic replay for other Slipstream, Slipstream2, Uniswap V3, or Uniswap V4 pools.
- No `society-bots` quote endpoint or route authority.
- No user-facing indexed CL quote results before shadow parity is proven and explicitly enabled.
- No tolerance-based production parity for deterministic fields.
- No stable-pool math, native-wrap changes, router changes, or exotic route promotion.
- No dashboards beyond the structured evidence needed to validate and operate this first proof.

---

## Key Decisions

- Snapshot-first proof: Full safe-block snapshots are the first milestone because they are easier to verify than an event reducer.
- One-pool scope: Limiting replay to `slipstream-usdc-weth-100` lets completeness and parity be binary.
- Raw state contract: `society-bots` serves replay primitives; `www` owns output quotes and fallback.
- Exact parity: A deterministic local replay mismatch is treated as a bug or incomplete state, not an acceptable tolerance.
- Shadow before promotion: Local replay must prove itself beside live quotes before it can replace the hot-path quoter call.

---

## Dependencies / Assumptions

- The live Slipstream quoter remains the validation oracle for this pool during the proof.
- `www` can obtain or retain a quote context suitable for same-block comparison.
- The full initialized tick state for this one `tickSpacing: 100` pool is small enough to snapshot and serve within acceptable provider and payload limits, or else the proof will report that limit explicitly.
- The exact dynamic fee used by Slipstream at the snapshot block can be read and represented as an integer replay input.
- Existing server-only helper authentication and fallback discipline remain the baseline for this work.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2, R3][Needs research] What is the measured initialized tick count, bitmap word count, provider call count, payload size, and snapshot duration for `slipstream-usdc-weth-100` at a recent safe block?
- [Affects R2, R10][Needs research] Which exact fee read path and integer units should be used for Slipstream replay parity?
- [Affects R9, R10][Technical] Should the first local replay implementation port only the needed V3 math into `www`, or reuse a package where it can still preserve exact Slipstream fee and rounding behavior?
- [Affects R13][Technical] Which existing route-lab or API debug surface should carry shadow parity evidence without exposing helper secrets or raw RPC details?
