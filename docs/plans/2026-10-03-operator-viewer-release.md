# Operator viewer implementation and release evidence

Implementation completed locally on 3 October 2026. Deployment and production acceptance are pending. The original research plan remains the design record; this document records implementation evidence and release dependencies.

## Source and discovery

- Console: `fame-lady-society/society-bots`, isolated `/private/tmp/society-bots-rbac`, feature branch `codex/operator-runtime-viewer`; latest main baseline `2c70f73`. Existing research commits retained.
- IAM prerequisite: separate `codex/operator-status-access` branch, commit `b1c4625`, based on `2c70f73`.
- Producer: `falsefloor/overclaw`, isolated `/private/tmp/overclaw-operator-viewer`, branch `codex/operator-runtime-status`, based on `c1f48dcd4df8f4430f832c3aea322fb071c68c71`. Primary checkout's untracked Telegram planning document remains untouched.
- Overclaw main is behind this deployed/researched baseline. The producer PR is stacked on `codex/operator-runtime-baseline` at that exact commit; resolve the existing baseline integration before retargeting to main. Do not deploy an older main baseline merely to simplify the PR.
- Read-only AWS discovery confirmed account `590183914614`, `OverclawLeader` in `us-west-1`, and `FlsBotConsole`/`FlsBotConsoleAccess` in `us-east-1`.
- Deployed watchdog `OverclawLeader-watchdog`: provided.al2023, 55-second timeout, reserved concurrency one, enabled one-minute schedule. Code SHA256 base64 `xB1KX05Vo7tmZPqJNdWvAoG1DDe4qlzABhKP3l6bMt0=` matches the prior local verification manifest; its source manifest matches `c1f48dc` source. This establishes a source/artifact linkage, not reproducible-build proof.
- Existing state table `OverclawLeader-State1C20CC9A-DAKG0X3QXOUX`: allowlisted live read showed asleep, recorded launch version 50, committed checkpoint creation time 1790962859, and no generation-specific heartbeat row. EC2 discovery showed two stopped worker instances and no pending/running/stopping workers at inspection time. These are point-in-time observations, not the new projection's live acceptance.
- Console API function `FlsBotConsole-ApiFunctionCE271BD4-weak4Bwy8fJV` uses `FlsBotConsole-ApiFunctionServiceRole52B9747B-YXrSwhs6J3o7`. The live access template lacked the exact cross-region status read; T4 is required.

No secrets or raw runtime records are included in this evidence. No cloud mutations, runtime wakes, messages or inference calls were made for this implementation.

## Frozen interface

Producer owns retained, no-TTL table `OverclawLeader-OperatorStatus`, key `runtime:overclaw-leader`, in us-west-1. Data is a bounded 16 KiB JSON string with a matching outer revision. Eight identical fixtures in producer `fixtures/operator-status/` and consumer `apps/bot-console/test/fixtures/operator-status/` define schema v1. No shared package or compatibility parser.

The watchdog publishes after safety work, within one second and only with at least two seconds remaining. It uses disabled SDK retries and conditional revision replacement. Sections retain historical evidence but separately report current reconciliation failure. Observation timestamps determine freshness, never publication time. Browser responses exclude internal generation identifiers.

Owners inherit `runtime.read`. Operator viewers need exact scope `runtime:overclaw-leader`; no wildcard runtime role. Other roles gain no runtime access. Detail denial returns 404 before upstream reads. Reader IAM is exact-table/key GetItem; producer IAM is exact-table/key GetItem/PutItem with a required-key condition. No raw state, controller, EC2, S3 or secret grant is added by this integration.

## Local validation

- Console: 59 application tests; TypeScript, Vite and Lambda bundle build passed. Includes pending AWS read cancellation, semantic schema rejection, privacy canaries, deny-before-read, revocation, and persisted policy/audit parsing after operator-viewer grant removal.
- Console infrastructure: 12 targeted CDK/access CI tests passed. Synthesized templates assert exact read grant and API-only attachment.
- Producer: cargo fmt --check; cargo clippy --all-targets --locked -- -D warnings; cargo test --locked (115 passed); same clippy/tests with --features controller (118 passed); bun run check; bun test (34 passed). Includes SDK mocked DynamoDB conditional conflict, denial without retry and remote commit followed by lost response. These do not prove real AWS transaction timing.
- All eight producer/consumer fixtures match byte-for-byte and parse in both implementations.
- Independent adversarial source review found no remaining blocker. Its initial cross-field schema advisory was fixed. Independent console subset: 18/18 passed. Rust proof is from the implementation worker's full matrix, not a second independent full run.
- Browser rehearsal: owner and viewer-only navigation, ready/asleep/stale/missing/partial-worker evidence, role revocation clearing the Runtime page and navigation, desktop 1440px and mobile 390px. No horizontal overflow at 390px; no browser error overlay. A synthetic hidden-page event stopped status fetches across a full polling interval; a deliberately delayed response returned normally. Owner editor offers only the named FAMEliza runtime for the new role. Synthetic browser evidence does not establish Discord OAuth or production session acceptance.

Screenshots were saved locally as `/private/tmp/operator-viewer-desktop.png` and `/private/tmp/operator-viewer-mobile.png`; they are synthetic and not production evidence.

## Release order and remaining acceptance

1. Review the source baseline dependency and producer PR. Build final Linux runtime artifacts from the exact producer revision using the repository release tooling, record their hashes, and deploy the producer through the established release process. Local native tests do not produce deployable Linux artifacts.
2. Verify the leader status item advances with genuine observation timestamps while asleep. No wake is needed for this check.
3. Merge/apply the separate console access prerequisite through its existing access CI, then deploy the console feature. The API grant cannot work before its permissions boundary is expanded.
4. Record deployed producer/consumer revisions and artifact hashes. Retain the first role-aware console CI artifact before saving an operator-viewer grant.
5. Verify real owner/viewer Discord login using a designated test identity, exact-scope reads, revocation and absence of unrelated metadata. Verify real IAM deny boundaries non-destructively; label policy simulation separately from actual invocation.
6. Observe an awake transition naturally or under separate rehearsal authorization. Verify current-generation ready, worker counts and checkpoint/version provenance. Do not wake compute to make the status page test pass.
7. Confirm browser reads cause no runtime intent write, worker launch or inference. Record live acceptance gaps explicitly.

## Rollback

After any operator-viewer grant is saved, do not roll back to a pre-role console binary: both current policy and historical audit contain the new enum. The tested role-aware implementation revision is the minimum source rollback baseline; retain its actual CI build artifact before release. The role-aware CI build is retained as described below; it has not been deployed. Prefer a forward fix; preserve audit history.

Producer rollback leaves the retained snapshot, which ages into stale status. Retire consumer IAM separately if removing the integration. Deleting the producer stack retains the status table. No automatic rollback is performed here.

## Review and retained build references

- Producer: https://github.com/falsefloor/overclaw/pull/4 — implementation `4bd742c`, stacked on `c1f48dc`.
- Access prerequisite: https://github.com/fame-lady-society/society-bots/pull/37 — `b1c4625`; CI passed.
- Console: https://github.com/fame-lady-society/society-bots/pull/38 — implementation `3d30ebe8cb3dd32726288df064931ef5e3c0f85a`; CI run `37173949358` completed successfully (app tests/build, CDK synth/tests and access validation). Subsequent documentation-only commits do not alter that artifact's source.
- Role-aware rollback artifact: `bot-console-build`, GitHub artifact ID `11292577214`, archive digest `sha256:a766b468b13de2497e783db35fb7eb640699d0c48f9483094d30903b7880f772`, expires 2027-01-02T03:23:38Z. Downloaded copy: `/private/tmp/operator-viewer-ci-37173949358`. API `dist-api/index.mjs` SHA256 `e90036589122bd0d4f1468f1c4453bb76075ea127c8c0d0c24822514cf096b81`. Move this release artifact to durable operator-controlled retention before its expiry or local temporary-file cleanup; the PR/source baseline is durable but does not preserve the binary indefinitely.
- No producer CI checks are configured/reported for the stacked branch; its proof is the local Rust/Bun/CDK matrix, not remote CI.
