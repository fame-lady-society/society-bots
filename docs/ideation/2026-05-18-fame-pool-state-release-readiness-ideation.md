---
date: 2026-05-18
topic: fame-pool-state-release-readiness
focus: release readiness for the new FAME pool-state indexer and quote helper API
mode: repo-grounded
---

# Ideation: FAME Pool-State Release Readiness

## Grounding Context

The current dirty worktree adds a new `src/fame-swap-pool-state` module, a generated Base pool registry, a scheduled indexer Lambda, DynamoDB latest-state and cursor helpers, an authenticated `POST /fame/pool-state` API, and CDK wiring through `deploy/lib/fame-pool-state.ts`, `deploy/lib/deploy-stack.ts`, and `deploy/lib/http-api.ts`.

Project identity note: `www` refers to the GitHub project `fame-lady-society/www`. On this machine, that companion checkout is cloned as `../fls-www`, not `../www`.

The registry currently covers 21 reviewed route-candidate pools from `www`: 7 quote-model pools and 14 tracked-only pools. `www` remains authoritative for route metadata, venue capability, and quote parity. `society-bots` owns only the indexed latest-state read model.

Important release context from the handoff:

- Freshness is based on `observedThroughBlock`, not `lastReserveChangeBlock`.
- Unsupported, stale, unknown, or malformed indexed state should make `www` fall back to live reads.
- The real release gate is not deploy alone. It is deploy plus recent indexer progress plus `www` route-lab indexed parity.
- Production auto-deploys from `main`, so missing workflow env or broken deploy checks become production blockers immediately.

External grounding:

- DynamoDB `BatchGetItem` can partially succeed and return `UnprocessedKeys`; callers must retry or handle partial reads explicitly.
- Scheduled Lambda failures are asynchronous operational events; retry, destination/DLQ, and alarms are part of release readiness.
- GitHub Actions unset secrets evaluate to empty strings. Environment gates and OIDC-backed AWS access are stronger deployment patterns.

Primary sources used by the external grounding pass:

- AWS DynamoDB `BatchGetItem`: https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html
- DynamoDB error handling: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html
- Lambda async retries: https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html
- Lambda with EventBridge Scheduler: https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html
- GitHub AWS OIDC: https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws
- GitHub environments: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments

## Topic Axes

- Deployment gates
- Runtime failure semantics
- Operational observability
- Cross-repo quote parity

## Ranked Ideas

### 1. Pre-Deploy Secret And Config Gate

**Description:** Add a required workflow preflight that fails before CDK deploy when `FAME_POOL_STATE_SERVICE_TOKEN`, `BASE_RPCS_JSON`, or any other release-critical FAME pool-state env resolves to an empty value. Wire the token into the main deploy workflow and the PR deploy workflow, then make the preflight output name the missing variable.

**Axis:** Deployment gates

**Basis:** `direct:` `deploy/lib/deploy-stack.ts` passes `process.env.FAME_POOL_STATE_SERVICE_TOKEN ?? ""` into a construct that fails fast on an empty token. `external:` GitHub Actions unset secrets evaluate to empty strings.

**Rationale:** This is the highest-value release gate because a merge to `main` auto-deploys. The current code correctly fails fast, but the workflow must provide the secret or production deploy will fail.

**Downsides:** Requires secret provisioning and a small workflow change before PR readiness. It may expose that PR deploy environments need separate secret ownership.

**Confidence:** 98%

**Complexity:** Low

**Status:** Unexplored

### 2. Split Root Jest And Deploy Jest Discovery

**Description:** Scope root Jest to source tests, or configure Jest projects so deploy/CDK tests run only under the deploy package config. Keep `deploy/test/fame-pool-state.test.ts` as an explicit deploy validation path.

**Axis:** Deployment gates

**Basis:** `direct:` full root Jest discovers `deploy/test/fame-pool-state.test.ts` and compiles it under the root `tsconfig`, where `deploy/lib/fame-pool-state.ts` is outside `rootDir`.

**Rationale:** PR readiness needs clean, deterministic validation commands. A known false-negative test failure makes it too easy to ignore red test output during release.

**Downsides:** Requires deciding whether root Jest should ignore all `deploy/` tests or use a multi-project setup. Multi-project Jest is slightly more config than a simple ignore.

**Confidence:** 96%

**Complexity:** Low

**Status:** Unexplored

### 3. Typed Failure Semantics For The Pool-State API

**Description:** Replace the Lambda handler's blanket catch-to-`400` behavior with a small typed error contract. Validation errors stay `400`, unauthorized stays `401`, expected stale/unknown/unsupported pool states remain normal response entries, and dependency/internal failures become structured `5xx` responses with logs that operators can alarm on.

**Axis:** Runtime failure semantics

**Basis:** `direct:` `src/fame-swap-pool-state/lambdas/api.ts` catches every error from JSON parse through DynamoDB access and returns `400`. `reasoned:` `www` can fall back on any malformed helper response, but operators still need to distinguish caller mistakes from service degradation.

**Rationale:** This preserves quote safety while improving release observability. A failing DynamoDB read should not look like a caller sent a bad request.

**Downsides:** Requires introducing explicit error classes or a narrow result type. The contract must stay simple so `www` fallback remains boring.

**Confidence:** 90%

**Complexity:** Medium

**Status:** Unexplored

### 4. DynamoDB BatchGet Completeness Contract

**Description:** Treat `UnprocessedKeys` from DynamoDB `BatchGetItem` as incomplete data. Retry with a bounded policy or surface an explicit partial-read failure that `www` will not treat as authoritative quote state.

**Axis:** Runtime failure semantics

**Basis:** `direct:` `batchGetLatestPoolStates` currently reads `Responses` and ignores `UnprocessedKeys`. `external:` DynamoDB documents partial success as normal `BatchGetItem` behavior.

**Rationale:** Silent partial reads are dangerous because they can turn fresh indexed pools into apparent missing state, or worse, make a response look complete when it is not.

**Downsides:** Bounded retry adds a little latency to a quote-adjacent path. Failing loud may increase live fallback frequency under DynamoDB pressure, which is the correct tradeoff for quote correctness.

**Confidence:** 94%

**Complexity:** Medium

**Status:** Unexplored

### 5. Indexer Failure Envelope And Freshness SLO

**Description:** Add an operational envelope for the scheduled indexer: async failure handling, DLQ or failure destination, CloudWatch alarms, and a freshness metric/threshold around lag from Base head to cursor `observedThroughBlock`.

**Axis:** Operational observability

**Basis:** `direct:` release safety depends on recent `observedThroughBlock`, not merely successful deployment. `external:` scheduled Lambda failures and async retries need explicit operational handling.

**Rationale:** The indexer can be deployed and still not be useful if it stops advancing, times out, or hits RPC limits. The primary production SLO should be "indexed through a recent safe block."

**Downsides:** Requires CDK alarm/destination wiring and agreement on thresholds. The simplest first version may need manual alarm actions rather than a full incident workflow.

**Confidence:** 88%

**Complexity:** Medium

**Status:** Unexplored

### 6. Live API Smoke Plus Short Schedule Soak

**Description:** Before enabling production quote consumption in `www`, run a deployed smoke that authenticates against `POST /fame/pool-state`, checks response shape and non-empty fresh pool state, and records a short schedule/RPC soak showing duration, scanned block ranges, cursor advancement, and error/throttle counts.

**Axis:** Deployment gates

**Basis:** `direct:` the handoff requires deploy with Base RPCs and token, recent indexer logs, then `www` route-lab proof. `reasoned:` a local test suite cannot prove live token, IAM, Lambda, DynamoDB, RPC, and API Gateway integration.

**Rationale:** This bridges the gap between "CDK synthesized" and "the helper is usable in the production-like path." It is also the fastest way to catch missing IAM, bad env, stale cursor, or RPC throttling.

**Downsides:** Needs a deployed environment and a service token available to the smoke runner. A long soak is not necessary for PR readiness, but a short one should exist before production enablement.

**Confidence:** 86%

**Complexity:** Medium

**Status:** Unexplored

### 7. Route-Lab Indexed Parity Release Gate

**Description:** Make `www` route-lab indexed mode the final release gate before setting `FAME_POOL_STATE_API_URL` and `FAME_POOL_STATE_SERVICE_TOKEN` for production quote solving. Capture the route-lab output in the release checklist.

**Axis:** Cross-repo quote parity

**Basis:** `direct:` the handoff says `www` remains quote authority and must fall back on stale, unknown, unsupported, or malformed indexed state. `direct:` `docs/fame-pool-state-index.md` already lists route-lab indexed proof as a rollout check.

**Rationale:** Infra readiness is not the same as quote readiness. The consuming solver path is the only place where route choice, freshness policy, fallback behavior, and response parsing meet.

**Downsides:** Cross-repo release gates are more cumbersome than single-repo CI. The first version can be a manual attach-to-PR step rather than full automation.

**Confidence:** 92%

**Complexity:** Medium

**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | One-command release readiness probe | Good eventual wrapper, but too meta until the underlying gates exist. |
| 2 | Black box flight recorder for every sync run | Useful later, but lower release value than basic freshness metrics, alarms, and DLQ/failure destination. |
| 3 | Runbook as standalone deliverable | Valuable, but should be attached to the operational envelope and rollout docs rather than replacing runtime gates. |
| 4 | Observed-through API contract as separate idea | The API already returns `observedThroughBlock` for fresh/stale states; remaining value is covered by freshness SLO and route-lab parity. |
| 5 | Secret gate variants from multiple frames | Duplicate of ranked idea 1. |
| 6 | Jest split variants from multiple frames | Duplicate of ranked idea 2. |
| 7 | Blanket-400 variants from multiple frames | Duplicate of ranked idea 3. |
| 8 | BatchGet partial-read variants from multiple frames | Duplicate of ranked idea 4. |
| 9 | Separate DLQ, alarm, cursor-lag, and freshness ideas | Combined into ranked idea 5 because they are one operational readiness bundle. |
