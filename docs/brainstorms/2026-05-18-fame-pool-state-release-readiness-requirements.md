---
date: 2026-05-18
topic: fame-pool-state-release-readiness
---

# FAME Pool-State Release Readiness

## Summary

Define the release gates for the FAME pool-state indexer and authenticated quote helper API before PR merge and production consumption. The release is ready only when deployment configuration, local validation, API failure semantics, DynamoDB read completeness, indexer observability, live smoke evidence, and `www` route-lab parity all have clear pass/fail signals.

Project identity note: `www` refers to the GitHub project `fame-lady-society/www`. On this machine, that companion checkout is cloned as `../fls-www`, not `../www`.

---

## Problem Frame

The current worktree adds a new `src/fame-swap-pool-state` module, a generated Base pool registry, a scheduled indexer Lambda, DynamoDB latest-state/cursor storage, an authenticated `POST /fame/pool-state` API, and CDK wiring. Once merged to `main`, this repo auto-deploys to production, so release readiness cannot rely on local tests alone.

The riskiest failure modes are not quote math changes inside `society-bots`; `www` remains the quote authority. The risk is that the helper API deploys with missing secrets, ambiguous errors, partial DynamoDB reads, stale indexed state, or insufficient operational proof, causing `www` to fall back unexpectedly or operators to miss a degraded indexer.

---

## Actors

- A1. `society-bots` release owner: Prepares the PR, validates the release gates, and decides whether the branch is ready to merge.
- A2. `www` quote solver: Consumes the authenticated helper API from server-side quote paths and falls back to live reads when indexed state is not acceptable.
- A3. Production operator: Needs clear signals when the indexer, DynamoDB reads, auth, or freshness degrade after deployment.
- A4. Downstream planner/implementer: Uses this requirements doc to plan fixes without inventing release policy.

---

## Key Flows

- F1. PR readiness validation
  - **Trigger:** The FAME pool-state branch is being prepared for PR or merge.
  - **Actors:** A1, A4
  - **Steps:** Run local source/deploy validation, confirm deploy workflow env is wired, confirm root/deploy tests are scoped correctly, and review remaining release evidence.
  - **Outcome:** The PR has deterministic local and CI-facing gates instead of known false negatives or missing deploy config.
  - **Covered by:** R1, R2, R9

- F2. Deployed helper health proof
  - **Trigger:** The stack is deployed to a production-like or production environment.
  - **Actors:** A1, A3
  - **Steps:** Verify authenticated API access, verify fresh indexed pool state, confirm scheduled indexer advancement, and record smoke/soak evidence.
  - **Outcome:** The deployed helper is proven callable, fresh enough, and operationally visible before `www` relies on it.
  - **Covered by:** R5, R6, R7, R8

- F3. Cross-repo quote consumption proof
  - **Trigger:** `www` is ready to test indexed quote mode against the deployed helper.
  - **Actors:** A1, A2
  - **Steps:** Run route-lab indexed mode with production-like helper env, compare selected quote behavior against the authoritative live path, and capture pass/fail output.
  - **Outcome:** Production quote consumption is enabled only after indexed helper behavior preserves quote correctness and fallback expectations.
  - **Covered by:** R8, R10, R11

---

## Requirements

**Deployment Gates**

- R1. The release must fail before CDK deployment when any FAME pool-state required deployment configuration is missing or empty, including the service token and Base RPC configuration.
- R2. The main deploy workflow and PR deploy workflow must provide the FAME pool-state service token through the intended GitHub secret or environment mechanism.
- R3. Root test execution must not accidentally run deploy/CDK tests under the root TypeScript configuration.
- R4. Deploy/CDK tests must remain explicitly runnable as part of release validation.

**Runtime Failure Semantics**

- R5. The pool-state API must distinguish malformed requests and failed auth from dependency or internal failures in a way that `www` can safely treat as non-authoritative helper output.
- R6. Expected per-pool states, including `fresh`, `stale`, `unknown`, and `unsupported`, must remain normal response entries rather than transport-level failures.
- R7. DynamoDB batch reads must not silently treat `UnprocessedKeys` as complete results. The release must either retry to completeness within a bounded policy or fail loudly enough that `www` will not use partial helper state as authoritative.

**Operational Observability**

- R8. The scheduled indexer must have an operator-visible failure path for failed asynchronous invocations, repeated failures, or missed progress.
- R9. Release evidence must include a freshness signal based on cursor or response `observedThroughBlock`, not only Lambda invocation success.
- R10. A deployed smoke check must prove authenticated `POST /fame/pool-state` access, valid response shape, and at least one expected fresh quote-model pool response.
- R11. A short schedule/RPC soak or equivalent operational proof must record whether the indexer advances safely under the configured cadence without repeated timeout, throttling, or cursor-lag growth.

**Cross-Repo Quote Parity**

- R12. Production quote consumption in `www` must not be enabled until route-lab indexed mode passes against the deployed helper using production-like service env.
- R13. Route-lab evidence must cover successful indexed reads and fallback-relevant cases such as stale, unknown, unsupported, malformed, or unavailable helper output.
- R14. The release checklist must capture where the route-lab evidence lives so reviewers can verify the final gate without rerunning it from memory.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given the deploy workflow lacks the FAME pool-state service token, when the deploy job runs, it fails before applying infrastructure changes and identifies the missing configuration.
- AE2. **Covers R3, R4.** Given a developer runs root tests, deploy/CDK tests are not compiled under the root TypeScript config; given the deploy test command runs, the FAME pool-state CDK assertions still execute.
- AE3. **Covers R5, R6.** Given a malformed API payload, the helper reports a request failure; given a valid request for stale or unsupported pool state, the helper returns a normal per-pool status that `www` can fall back from.
- AE4. **Covers R7.** Given DynamoDB returns unprocessed keys for a batch read, the helper does not return a successful response that pretends those missing items were fully evaluated.
- AE5. **Covers R8, R9.** Given the scheduled indexer stops advancing `observedThroughBlock`, an operator-visible signal exists before quote consumers silently depend on stale state.
- AE6. **Covers R10, R11.** Given the stack is deployed with production-like configuration, the release owner can show a smoke/soak result proving authenticated API access and recent indexer progress.
- AE7. **Covers R12, R13, R14.** Given `www` route-lab indexed mode is run against the deployed helper, the release checklist records pass/fail evidence for indexed success and fallback behavior before production env is enabled.

---

## Success Criteria

- The PR has no known release-blocking validation failure caused by test discovery, missing workflow env, or unchecked required config.
- The helper API fails safely and observably: bad caller input, auth failures, partial reads, and dependency failures are distinguishable enough for `www` fallback and operator diagnosis.
- The scheduled indexer has a release-visible freshness and failure signal centered on `observedThroughBlock`.
- A reviewer can find local test/typecheck results, deploy smoke/soak evidence, and `www` route-lab parity evidence without reconstructing the process from chat history.
- A downstream planner can turn this doc into implementation tasks without deciding what counts as release-ready.

---

## Scope Boundaries

- This document does not require new pool math, stable-pool replay, concentrated-liquidity replay, route expansion, or changes to `www` quote authority.
- This document does not require a full incident-management system, long-term canary deployment strategy, or migration to GitHub OIDC, though those remain reasonable future hardening work.
- This document does not require fully automated cross-repo CI for route-lab parity in the first pass; captured manual or semi-automated evidence is acceptable for this release.
- This document does not require changing the generated registry source of truth. Registry metadata remains owned by `www`.
- This document does not implement the fixes. It defines the release-readiness requirements for planning.

---

## Key Decisions

- Full bundle scope: The release-readiness work covers all seven ranked ideation gates rather than only PR blockers or only operational proof.
- Fail-loud over silent ambiguity: Helper degradation should remain safe for quotes, but operators need visible failure classes and freshness signals.
- `www` remains quote authority: Readiness is proven at the consuming quote path through route-lab parity, not by expanding `society-bots` quote responsibilities.
- Manual evidence is acceptable initially: Live smoke, short soak, and route-lab proof may be captured manually or semi-automatically for this PR if the evidence is durable and reviewable.

---

## Dependencies / Assumptions

- GitHub secrets or environment variables can be provisioned for `FAME_POOL_STATE_SERVICE_TOKEN` in the workflows that deploy this stack.
- A production-like deployed endpoint and service token will be available for smoke and route-lab validation before production quote consumption is enabled.
- `www` route-lab indexed mode already exists in `fame-lady-society/www` (local checkout `../fls-www`) or is available from the companion work described in `docs/fame-pool-state-handoff.md`.
- The first release can rely on documented smoke/soak evidence rather than a fully automated deployment gate for every operational proof item.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R2][Technical] Decide the exact workflow mechanism for required-env preflight and secret provisioning across main and PR deploys.
- [Affects R5, R6][Technical] Decide the exact transport status and response-body shape for typed helper failures.
- [Affects R7][Technical] Decide whether DynamoDB `UnprocessedKeys` should be retried in-process, surfaced immediately, or handled by a tiny bounded hybrid.
- [Affects R8, R9][Technical] Decide the concrete alarm thresholds and destinations for indexer failure and freshness lag.
- [Affects R10, R11][Needs research] Decide how long the initial schedule/RPC soak must run to be persuasive before production enablement.
- [Affects R12, R13, R14][Cross-repo] Decide the exact route-lab command/output format reviewers should attach to the PR or release checklist.
