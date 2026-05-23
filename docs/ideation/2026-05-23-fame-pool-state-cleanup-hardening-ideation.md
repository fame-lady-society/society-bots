---
date: 2026-05-23
topic: cloudwatch-log-retention-cleanup-hardening
focus: repo-wide CloudWatch log retention, structured logging, and operational hardening after the first FAME CL replay slice
mode: repo-grounded
---

# Ideation: CloudWatch Log Retention And FAME Pool-State Hardening

## Grounding Context

The FAME pool-state helper has moved from release-readiness into a post-merge hardening phase. `main` now includes the first replayable `slipstream-usdc-weth-100` slice, including `cl-replay-v1` snapshots, registry schema v3, replay chunk TTLs, metadata-only stale replay responses, and Lambda failure semantics for CL replay capture failures.

The cleanup scope is now broader than the pool-state helper alone: every active CloudWatch log group created by this CDK app should have an explicit retention posture. The requested policy is:

- **Ethereum-related logs:** 30-day retention.
- **Replay-tick-related logs:** 7-day retention.
- **Base eventing-related logs:** 7-day retention.
- **Everything else:** explicitly classified during implementation; do not leave default infinite retention by accident.

Current active Lambda inventory from `deploy/lib`:

| Construct file | Lambda | Chain or domain signal | Proposed retention class |
|---|---|---|---|
| `deploy/lib/image-lambdas.ts` | `FameThumb` | `BASE_RPCS_JSON` image route | Base-related, 7 days unless split from eventing |
| `deploy/lib/image-lambdas.ts` | `Mosaic` | `BASE_RPCS_JSON` image route | Base-related, 7 days unless split from eventing |
| `deploy/lib/image-lambdas.ts` | `FlsThumb` | `MAINNET_RPCS_JSON` image route | Ethereum, 30 days |
| `deploy/lib/image-lambdas.ts` | `FlsMosaic` | `MAINNET_RPCS_JSON` image route | Ethereum, 30 days |
| `deploy/lib/events-lambdas.ts` | `interactionHandler` | Discord interaction and notification tables | App/Discord, explicitly classify |
| `deploy/lib/events-lambdas.ts` | `deferredMessage` | Discord deferred message queue | App/Discord, explicitly classify |
| `deploy/lib/events-lambdas.ts` | `FameEvent` | `BASE_RPCS_JSON`, `SEPOLIA_RPCS_JSON`, `MAINNET_RPCS_JSON` | Mixed chain/eventing, choose 30 days or split later |
| `deploy/lib/events-lambdas.ts` | `WrapEvent` | `SEPOLIA_RPCS_JSON`, `MAINNET_RPCS_JSON` | Ethereum, 30 days |
| `deploy/lib/fame-pool-state.ts` | `FamePoolStateIndexer` | Base CL replay and tick snapshots | Replay-tick, 7 days |
| `deploy/lib/fame-pool-state.ts` | `FamePoolStateApi` | Base CL replay helper API | Replay-tick, 7 days |
| `deploy/lib/fame-pool-state.ts` | `FamePoolStateApiAuthorizer` | Pool-state API auth | Replay-tick support, 7 days |
| `deploy/lib/alchemy-webhook.ts` | `SwapSchwing` | `MAINNET_RPCS_JSON`, `SEPOLIA_RPCS_JSON`, `BASE_RPCS_JSON` | Inactive today; if re-enabled, mixed chain, choose 30 days or split later |

Important current facts:

- The DynamoDB table has TTL on replay chunk rows through `expiresAt`.
- The indexer failure queue has a 7-day SQS retention period.
- The indexer has passive CloudWatch alarms for Lambda errors, Lambda throttles, missed invocations, and non-empty failure queue depth.
- The clean worktree from `origin/main` has no explicit retention policy on the active Lambda log groups yet, including the pool-state indexer, API, and authorizer Lambdas.
- The pool-state, image, event, and currently inactive webhook Lambda constructs all need explicit retention policy decisions before the repo can say CloudWatch logs are managed intentionally.
- The indexer logs one structured `fame-pool-state-indexed` payload per run; API logs one `fame-pool-state-api-batch` payload per request; CL replay failures log an error payload and then throw.
- Docs already separate `www` quote authority from `society-bots` state production. This cleanup pass should not drift into route ranking, backend CL quote endpoints, or public quote-surface optimization.

External grounding:

- AWS CDK Lambda `FunctionProps` supports a user-provided `logGroup`; the local CDK docs note that Lambda-created default log groups cannot be customized through CDK, and recommend `logGroup` for a fully customizable log group.
- AWS CDK `aws_logs.LogGroup` supports `retention` and `removalPolicy`; `RetentionDays` includes `ONE_WEEK`, `ONE_MONTH`, and `INFINITE`.
- AWS CDK `aws_logs.LogRetention` also exists but is a custom-resource retention controller. The Lambda docs describe `logRetention` as the legacy approach and `logGroup` as the fuller user-controlled approach.
- AWS Lambda supports JSON log format and application/system log level filtering. For custom JSON logs to participate in application-level filtering, log events need a valid `level` field.

Primary external sources:

- AWS CDK `LogGroup`: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_logs.LogGroup.html
- AWS CDK `LogRetention`: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_logs.LogRetention.html
- AWS CDK `RetentionDays`: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_logs.RetentionDays.html
- AWS Lambda log-level filtering: https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-log-level.html
- AWS Lambda log format: https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-logformat.html

## Topic Axes

- Repo-wide CloudWatch retention and cost controls
- Log signal quality
- Deploy and smoke guardrails
- Operational metrics and inspection
- Existing cleanup debt

## Ranked Ideas

### 1. Repo-Wide Lambda Retention Class Helper

**Description:** Add a small CDK helper for Lambda log retention classes and require every active Lambda construct to opt into one class: `ethereum` maps to `RetentionDays.ONE_MONTH`, `replayTick` maps to `RetentionDays.ONE_WEEK`, `baseEventing` maps to `RetentionDays.ONE_WEEK`, and `app` or `discord` is explicitly chosen rather than implicit. The first implementation should create managed `LogGroup` resources rather than using Lambda `logRetention`, because managed groups give the next metric-filter and cleanup pass a clearer foundation.

**Axis:** Repo-wide CloudWatch retention and cost controls

**Basis:** `direct:` `deploy/lib/fame-pool-state.ts`, `deploy/lib/image-lambdas.ts`, and `deploy/lib/events-lambdas.ts` create active Lambdas without explicit retention on `origin/main`. `external:` AWS CDK documents both `logRetention` and user-provided `logGroup`, with `logGroup` as the fuller customization path.

**Rationale:** This matches the expanded requirement: all CloudWatch logs get an explicit policy, Ethereum logs keep enough history for slower incident review, and replay/base-eventing logs stay short because they can become high-volume. A helper makes future Lambdas fail code review if they lack a retention classification.

**Downsides:** Mixed-chain Lambdas like `FameEvent` do not fit cleanly into per-chain retention because CloudWatch retention is per log group, not per log event. For the first pass, classify mixed-chain Lambdas by the longest required retention, then consider function split or separate log streams later if log cost proves meaningful.

**Confidence:** 98%

**Complexity:** Low-Medium

**Status:** Strong candidate

### 2. Managed Log Groups For Retention Plus Future Metrics

**Description:** Instead of only using Lambda `logRetention`, create CDK-managed `aws_logs.LogGroup` resources and pass them to each Lambda through `logGroup`. Name them consistently, attach the same retention classes, and use `RemovalPolicy.DESTROY` for dev/PR stacks unless production requirements call for retention across stack deletion.

**Axis:** Repo-wide CloudWatch retention and cost controls

**Basis:** `direct:` the pool-state construct already imports `aws-logs`, but currently uses per-Lambda `logRetention`; other constructs do not import logs at all. `external:` the CDK Lambda docs note that default Lambda-created log groups cannot be customized through CDK and recommend the `logGroup` property for customization.

**Rationale:** Managed log groups are a cleaner long-term base for metric filters, explicit names, and predictable cleanup. This is especially attractive if the next pass also adds replay/freshness metric filters.

**Downsides:** It is slightly more invasive than `logRetention` and needs careful logical IDs/names to avoid replacement surprises on existing stacks. If the goal is the fastest deployable cleanup, a `logRetention` helper is smaller.

**Confidence:** 90%

**Complexity:** Medium

**Status:** Good follow-through path

### 3. Chain-Aware Retention Map With Mixed-Lambda Policy

**Description:** Document and encode a retention decision table for ambiguous Lambdas. Use 30 days when a Lambda handles both Ethereum and Base in one log group, use 7 days when it is replay-tick or Base-only, and mark app/Discord-only Lambdas with a deliberate default. Add comments near `FameEvent` explaining why mixed-chain currently chooses the longer retention.

**Axis:** Repo-wide CloudWatch retention and cost controls

**Basis:** `direct:` `FameEvent` receives Base, Sepolia, and Mainnet RPC JSON in one Lambda, while `WrapEvent` is Sepolia/Mainnet-only and image Lambdas are split by collection/chain. `reasoned:` CloudWatch cannot retain Base log events for 7 days and Ethereum log events for 30 days inside the same log group.

**Rationale:** The tricky part is not the CDK property. It is preventing retention classes from becoming vibes. This decision table keeps the policy auditable and makes the tradeoff visible.

**Downsides:** Mixed Lambdas may retain more Base/eventing logs than strictly desired. Splitting `FameEvent` by chain would be a larger architectural change and should not be bundled into the first cleanup pass.

**Confidence:** 94%

**Complexity:** Low

**Status:** Strong candidate

### 4. Pool-State Logger With Levels, Redaction, And Stable Event Names

**Description:** Add a tiny pool-state logging helper used by the indexer and API Lambdas. The helper should emit one JSON object per line with `level`, `event`, `timestamp`, and compact event-specific fields; redact or omit request bodies, service tokens, full URLs, calldata, and raw tick payloads. Keep `fame-pool-state-indexed`, `fame-pool-state-api-batch`, `fame-pool-state-api-error`, and replay failure events as stable names.

**Axis:** Log signal quality

**Basis:** `direct:` the current Lambdas manually call `console.log(JSON.stringify(...))` and `console.error(JSON.stringify(...))`; the payloads are structured but do not consistently carry a `level` field. `external:` AWS Lambda log-level filtering expects JSON logs with a valid `level` field when application logs are filtered.

**Rationale:** A small typed helper prevents the next cleanup pass from becoming scattered `console.*` edits. It also makes it easier to use Lambda JSON logging or metric filters later because every event has a predictable envelope.

**Downsides:** If Lambda `loggingFormat: JSON` is enabled at the same time, verify whether console output is wrapped or nested before relying on CloudWatch query shapes. Start with the application-level envelope and only enable Lambda JSON format when tests/smokes confirm the observed log shape.

**Confidence:** 92%

**Complexity:** Low-Medium

**Status:** Strong candidate

### 5. API Batch Log Volume Gate

**Description:** Reduce normal API request log volume by making success logging conditional and deterministic. Always log errors. Always log replay-surface requests and any response with stale, unknown, or unsupported rows. For all-fresh constant-product-only batches, either log at debug level or sample through an explicit environment variable such as `FAME_POOL_STATE_API_SUCCESS_LOG_MODE=all|interesting|off`.

**Axis:** Log signal quality

**Basis:** `direct:` `src/fame-swap-pool-state/lambdas/api.ts` logs `fame-pool-state-api-batch` for every successful request. `reasoned:` once `www` starts leaning on the helper, quote traffic can make per-request INFO logs noisy even when nothing needs operator attention.

**Rationale:** This keeps operationally interesting API behavior visible while avoiding a pile of identical fresh batch logs. It also leaves a deliberate switch for dev investigations without making production noisy by default.

**Downsides:** Over-aggressive suppression can hide traffic shape during early rollout. The first implementation should keep replay-surface requests and non-fresh status counts at INFO so the CL replay rollout remains easy to inspect.

**Confidence:** 84%

**Complexity:** Low-Medium

**Status:** Strong candidate

### 6. Log-Derived Metric Filters For Replay And Freshness Health

**Description:** Add CloudWatch metric filters on the managed indexer log group for `clReplayFailedPools > 0`, `clReplaySnapshots`, `clReplayWrittenPools`, and high `durationMs`. Optionally add a second metric for API batches with stale/unknown counts. Keep existing passive alarms, but make replay failure and slow-indexer signals easier to inspect from metrics without reading raw logs.

**Axis:** Operational metrics and inspection

**Basis:** `direct:` `indexFamePoolStates` already returns `durationMs`, `observedThroughBlock`, CL replay counts, failures, and sizing metrics; the Lambda logs the whole payload once per run. `reasoned:` the passive alarms catch Lambda-level failure, but replay-specific degradation can be visible before the whole Lambda fails.

**Rationale:** The hardening goal is not paging; it is a sharper health surface. Metric filters let the release owner check whether replay succeeded, whether the indexer slowed down, and whether stale output increased without scraping CloudWatch Logs manually.

**Downsides:** Metric filters depend on stable log JSON shape and are easier to attach to explicitly managed log groups. Do this after retention and the logging envelope are made explicit.

**Confidence:** 78%

**Complexity:** Medium

**Status:** Defer until log groups/log shape stabilize

### 7. Dev Smoke Script For Pool-State Health Evidence

**Description:** Add a focused smoke script that takes `FAME_POOL_STATE_API_URL`, `FAME_POOL_STATE_SERVICE_TOKEN`, `BASE_RPC_URL`, and optional `FAME_POOL_STATE_CURRENT_BLOCK`; calls `/fame/pool-state`; requests both reserve and `cl-replay-v1` surfaces; and prints a compact pass/fail report with source registry id, current block, status counts, replay state hash, bitmap/tick counts, and stale-metadata checks.

**Axis:** Deploy and smoke guardrails

**Basis:** `direct:` `docs/fame-pool-state-index.md` requires authenticated helper smoke evidence, fresh quote-model state, replay row details, and short soak evidence before `www` consumes the helper. `reasoned:` humans should not have to reconstruct the same curl plus jq plus CloudWatch checklist each dev deploy.

**Rationale:** This creates a single backend-owned proof command for the cleanup lane. It complements, but does not replace, `www` route-lab and parity checks.

**Downsides:** It touches live AWS/RPC state, so it cannot be the only test. Keep it as a smoke and give it safe redaction for URLs and tokens.

**Confidence:** 86%

**Complexity:** Medium

**Status:** Good follow-up

### 8. PR Cleanup Hardening For Dev Artifacts

**Description:** Fix the existing cleanup debt around PR stack deletion: delete `BotCert-PR-<number>` in `us-east-1`, stop hiding unexpected CloudFormation delete/wait failures behind blanket `|| true`, and make managed log groups part of the cleanup checklist if they are PR-scoped.

**Axis:** Existing cleanup debt

**Basis:** `direct:` both `docs/fame-pool-state-index.md` and `docs/fame-pool-state-handoff.md` list PR cleanup debt: `BotCert-PR-<number>` is not deleted in `us-east-1`, and unexpected delete/wait failures are swallowed. `reasoned:` unmanaged log groups and PR cleanup gaps compound into AWS account clutter.

**Rationale:** This is the same hygiene theme: short-lived validation environments should leave little residue and should fail visibly when cleanup is incomplete.

**Downsides:** It may involve GitHub workflow and cross-region AWS command details beyond the CloudWatch retention helper. Keep it a separate commit from log retention if implemented.

**Confidence:** 76%

**Complexity:** Medium

**Status:** Good follow-up

### 9. Operator-Facing Runbook Refresh

**Description:** After log retention and logging changes land, refresh `docs/fame-pool-state-index.md` with exact CloudWatch log group names, expected retention classes, key Logs Insights queries, smoke command, and what healthy enough for dev means. Keep it backend-specific and leave `www` optimization details out.

**Axis:** Deploy and smoke guardrails

**Basis:** `direct:` current docs describe passive alarms, indexer/API event names, and rollout checks, but they do not yet name managed log groups or concrete query snippets. `reasoned:` the next operator should be able to answer whether a dev deploy is healthy without reading implementation code or chat history.

**Rationale:** Runtime hardening is only useful if someone can operate it. The runbook is the handoff surface for the next deploy attempt.

**Downsides:** This should trail the code changes; otherwise the docs will guess at names and fields that may still shift.

**Confidence:** 82%

**Complexity:** Low

**Status:** Follow-up after implementation

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Add pager/email actions to all passive alarms | Scope overrun for the community-service ownership model; current docs intentionally use no-action passive alarms. |
| 2 | Move all Lambda logs to a third-party observability vendor | Too expensive and not grounded in the current deploy surface. CloudWatch retention and log shape are the immediate gap. |
| 3 | Stop API success logging entirely | Too aggressive during CL replay rollout; replay-surface and non-fresh responses still need INFO-level visibility. |
| 4 | Store every indexer run as a DynamoDB history row | Interesting later, but log retention plus metric filters are cheaper and enough for this cleanup pass. |
| 5 | Build the backend CL quote endpoint in this pass | Important, but explicitly belongs to the separate optimization/quote-surface lane. |
| 6 | Split mixed-chain event Lambdas just to get per-chain retention | Too invasive for cleanup; classify mixed-chain log groups by the longest required retention first. |
| 7 | Event-driven tick maintenance as hardening | Not cleanup; it changes the replay maintenance model and belongs after the quote/payload design stabilizes. |
| 8 | Leave non-pool-state Lambdas for later | Rejected by the expanded scope: all CloudWatch log groups should now be explicitly classified. |

## Recommended Next Brainstorm Seed

Start with ideas 1, 3, and 4 as the first cleanup milestone:

> Add a repo-wide managed `LogGroup` helper, classify every active Lambda into an explicit retention class, apply 30-day retention to Ethereum or mixed Ethereum log groups, apply 7-day retention to replay-tick and Base eventing log groups, and keep pool-state INFO logs compact with a tiny structured logging helper.

This should be the first implementation chunk because it directly addresses the expanded CloudWatch concern and creates a durable guardrail for future Lambdas without drifting into quote endpoint or route-ranking work.
