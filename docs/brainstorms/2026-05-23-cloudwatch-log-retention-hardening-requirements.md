---
date: 2026-05-23
topic: cloudwatch-log-retention-hardening
---

# CloudWatch Log Retention Hardening

## Summary

Add explicit, managed CloudWatch log groups for the active Lambda surfaces in `society-bots`. Every Lambda log group must have a deliberate retention class, with 30-day retention for Ethereum, mixed-chain, and user-facing app audit logs, and 7-day retention for replay-tick and Base operational/eventing logs.

---

## Problem Frame

The FAME CL replay work made CloudWatch cost and signal quality more visible. Replay indexing can produce bulky diagnostic state, and the current pool-state API can become noisy once `www` leans on it more heavily. At the same time, the repo has several active Lambda surfaces outside pool-state, so fixing only one construct would leave the account with inconsistent retention behavior.

On `origin/main`, the active Lambda constructs in `deploy/lib/fame-pool-state.ts`, `deploy/lib/image-lambdas.ts`, and `deploy/lib/events-lambdas.ts` do not yet assign explicit, managed CloudWatch log groups. The cleanup pass needs to make retention intentional across the repo without changing quote authority, route ranking, event maintenance, or broader logging architecture.

---

## Actors

- A1. Infrastructure implementer: Adds retention classes, managed log groups, and assertions without disturbing unrelated Lambda behavior.
- A2. Production operator: Inspects logs during deploy, smoke, and incident review and needs predictable retention windows.
- A3. Pool-state/replay reviewer: Needs compact replay logs that prove freshness and failures without dumping raw tick payloads.
- A4. Future maintainer: Adds or re-enables Lambda constructs and should not accidentally create infinite-retention logs.

---

## Key Flows

- F1. Lambda log retention is synthesized
  - **Trigger:** CDK synth runs for the main or pool-state dev stack.
  - **Actors:** A1, A4
  - **Steps:** Each active Lambda is assigned one retention class, receives a managed log group, and is covered by CDK assertions for retention and attachment.
  - **Outcome:** A synthesized stack cannot quietly leave an active Lambda with the default unmanaged log group.
  - **Covered by:** R1, R2, R3, R4, R5

- F2. Runtime logs stay useful without ballooning
  - **Trigger:** The pool-state indexer or helper API handles normal traffic or replay failures.
  - **Actors:** A2, A3
  - **Steps:** Success logs emit compact structured summaries, replay and stale states remain visible, and failures carry enough typed context for diagnosis without secrets or raw replay payloads.
  - **Outcome:** Operators can diagnose replay/indexer health while routine traffic produces less INFO noise.
  - **Covered by:** R7, R8, R9, R10

- F3. Future Lambda surfaces are reviewed
  - **Trigger:** A contributor adds or re-enables a Lambda construct such as the Alchemy webhook.
  - **Actors:** A1, A4
  - **Steps:** The contributor must pick a retention class, attach a managed log group, and update tests if the active Lambda inventory changes.
  - **Outcome:** New CloudWatch log groups inherit the repo policy instead of becoming one-off defaults.
  - **Covered by:** R4, R5, R6, R11

---

## Requirements

**Retention policy**

- R1. Every active Lambda created by this CDK app must have a managed CloudWatch `LogGroup` attached through infrastructure code, not only an implicit Lambda-created default log group.
- R2. Managed log groups must carry explicit retention and explicit stack-deletion behavior so PR/dev cleanup and production behavior are intentional.
- R3. The retention class map must be:
  - Ethereum-only logs: 30 days.
  - Mixed Ethereum/Base logs: 30 days, because retention is per log group.
  - Discord/app-only user-facing logs: 30 days.
  - Replay-tick logs: 7 days.
  - Base eventing and Base-only operational logs: 7 days.
- R4. The first implementation must classify the active Lambdas in `deploy/lib/image-lambdas.ts`, `deploy/lib/events-lambdas.ts`, and `deploy/lib/fame-pool-state.ts`; no active Lambda may remain unclassified.
- R5. CDK tests must assert that active Lambdas have managed log groups and expected retention. The assertions must fail when a new active Lambda is added without an explicit retention decision.
- R6. Currently inactive Lambda constructs, including `deploy/lib/alchemy-webhook.ts`, do not need deployed log groups in this pass, but re-enabling them must require an explicit retention class.

**Pool-state log signal**

- R7. Pool-state indexer and API logs must keep stable event names for existing operational signals, including `fame-pool-state-indexed` and `fame-pool-state-api-batch`.
- R8. Pool-state success logs must be compact by default. They may include counts, block identity, state hashes, status counts, durations, and failure summaries, but must not include service tokens, full RPC URLs, raw tick arrays, raw request bodies, or raw replay payloads.
- R9. Pool-state replay failures, stale replay requests, incomplete replay state, and unsupported replay surfaces must remain visible at INFO or error level according to operator value; ordinary all-fresh success traffic should not become a high-volume INFO stream.
- R10. Structured application logs that are meant for CloudWatch filtering must include a clear level and event name.

**Documentation and operation**

- R11. The operational docs must state the retention classes, active Lambda classification, and how to verify the deployed log groups after a dev or PR deploy.
- R12. This pass must preserve the existing passive-alarm posture. Adding metric filters or paging destinations is not required unless the implementation makes a narrow, low-risk metric filter nearly free.
- R13. The work must not change `www` quote behavior, introduce a `society-bots` quote endpoint, alter route ranking, or change replay tick maintenance.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R5.** Given CDK synth runs for the main stack, when the template is inspected, every active Lambda has an attached managed log group with explicit retention and deletion behavior.
- AE2. **Covers R3, R4.** Given `FlsThumb`, `FlsMosaic`, `WrapEvent`, or a mixed Ethereum/Base event Lambda is synthesized, when retention is inspected, the associated log group retains logs for 30 days.
- AE3. **Covers R3, R4.** Given the pool-state indexer, pool-state API, or pool-state authorizer is synthesized, when retention is inspected, the associated log group retains logs for 7 days.
- AE4. **Covers R3, R4.** Given Discord interaction or deferred-message Lambdas are synthesized, when retention is inspected, the associated log groups retain logs for 30 days.
- AE5. **Covers R3, R4.** Given Base-only image or eventing Lambdas are synthesized, when retention is inspected, the associated log groups retain logs for 7 days unless deliberately reclassified.
- AE6. **Covers R5, R6.** Given a new active Lambda is added or an inactive webhook construct is re-enabled without retention classification, when tests run, the infrastructure assertions fail.
- AE7. **Covers R7, R8, R9, R10.** Given a normal pool-state API batch has only fresh, non-replay data, when it logs success, the log is compact or gated; given replay state is stale, incomplete, or failed, the log keeps an operator-visible event with no raw tick payload.
- AE8. **Covers R11, R12, R13.** Given the cleanup PR is reviewed, when a reviewer checks docs and tests, they can verify retention without seeing unrelated quote, route, or paging behavior changes.

---

## Success Criteria

- Every active Lambda log group produced by this repo has a deliberate retention policy after deploy.
- CDK assertions protect against future unclassified Lambda log groups.
- Replay-tick and Base operational logs are bounded to 7 days, while Ethereum, mixed-chain, and user-facing app audit logs retain 30 days.
- Pool-state logging remains useful for replay/freshness diagnosis without raw tick payloads or repetitive low-value INFO traffic.
- A downstream planner can build the cleanup without re-deciding retention classes, `LogGroup` vs `logRetention`, or the quote-surface boundary.

---

## Scope Boundaries

- Do not split mixed-chain Lambdas only to get per-chain retention.
- Do not add a backend quote endpoint, alter `www` quote behavior, or change route ranking.
- Do not change replay tick maintenance strategy or CL quote math.
- Do not migrate the entire repo to a new logging framework in this pass.
- Do not add paging destinations or broad alerting policy changes.
- Do not require metric filters, dashboards, or Logs Insights query packs for the first implementation.

---

## Key Decisions

- Managed log groups: Use explicit CDK-owned log groups instead of Lambda `logRetention`, because log group ownership, cleanup, and future metric-filter attachment are clearer.
- Longest retention for mixed-chain logs: If Ethereum and Base logs share one Lambda log group, the log group gets 30-day retention.
- App audit class: Discord/app-only user-facing logs get 30-day retention because they may explain user-visible bot behavior later.
- Short replay and Base operational retention: Replay-tick, Base eventing, and Base-only operational/image logs get 7-day retention to cap high-volume operational noise.
- Narrow log-noise cleanup: Improve pool-state/replay log compactness now, but defer any broad logging framework rewrite.

---

## Dependencies / Assumptions

- The active Lambda inventory for this pass is the set created by `deploy/lib/image-lambdas.ts`, `deploy/lib/events-lambdas.ts`, and `deploy/lib/fame-pool-state.ts` on `origin/main`.
- The inactive Alchemy webhook construct is not deployed today; if it is re-enabled, it should be treated as mixed-chain unless the implementation separates chain-specific logging.
- Base-only image Lambdas are treated as Base operational logs and receive 7-day retention unless a future product decision reclassifies them as app audit logs.
- Existing pool-state event names are useful enough to preserve for current docs, smoke checks, and operator searches.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1, R2, R5][Technical] Decide the exact helper shape for creating managed log groups without duplicating boilerplate across construct files.
- [Affects R2][Technical] Decide the deletion policy for production-managed log groups when a stack is destroyed.
- [Affects R7, R8, R9, R10][Technical] Decide whether pool-state log compactness should be implemented with a tiny local logger helper, direct structured logging cleanup, or both.
- [Affects R11][Technical] Decide the exact docs location for the retention-class table and deployment verification checklist.
