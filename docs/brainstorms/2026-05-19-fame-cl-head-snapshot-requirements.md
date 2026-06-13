---
date: 2026-05-19
topic: fame-cl-head-snapshot
---

# FAME CL Head Snapshot Requirements

## Summary

Add a bite-sized concentrated-liquidity head snapshot lane for FAME route dependencies. `society-bots` should index and serve complete current head state for eligible CL pools, while `www` keeps quote authority and falls back to live reads for quote output.

Project identity note: `www` refers to the GitHub project `fame-lady-society/www`. On this machine, that companion checkout is cloned as `../fls-www`, not `../www`.

---

## Problem Frame

The shipped FAME pool-state helper only indexes constant-product reserve rows for quote-model pools. The remaining tracked-only route dependencies include Slipstream, Slipstream2, Uniswap V3, and Uniswap V4 pools whose live adapters already read current pool head state before quoting.

The immediate gap is not local CLMM replay. It is that `society-bots` has no typed, fresh, provenance-aware latest-state row for the CL head primitives that `www` already knows how to read live. Without that lane, every non-reserve route remains invisible to the helper except as `unsupported`, and downstream tooling cannot inspect whether fresh CL market state is available.

---

## Actors

- A1. `www` route tooling: Owns reviewed route metadata, live quote adapters, parity evidence, and public quote responses.
- A2. `society-bots` pool-state service: Owns generated-registry validation, latest-state indexing, freshness attribution, and authenticated helper responses.
- A3. Planner / implementer: Turns this requirements document into a concrete cross-repo implementation plan.

---

## Key Flows

- F1. CL route dependency becomes snapshot-eligible
  - **Trigger:** `www` exports a route dependency whose state surface is CL head snapshot.
  - **Actors:** A1, A2
  - **Steps:** The generated helper registry identifies the dependency as eligible for CL head state; `society-bots` validates the identity, venue family, fee/tick metadata, and pool address or V4 pool key; ineligible or unsupported entries remain explicit.
  - **Outcome:** `society-bots` has a generated, typed source of truth for which CL dependencies it may index.
  - **Covered by:** R1, R2, R3

- F2. CL head state is observed
  - **Trigger:** The pool-state indexer observes a safe Base block.
  - **Actors:** A2
  - **Steps:** For each snapshot-eligible CL dependency, `society-bots` reads the current pool head primitives at the same safe block context, accepts only complete snapshots, attributes them to the generated registry, and records observed-through freshness.
  - **Outcome:** Each eligible dependency has either a complete latest CL head snapshot or no fresh snapshot; partial head rows are not treated as fresh state.
  - **Covered by:** R4, R5, R6, R7

- F3. CL head state is consumed safely
  - **Trigger:** A server-side `www` caller or route-lab path asks the helper for pool state.
  - **Actors:** A1, A2
  - **Steps:** The helper returns typed CL head entries with freshness and provenance, or returns normal fallback statuses when state is unavailable, unsupported, unknown, stale, or mismatched. `www` may inspect the snapshot but still uses live quote adapters for final quote output.
  - **Outcome:** CL head snapshots become visible market-state evidence without becoming quote authority.
  - **Covered by:** R8, R9, R10, R11

---

## Requirements

**Registry and Eligibility**
- R1. The generated helper registry must distinguish concentrated-liquidity head-snapshot eligibility from generic tracked-only `concentrated-liquidity` unsupported status.
- R2. Snapshot eligibility must come from `www`-generated route dependency metadata; `society-bots` must not discover or hand-curate additional CL pools independently.
- R3. The first slice must cover exported Slipstream, Slipstream2, Uniswap V3, and Uniswap V4 route dependencies only when the generated metadata supplies the identity and fee/tick-spacing inputs needed to read their head state safely.

**Snapshot Content**
- R4. A CL head snapshot must be complete for its venue family before it is considered fresh: pool identity, token identity, venue family, fee/tick metadata, current price head, current tick, active liquidity, observed-through block, source reader, and source registry id.
- R5. V4 snapshots must identify pools by generated pool key or pool id rather than by a pool address.
- R6. A failed, missing, malformed, or internally inconsistent head read must not produce a fresh partial snapshot.
- R7. The snapshot lane must record freshness by `observedThroughBlock`, preserving the existing rule that future-block helper rows are stale for an older quote context.

**Helper Response and Fallback**
- R8. The helper must expose CL head snapshots as a typed market-state entry distinct from constant-product reserve rows.
- R9. The helper must preserve normal per-pool fallback statuses for unavailable CL head state: stale, unknown, and unsupported are successful response entries, while malformed input, auth failure, incomplete reads, and dependency failures remain transport-level failures.
- R10. A fresh CL head snapshot must not imply local quote replay, tick-boundary safety, or final quote authority.
- R11. Clients must not require a boundary warning, nearest initialized tick, tick bitmap, or initialized tick data in order to fall back to live reads.

**Evidence and Handoff**
- R12. The slice must include tests or route-lab/operator evidence showing at least one fresh CL head snapshot and at least one safe fallback case.
- R13. Documentation must make the new guarantee plain: `society-bots` serves complete CL head market state, and `www` decides whether to use live reads for quote output.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given a generated `www` helper registry entry for a Uniswap V3 route dependency with CL head snapshot eligibility, when `society-bots` loads the registry, it treats the entry as eligible for the CL head snapshot lane rather than as generic unsupported concentrated liquidity.
- AE2. **Covers R4, R6.** Given an eligible CL pool whose active liquidity read fails at the safe block, when the indexer processes that pool, it does not write or serve a fresh partial head snapshot.
- AE3. **Covers R7, R9.** Given a stored CL head snapshot observed through a block greater than the caller's quote context block, when the helper evaluates freshness, it returns a stale pool-state entry rather than treating the row as fresh.
- AE4. **Covers R8, R10, R11.** Given a fresh CL head snapshot with no tick-window or boundary-warning fields, when `www` consumes the helper response, it can inspect the market state and still call its live quote adapter for final output.
- AE5. **Covers R12, R13.** Given the first implementation is ready for review, when release evidence is attached, reviewers can see one fresh CL head snapshot, one fallback case, and documentation that the lane is not CL quote replay.

---

## Success Criteria

- Fresh CL head state is visible through the helper for at least one eligible route dependency without weakening live fallback behavior.
- Downstream planning can proceed without inventing whether this slice owns tick windows, boundary warnings, quote receipts, stable-pool state, or local CLMM replay.
- The requirements preserve the cross-repo authority split: `www` owns quote correctness; `society-bots` owns attributed latest-state availability.

---

## Scope Boundaries

- No boundary-risk reporting, nearest initialized tick reads, tick bitmap reads, active tick-window cache, or local CL quote replay.
- No exact quote receipt cache, stable shadow state, native-wrap state, short-TTL journal, full historical analytics, or public market-state/chart API.
- No independent pool discovery or hand-curated pool metadata in `society-bots`.
- No production quote-path reliance on CL head snapshots in this slice; live quote fallback remains normal.

---

## Key Decisions

- Head snapshots are complete, not partial: a row missing required head primitives is unavailable rather than fresh-but-incomplete.
- Boundary warnings are not required: clients already have the safer fallback path of live reads, and this slice does not attempt to classify tick-boundary risk.
- The first CL lane is observational market state: it may improve diagnostics and later planning, but it does not promise quote acceleration by itself.

---

## Dependencies / Assumptions

- `www` can update its generated helper registry export to identify CL head snapshot eligibility for route dependencies.
- The existing freshness and fallback semantics in `docs/fame-pool-state-index.md` remain the baseline for this lane.
- Venue-specific reader details are planning work, but the required head primitives are already represented in `www` live route-lab and adapter behavior.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3, R4][Technical] Which exact venue-family reader calls and metadata fields are needed to classify a Slipstream, Slipstream2, Uniswap V3, or Uniswap V4 head snapshot as complete?
- [Affects R8, R9][Technical] Should CL head entries be added to the existing helper response shape or introduced through a versioned market-state response surface?
