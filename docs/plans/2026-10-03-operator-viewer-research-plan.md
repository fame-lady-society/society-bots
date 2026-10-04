# FAMEliza operator viewer research and implementation plan

Status: implementation completed locally, 3 October 2026; deployment pending. See [release evidence](2026-10-03-operator-viewer-release.md) for source baselines, validation and release dependencies. The research sections below preserve the original design rationale.

## Recommended first slice

Add a read-only **FAMEliza runtime** page to bot.fame.support, scoped to the Overclaw leader deployment. Overclaw publishes a small sanitized status snapshot during its existing reconciliation cycle. The console reads that snapshot through its backend and applies the existing human RBAC checks.

Answer six questions: lifecycle state, last heartbeat, startup stage or blocking failure, separate EC2 workers, last verified checkpoint, and observed deployment version where available. Show missing or stale evidence explicitly. Do not open a gateway connection, introduce actions, or imply that portal access grants Discord operator or vault authority.

The first implementation touches **overclaw** and **society-bots**. Society Agents is a separate runtime, not another source to blend into the same card. No Society Agents or workspace implementation is needed for this slice. No teams, invitations, moderation changes, service credential issuance, raw logs, task content, or wake/sleep/recovery buttons.

## Research boundaries

Inspected local source:

- Overclaw: `/Users/user/Development/overclaw`, commit `c1f48dc`. Its existing untracked Telegram platform plan was read as background and left untouched.
- Society Agents: `/Users/user/Development/society-agents`, commit `1c2a250`.
- Console: isolated `/private/tmp/society-bots-rbac`, main baseline `93788d2`; separate sidebar fix excluded from this documentation branch.

This is source evidence, not a claim about currently deployed resource names, images, IAM policies, or runtime health. Read-only cloud discovery is the first implementation gate. No AWS state, credentials, or messages were retrieved in this research pass. Society runtime management tools were unavailable in this desktop session; existing authorized local checkouts were used.

## Existing signals and gaps

References below are repository-relative, at the commits above.

| Question | Existing evidence | Required treatment |
| --- | --- | --- |
| Lifecycle | Overclaw `src/model.rs:25–34,55–68`: asleep, launching, awake, draining, terminating, stopping, recovery. Watchdog is sole runtime writer (`:103`). | Preserve distinctions. Display launching as Starting, draining as Saving, terminating as Shutting down, stopping as Stopping, recovery as Recovery needed. Ready requires a matching fresh heartbeat reporting ready, not just an awake row. |
| Last heard | `Heartbeat.at`, generation, instance, ready and startup (`src/model.rs:80–91`). Authenticated current heartbeat receipt is server-stamped (`src/bin/controller.rs:362–395`). | Persist last accepted observation in the status snapshot. Heartbeats expire after 24 hours, so do not depend on old heartbeat rows surviving sleep. A never-observed heartbeat stays null. |
| Freshness | Heartbeat freshness threshold is 180 seconds (`src/model.rs:3–5`). Reconciler runs every minute (`infra/leader-stack.ts:334–336`). Runtime `since` is a phase timestamp, not an observer timestamp. | Add real successful reconciliation observation times. Successful DynamoDB retrieval and snapshot publication time do not prove EC2 or watchdog health. |
| Startup and failure | Startup enum restoring/connecting/configuring/loading/checking (`src/model.rs:70–78`). Heartbeat failure is sanitized (`src/bin/controller.rs:386–387`). | Explicit bounded reason codes and fixed display text. No raw error/reason string spreading. Do not reuse `wake_notice.rs:84–108` unchanged: its startup-message mapping is not a general lifecycle renderer. |
| Workers | Separate EC2 workers in `src/fleet.rs:106–151`; reconciler in `src/fleet_control.rs:18–86`. | These are not native child sessions. Expose counts by phase with observation time and completeness only. Do not publish task/session/node identifiers, request text, repository lists or links. |
| Checkpoint | `Checkpoint.created_at` (`src/model.rs:43–52`); controller verifies S3 objects before acknowledging (`controller.rs:380–384`, `cloud.rs:213–254`); runtime adopts acknowledgment during drain (`model.rs:192–215`). | Report the creation time carried by the committed, verified main checkpoint, explicitly labeled runtime-reported. Verification does not verify that timestamp. No console S3 permissions. Old checkpoint while awake is normal. Worker checkpoints lack a timestamp; display unavailable rather than borrowing another timestamp. |
| Version | Runtime/worker launch-template version (`model.rs:60–61`, `fleet.rs:134–135`). Desired image and fingerprint are CDK outputs (`infra/leader-stack.ts:347–356`). | Label launch version as recorded for the current generation; no claim it is a git SHA or observed binary digest. Desired stack release must not be labeled running. Actual build SHA/digest reporting is a later instrumentation option. |

Overclaw configuration identifies leader as `OverclawLeader`, account `590183914614`, region `us-west-1` (`deployments.json:2–14`). Console is configured in `us-east-1`. First integration is proposed as same-account, cross-region. House is excluded.

Society Agents has different semantics: GitHub Actions disposable worker; queued/working/waiting/sleeping/failed job phases (`crates/core/src/model.rs:12–18`); ready/restoring is local worker state, not a durable remotely readable status (`crates/worker/src/native.rs:309–310`, `main.rs:485–494`). Lease expiry also advances during queued runs (`crates/controller/src/main.rs:596–617`), so expiry minus 180 seconds is not a heartbeat timestamp. Its queue GSI omits sleeping/failed jobs; it cannot answer checkpoint history after sleep. A future Society Agents card needs its own source-owned projection and stable runtime ID.

## Brainstorm and decision

| Option | Advantages | Costs and failure modes | Decision |
| --- | --- | --- | --- |
| Console reads existing runtime rows directly | Fewest producer changes; existing data | Couples portal to internal schema; no observer freshness; expiring heartbeat history; worker enumeration uses Scan across a sensitive table | Reject for full six-question scope |
| Dedicated read-only status Lambda in Overclaw | Clear source-owned API; IAM-only invoke; can sanitize | Additional function and packaging; still needs durable timestamps and safe worker enumeration; temptation to invoke existing controller instead | Viable if future status requires on-demand computation; unnecessary initially |
| Existing watchdog publishes one sanitized snapshot to a dedicated small DynamoDB table | Available during sleep; minimal reader IAM; naturally explicit observation age; no new scheduler, gateway or reader function | Adds producer write and must isolate reporting failures from lifecycle safety; up to one reconciliation interval of delay | **Recommended** |
| Browser or console connects to OpenClaw gateway / controller | Potential future actions and live detail | Gateway sleeps; broader credentials; private network changes; status becomes coupled to privileged execution | Reject for this slice |

A separate small status table is deliberate data isolation, not a new event framework. One current snapshot item, no event history, Streams, GSI, replicas, background consumer or shared SDK. Use a versioned JSON contract with matching Rust/TypeScript fixtures; avoid a multi-repository package release dependency.

## Permission and trust contract

Add role ID `operator-viewer`, display **Operator viewer**, permission `runtime.read`, scope exactly `runtime:overclaw-leader`. Owners receive this permission through their role definition. Existing inbox readers and connection managers receive none. Do not add a runtime wildcard in this slice; the owner global scope already serves owner visibility. Owner UI offers a named runtime selection, not a free-form ARN or backend URL.

The existing `src/access-contracts.ts:2–40,86–100` role/permission/scope checks require extension; `server/app.ts:133–158` resolves enabled human identity and session generation from current access policy on each API request. Preserve that boundary for both list and detail routes. Status refresh must not bypass authority checks. Agent/service registry entries remain inventory only: this feature does not authenticate them or issue tokens.

Proposed routes: `GET /api/runtimes` returns only runtimes the caller can read; `GET /api/runtimes/overclaw-leader/status` checks the exact grant before any upstream read. Unknown and unauthorized detail IDs get the same 404 response; anonymous callers get 401. No runtime counts or metadata for excluded resources. Runtime IDs map to fixed server configuration; client parameters cannot select account, region, table, key or URL.

Service access is AWS IAM, separate from the human registry. Console Lambda may only `dynamodb:GetItem` the configured status table with a `dynamodb:LeadingKeys` condition for the single published key. It receives no raw runtime table, Scan/Query, S3, secrets, controller invoke, gateway, signing or EC2 permissions. Snapshot publisher receives the exact read/write item permission needed to retain last-known observations and replace the snapshot, scoped to that table/key. No new capability for agents.

Even same-account services need explicit least-privilege policies. IAM LeadingKeys governs partition keys and requires the ForAllValues modifier; enforce required keys rather than relying on a Scan filter. See [AWS fine-grained DynamoDB access](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html). Cross-account Lambda permissions are relevant only to the rejected/alternate reader-Lambda design, not a reason to add AssumeRole now: [AWS Lambda cross-account invocation](https://docs.aws.amazon.com/lambda/latest/dg/permissions-function-cross-account.html).

Existing generic controllers are specifically unsuitable. Overclaw routes mutation-capable operations (`src/bin/controller.rs:61–88,350–360`). Society Agents IAM worker RPC includes credential-returning configuration and repo-token operations (`crates/controller/src/main.rs:113–123,411–460`). Invoke permission cannot be restricted by JSON operation; do not treat a new read verb on either controller as isolation.

## Snapshot and freshness contract

Proposed stable key: `runtime:overclaw-leader`. Required envelope: schemaVersion, runtimeId, revision, publishedAt. Each evidence section has its own observedAt and availability; timestamps use UTC epoch seconds. All fields are explicitly allowlisted and validated again by the console. Unknown schema or malformed timestamps produces unavailable status, not permissive parsing.

- **Lifecycle:** generation token for matching observations internally (not exposed to the browser), phase, successful lifecycle reconciliation time, safe blocker code, last accepted main heartbeat time and its generation, current startup stage/readiness when matching. Do not emit instance IDs or infrastructure identifiers to the browser. Preserve previous-generation last-heard only as historical, never as evidence for current readiness.
- **Workers:** successful fleet reconciliation time, counts by phase, total, and completeness. No individual worker list in this slice: counts answer whether separate workers are running without new identifiers or detail permissions. Incomplete enumeration means counts/total unknown, never zero or a sampled total. Use data already observed by the existing reconciler; no new per-browser Scan. Match each worker heartbeat to its own generation/instance, not the leader generation; workers may outlive a leader generation.
- **Checkpoint:** runtimeReportedCreatedAt from the last verified committed main checkpoint, source generation when known; verification time remains unknown; no object keys, versions, hashes, archives or presigned URLs. Failed/uncommitted upload cannot advance this value. Label it “Last saved checkpoint — created [time] (runtime-reported)”; do not call it “verified at.” Reject future/invalid creation times as unknown. A retained checkpoint from an earlier generation is historical saved work, not proof that the current session is saved.
- **Version:** recorded current-generation launch version when present, with provenance; actual binary SHA/digest remains null until implemented and verified. Do not claim running version while no current instance is established.

Use one atomically replaced snapshot so the reader does not assemble mismatched lifecycle and heartbeat generations. Writer must check generation+instance before using heartbeat readiness, matching the existing runtime model. A failed component reconciliation must record current component availability/error code separately from retained evidence. It may preserve that component's last good evidence with its original observedAt; it must never refresh that timestamp or silently publish empty results. A current reconcile error overrides a still-young previous healthy observation in the display. Snapshot publishedAt is transport bookkeeping only.

Default viewer freshness proposals: lifecycle/fleet observations older than 180 seconds are stale; heartbeat threshold follows existing 180-second runtime rule; browser polls every 30 seconds only while the page is visible. Stop retries on authorization failure and clear runtime queries immediately, following current client access-reset behavior. Use a short bounded AWS read timeout, no indefinite SDK retry loop, and preserve a visibly labeled last observation only while the viewer remains authorized.

An asleep runtime naturally has an old heartbeat. Fresh lifecycle reconciliation confirming asleep should render **Asleep**, with historical last-heard, not an unhealthy heartbeat alarm. A stale lifecycle observation renders **Last observed asleep — status stale**. For awake, Ready requires current matching fresh ready heartbeat and fresh lifecycle observation. Missing/expired heartbeat with awake yields **Last observed awake — heartbeat unavailable/stale**. Never convert upstream errors, missing row, unsupported schema, or unknown phase into Asleep or zero workers.

Strong GetItem reads can retrieve the latest committed snapshot; they do not prove that its producer is alive. They also do not make separate original state reads atomic. See [AWS read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html).

## Producer reliability

Publish through the existing Overclaw watchdog; do not add another schedule or self-wake. Its reserved concurrency of one supplies a single writer today. Publication is an awaited operation after lifecycle, fleet and cleanup safety work, never part of deciding whether to launch, stop or retain checkpoint disks. Proposed hard budget: one second total, no SDK retries, and skip publication if fewer than two seconds remain before the existing 55-second watchdog deadline. Timeout/cancellation must not leave a detached task. Validate these limits against the actual invocation context before implementation. Preserve the original reconciliation result and error semantics; snapshot write failure cannot skip another component's cleanup or convert a failed reconcile to success. Emit a safe structured reporting-failure log without snapshot bodies or secrets.

Do not refactor the lifecycle state machine into a telemetry framework. Capture a small typed observation result from each reconciler and explicitly project it. Review orphan/early-return paths: if the runtime is blocked by orphan compute, publish an allowlisted blocked state or keep the previous observation stale; never refresh a healthy/asleep claim without completing the needed observation.

Publication must happen during idle/asleep reconciliations too. Persist the last accepted heartbeat/checkpoint from the previous snapshot when source records expire, without inventing missing historical data. Keep the existing single watchdog writer (reserved concurrency one); no other function writes the snapshot. Use a conditional replacement against the previously read snapshot revision (or item absence on first publish), and preserve generation checks for worker observations. This prevents a delayed timed-out write from overwriting a snapshot whose revision has already advanced. A timeout is an uncertain remote write outcome; do not blindly retry it, and re-read on the next normal reconciliation. Conditional conflict skips publication and logs a safe reporting error. Do not add a distributed lock or new generation protocol. If implementation introduces multiple writers, stop and revise this assumption rather than silently weakening it. Retain the status item without TTL so sleep does not erase history. Bound the document far below DynamoDB's item limit; reject oversized or malformed sections rather than clipping silently.

## Console experience

Add **Runtime** beside Access & roles, Telegram inbox and Connections only for an authorized runtime viewer. Page heading FAMEliza with subtitle Overclaw. The primary state includes observation age and a clear stale/unavailable label. Under it: startup/blocker, last heard, last saved checkpoint with its runtime-reported creation timestamp, separate EC2 workers, and version/provenance. Show timestamps as both relative age and readable exact time.

Loading, no observation yet, partial observation, stale source, access revoked, and backend unavailable are first-class states. No disabled action buttons or speculative tabs. Owner access editor includes the new role and exact runtime selection. A viewer-only person lands on their permitted runtime page or My access with a clear navigation path. The UI must not imply that service inventory entries grant a runtime credential.

## Implementation sequence

1. **Read-only deployment discovery.** Confirm current main commits, runtime identity/account/regions, watchdog deployed artifact/version and schedule, current worker capacity, state schema, and console execution/deployment roles. Inspect only allowlisted fields; no raw table dumps or secret retrieval. Determine whether both named runtimes are active without conflating them. Stop and revise the source map if the deployed owner differs.
2. **Freeze contract and fixtures.** Define the DTO, reason mapping, exact runtime ID, worker-count completeness, freshness derivation and IAM item key. Include stale/sleeping/mismatched-generation/partial examples. Record fields not available today as null. Resolve how existing fleet observations feed the projection before writing infrastructure.
3. **Overclaw PR.** Dedicated status table and exact publisher IAM, small typed observations, bounded atomic snapshot publisher, Rust tests and CDK assertions. Preserve existing watchdog behavior. Include deployment output for status table ARN/name and region. Run required Rust formatting/clippy/tests and repository JS tests. Deploy via its existing reviewed release mechanism only in a later implementation turn.
4. **Console permission infrastructure prerequisite.** Update FlsBotConsoleAccess only if its deployment policies cannot create the exact status-read grant. Review and apply via existing access CI before the main console deployment; main CI must not expand its own authority. No wildcard resource or account-wide access to make deployment pass. Avoid CloudFormation cross-region imports; configure reviewed ARN/name/region explicitly.
5. **Console PR.** Extend role/grant validation and owner UI, exact routes, typed cross-region GetItem reader, schema validation, Runtime page, client cache revocation behavior, rehearsal fixtures, application tests/build and targeted CDK assertions. No raw-source fallback if projection unavailable.
6. **Integrated read-only acceptance.** After producer deployment verify snapshots advance while awake and asleep using naturally occurring lifecycle transitions or a separately authorized rehearsal. Verify scoped login, absence of unrelated metadata, correct worker/checkpoint/version evidence, stale producer simulation in local tests, and real IAM denies for unrelated keys/actions. Loading the page must not wake compute, launch workers, call inference or modify runtime intent.

Producer deploys before console consumer. A missing publisher remains visible as No observation yet; do not add a feature flag. Schema changes use coordinated producer/consumer release and reject unsupported versions, not compatibility adapters. RBAC role introduction has a rollback caveat: once new grants are saved, an older enum validator can reject the entire policy. Historical audit entries contain the new role too: removing current grants does not make a pre-role build safe. Keep a tested role-aware rollback artifact and prefer a forward fix; prohibit ordinary rollback to a pre-role binary after the first new grant is saved. Do not erase audit history to make old code parse. Do not add legacy schema fallbacks. Reverting producer code leaves retained snapshots which become visibly stale; revert console status IAM separately if retiring the integration.

## Acceptance and adversarial cases

- Owner and exact runtime viewer can read; manager/Telegram reader cannot. Disabled/revoked users cannot fetch or keep cached status. Cross-runtime IDs and forged roles do not enumerate metadata or trigger upstream requests.
- Backend IAM allows only the expected GetItem key; Scan, writes, unrelated tables/keys, controller invoke, S3/secret reads and EC2 actions are denied. Reader endpoint has no mutation branch.
- Watchdog interruption, partial fleet failure, absent/expired heartbeat, heartbeat from a previous generation, future timestamp/clock skew and unsupported schema never become a healthy status.
- Fresh asleep state with old heartbeat is correctly normal. Starting is distinguishable from Ready. Stopping is not rendered as successful checkpointing.
- Checkpoint upload succeeds but verification or commit fails: last verified value stays unchanged. No checkpoint path or payload reaches the browser.
- A status write fails or times out: normal lifecycle/checkpoint retention/termination decisions and remaining cleanup still execute as before. Delayed timeout completion cannot overwrite an already advanced snapshot revision; test both remote-completed and remote-not-completed timeout outcomes. Old-generation heartbeat or worker evidence cannot masquerade as current evidence.
- Worker enumeration is incomplete or reconciliation fails: unknown counts explicit. No task names, request text, credential-bearing errors, session keys or signed URLs.
- Stack release changes while old generation runs: displayed observed version remains the old recorded launch version; desired release never masquerades as running SHA.
- Browser refreshes are bounded, no-store, and stop in hidden tabs; role loss clears data. No self-wakes, new periodic infrastructure, gateway network route, or telemetry-triggered inference.

## Open decisions and evidence gates

The architecture recommendation is ready for implementation planning, but these need discovery before implementation: exact live resource identities; existing reconciliation result structure needed for complete worker summary; reason-code coverage including orphan paths; item-retention/deletion policy; and deployment role allowance. No operator preference is needed to resolve routine source facts.

Defaults proposed for approval through this plan: one Overclaw runtime, dedicated single-item status table, exact-scoped viewer role, 30-second visible-page polling, 180-second observation freshness, aggregate worker counts only, no actions. Owner is able to grant observability, not vault or Discord execution authority. A later action layer needs separate permissions, actor attribution, concurrency/idempotency contracts and a review of fresh authentication for sensitive operations.

## Adversarial review disposition

Source-backed independent adversarial review identified three material design problems, now resolved in the plan:

1. Fresh snapshot publication could disguise failed lifecycle observation. Each component retains its real last successful observedAt and has a separate current availability/error; transport time is never health. Test partial failure even when prior evidence is less than 180 seconds old.
2. Checkpoint created_at is master-provided, while verification checks generation/objects/checksums (`src/bin/master.rs:580`, `src/cloud.rs:213`). The UI now labels the accepted checkpoint's creation time as runtime-reported; verified-at is unavailable. Historical checkpoints stay distinct from current-generation readiness.
3. Old console binaries reject the new role in policy and historical audit entries (`server/access-store.ts:32,93`). Removing current grants is insufficient. Require a role-aware rollback artifact or forward fix and preserve audit history.

Additional changes: a hard publication time budget after all safety work; preserve single-writer ownership and add only conditional snapshot revision replacement for ambiguous remote timeout completion, without inventing a locking protocol; partial worker observations cannot imply complete counts; no generic controller invoke authority.

Completed-document review also found that Runtime::recovery changes phase without updating since (`src/model.rs:249–253`). The contract therefore omits phase duration/phaseSince rather than presenting the prior phase's timestamp as recovery-entry time or modifying lifecycle behavior for the viewer. Worker output was reduced to aggregate counts: an individual worker list adds identifiers and privacy decisions without answering an additional agreed question. Worker heartbeat matching is explicitly per-worker, not against the current leader generation.

Review recommendation: proceed with this research direction and the discovery/contract gates above. No new reader Lambda or telemetry service is justified for the first slice. These are design-review findings and resolutions, not runtime test results.

## Implementation task backlog

T1–T7 implementation and local review are complete except the explicitly pending release-artifact subchecks below. T8 deployment/live acceptance remains pending. Task IDs are local to this document; completion evidence is in the release record.

### T1 Verify deployment ownership and prerequisites

Repository ownership: read-only discovery across Overclaw and society-bots. Depends on: none.

- [x] Refresh main/source references and inspect each checkout for concurrent work before editing.
- [x] Verify the actual leader stack, region, account, deployed watchdog artifact, schedule, timeout and single-writer concurrency.
- [x] Verify console runtime/deployment roles and the existing access-stack CI path.
- [x] Confirm lifecycle/heartbeat/worker record shapes using bounded allowlisted reads; resolve how complete fleet observations can be returned from the existing reconciler.
- [x] Record source/deployment differences, exact resource references, and any required change to this plan. Do not inspect secrets or dump raw tables.

Done when: a short discovery record establishes the correct producer and consumer, the observation hooks, and whether T4 needs an access-stack change. If deployment differs materially from the inspected architecture, revise the plan before T2.

### T2 Freeze the status and authorization contracts

Repository ownership: contract fixtures in Overclaw and society-bots. Depends on: T1.

- [x] Define schema version 1, exact runtime/key, explicit nullable fields, allowed reason codes, and distinct producer snapshot versus browser response shapes.
- [x] Define generation matching, component error precedence, 180-second freshness, permitted clock skew, absent/malformed schema behavior, and retained historical heartbeat/checkpoint semantics.
- [x] Specify complete worker counts, no per-worker records, no phase duration, and launch-version provenance.
- [x] Specify operator-viewer/runtime.read grants, exact scope, owner inheritance, list filtering, and identical unknown/unauthorized detail responses.
- [x] Create identical JSON examples for both implementations: fresh ready, starting, fresh asleep with old heartbeat, recovery, stale observer, partial failure, no observation and historical checkpoint.
- [x] Set explicit read/publish size and timeout bounds; confirm the proposed publisher deadline against the Lambda context and measured local work.

Done when: both repositories can test the same fixture contract, including rejection cases, without introducing a shared package or fallback parser. Source observations and display derivation have a field-by-field mapping.

### T3 Build the Overclaw snapshot producer

Repository ownership: Overclaw Rust reconciler/model projection and CDK infrastructure. Depends on: T2.

- [x] Add the dedicated status table, retained item with no TTL, deployment outputs, and publisher IAM restricted to its exact key. Choose and document stack deletion/retention behavior.
- [x] Return small typed lifecycle/fleet observation results from existing reconciliation without changing lifecycle decisions.
- [x] Build an explicit sanitizer; exclude raw errors, task/session/node IDs, checkpoint locations and credential-bearing fields.
- [x] Preserve last good evidence and its timestamps; record current component failures independently. Handle orphan and early-return paths explicitly.
- [x] Publish after all safety work with bounded awaited I/O, conditional revision replacement, no retries after uncertain timeouts, and no detached work.
- [x] Test missing/old-generation heartbeat, partial failure, long sleep, incomplete fleet observations, failed checkpoint acceptance, publication denial/timeout and delayed remote write completion.
- [x] Run repository-required Rust formatting, clippy and tests plus JavaScript/CDK checks. Assert no new scheduler, gateway ingress, public endpoint or controller invocation grant.

Done when: local tests show that reporting failures cannot change safety effects or reconciliation error results, all snapshots match T2, and the infrastructure diff is limited to status publication. Deliver one Overclaw PR; do not deploy merely because producer code is ready.

### T4 Prepare the console IAM prerequisite

Repository ownership: society-bots access infrastructure and existing CI. Depends on: T1 and T2; final exact resource configuration depends on T3 outputs.

- [x] Determine whether existing deployment permissions can grant the required cross-region GetItem permission without modification.
- [x] If needed, update FlsBotConsoleAccess narrowly through its existing access CI; keep main CI unable to expand its own authority.
- [x] Specify the exact status table ARN/region/key configuration; avoid cross-region CloudFormation imports and browser-selected infrastructure identifiers.
- [x] Assert the new integration grant permits only GetItem for that key and adds no Scan, raw-state, mutation, secrets, S3 or controller access.

Done when: either evidence records that no prerequisite change is needed, or a separate narrowly scoped prerequisite PR is ready with required checks. Assess new permissions separately from existing Telegram permissions; do not remove permissions needed by the working Telegram integration.

### T5 Build scoped access and the console status API

Repository ownership: society-bots access contracts, server routes, status reader and runtime-role CDK. Depends on: T2. Can proceed alongside T3 against fixtures; deployment depends on T3 and T4.

- [x] Add operator-viewer, runtime.read and exact runtime scope validation; update owner permissions and audit parsing through the same current schema.
- [x] Implement fixed-runtime list/detail routes with current-session authorization before upstream reads.
- [x] Add the bounded strongly consistent GetItem reader in the producer region. Missing item, unavailable backend and invalid schema have explicit outcomes with no raw-state fallback.
- [x] Validate and allowlist the browser response independently; do not serialize the producer record wholesale.
- [x] Test anonymous, owner, viewer-only, Telegram reader, manager, disabled, revoked and wrong-runtime identities; assert denied calls never reach DynamoDB.
- [x] Test privacy canaries, malformed/future timestamps, unknown schema, incomplete worker counts and timeout behavior.
- [ ] Define a tested role-aware rollback artifact; prove a policy and audit containing operator-viewer remain readable by that artifact.

Done when: application tests and targeted CDK checks prove authorization and data boundaries locally. No real AWS IAM or OAuth acceptance is claimed from test doubles.

### T6 Build the Runtime page and owner grant controls

Repository ownership: society-bots React UI and local rehearsal. Depends on: T2; final integration depends on T5.

- [x] Add the permitted Runtime navigation item and named runtime selection in the access editor.
- [x] Render state/observation age, startup or blocker, historical last heard, checkpoint creation-time provenance, aggregate workers and recorded launch version.
- [x] Provide loading, no-observation, partial, stale and unavailable states without implying success or zero workers.
- [x] Poll every 30 seconds only while visible; bound retries and clear runtime data on permission loss. Test the endpoint's 404 policy-denial behavior explicitly so cache clearing does not depend only on the existing 401/403 handler.
- [x] Verify owner and viewer-only navigation and desktop/mobile layout using fixtures, including slow responses and role revocation while a tab is open.
- [x] Run application tests/build and browser checks; record screenshots and any remaining live-flow gaps.

Done when: each T2 fixture has an honest readable presentation, revoked users lose displayed data on authority refresh or denied fetch, and the UI has no action controls. Combine T5 and T6 in one console feature PR so the first deployed feature is complete.

### T7 Perform integrated adversarial and release review

Repository ownership: both PRs and the conditional access prerequisite. Depends on: T3–T6.

- [x] Review exact final diffs for controller capability exposure, raw-state access, metadata leakage and privilege inheritance.
- [x] Re-run targeted adversarial cases against the final producer/consumer: failed source plus fresh publication, historical checkpoint/current generation, incomplete workers, timeout late completion and stale authorization.
- [x] Verify consumer fixtures match producer serialization and that all repository-required checks pass on the reviewed revisions.
- [ ] Verify publisher-before-consumer deployment order, access prerequisite ordering, supported rollback artifact and preservation of role-bearing audit history. Ordering and audit parsing verified; deployable role-aware CI artifact retention remains a release gate.
- [x] Produce a concise release checklist identifying local proof, cloud checks still pending, exact artifacts and rollback steps.

Done when: blocking review findings are resolved or explicitly accepted by the operator, and the cross-repository release is concrete and reviewable. No new architecture review agents need to run during this planning turn.

### T8 Deploy and prove the read-only slice

Repository ownership: Overclaw release, society-bots access CI if needed, then console deployment. Depends on: T7 and deployment authorization in the implementation session.

- [ ] Deploy the producer and verify a valid snapshot with genuine observation timestamps.
- [ ] Apply T4's prerequisite if required, then deploy the complete console feature with the exact reviewed configuration.
- [ ] Verify actual scoped reads and non-destructive IAM denial checks. Never probe a mutating controller operation to prove a deny; use policy evaluation or an isolated safe test resource where necessary, and label simulation versus live proof.
- [ ] Verify real owner/viewer authentication, permission revocation and absence of unrelated metadata. Use a designated test identity; do not grant an unrelated person access for testing.
- [ ] Observe awake and asleep evidence through natural transitions or a separately authorized rehearsal. If a transition is unavailable, record it as pending; viewing status must never initiate it.
- [ ] Confirm that a page refresh causes no runtime intent write, compute wake, worker launch or inference request.
- [ ] Record deployed versions, observed results, remaining gaps and the role-aware rollback reference.

Done when: the six agreed questions are answered honestly by the deployed portal and the real access boundary is verified. A missing lifecycle rehearsal remains a clearly stated acceptance gap rather than an inferred pass.

### Dependency and PR order

T1 → T2 → parallel implementation of T3, T4 and T5/T6 → T7 → T8.

T4 can be omitted only with recorded evidence that no deployment-permission change is needed. T6 may use fixtures while T5 is being implemented, but both ship together. Expected delivery is one Overclaw producer PR, one console feature PR, and an access-infrastructure prerequisite PR only if required. No Society Agents or workspace code PR is planned. Deployment order is producer, access prerequisite if needed, then console; no merge or deployment occurs in this task-planning turn.
