# Permissioned runtime Wake

The Runtime panel lets owners and human `runtime-operator` identities wake
`runtime:overclaw-leader`. Operator viewers remain read-only. Owners assign the
new role in Access & roles; it grants only `runtime.read` and `runtime.wake`.
Agent/service identities cannot receive this role. Existing login-only Discord
MFA and session revocation policy is unchanged.

## Trust and command contract

The browser sends only a canonical UUID request ID to
`POST /api/runtimes/overclaw-leader/wake`. The API validates the current session,
principal epoch, enabled state, role, exact runtime and same-origin mutation.
It supplies the Discord actor and timestamp itself. Extra fields, tasks, prompts
and alternate runtimes are rejected. IAM authenticates the API's invocation of
`arn:aws:lambda:us-west-1:590183914614:function:OverclawLeader-console-wake`.
No browser AWS credentials or shared command secret are introduced.

Before invocation, the API transaction checks the policy version and inserts an
immutable request envelope into the retained access table at
`pk=runtime-wake`, `sk=<requestId>`. Outcome updates cannot overwrite a terminal
receipt. Any audit failure prevents dispatch. A conditional creation conflict
fails this attempt; retrying the same ID goes through fresh authentication.

The Overclaw function independently validates the envelope and atomically commits
its receipt and a Wake intent, conditioned on unchanged runtime and intent rows.
It cannot write runtime state, create tasks, deliver Discord messages, access
secrets, invoke other functions, or control EC2. The existing watchdog performs
startup. The usual one-minute watchdog cadence can delay visible startup.

New requests expire after five minutes, with 30 seconds of future-clock tolerance.
An existing exact receipt remains replayable after expiry. Duplicate delivery
returns that receipt; a different actor or envelope cannot reuse the ID.
Already-awake/starting runtimes are a no-op. Shutdown, recovery and pending
non-Wake intents are rejected. Wake does not extend an awake lease or bypass
normal lifecycle safety. It creates no conversation or work item. Scheduled work
and incoming requests retain their existing permissions and scheduling semantics.

## Receipts and uncertainty

Accepted means the intent committed, not that the runtime is ready. The panel
continues showing existing lifecycle/startup/failure observations. Stale or
unavailable status prevents a new UI Wake; the command handler still checks the
authoritative state. A lost response is explicitly unknown. The tab saves the ID
in sessionStorage before dispatch and retains it across reloads until a terminal
receipt is observed. Check/retry reuses the original envelope and timestamp.
Closing the tab or clearing browser storage loses this convenience, not the
server's audit. Operators can retrieve their receipt through
`GET /api/runtimes/overclaw-leader/wake/<requestId>`; owners can retrieve any.
A history-list UI is outside this slice. Do not delete command receipts while
clients may replay them.

## Release order

1. Merge and deploy the companion Overclaw implementation first. Build the
   controller artifact from the reviewed commit, then review/deploy OverclawLeader.
   Confirm the dedicated function and exact-key IAM exist; do not invoke Wake
   merely to verify deployment.
2. Merge this console change. Existing Bot console CI deploys the reviewed
   FlsBotConsoleAccess boundary before the application stack. The only additional
   console authority is invocation of that one function.
3. Verify owner/operator visibility and viewer denial in the authenticated portal.
   A real asleep-to-ready test is a separate consequential operation: it starts
   compute and can allow existing scheduled work to run. Record its request ID,
   durable receipt, lifecycle progress and any failure when authorized.

To stop new portal requests, remove the exact invocation permission. Already
accepted intents may still run. Do not roll back to a policy parser that cannot
read runtime-operator grants while those grants exist; revoke those grants first
or retain the new parser in the rollback build. Keep audit records retained.

## Local evidence

Console tests cover role/scope separation, revoked and expired sessions, origin
checks, strict payloads, audit-before-dispatch, receipt matching and concurrent
outcome updates. Browser rehearsal uses synthetic data: Asleep -> accepted ->
Starting, a lost-response/reload/same-ID recovery, and no Wake control for viewers.
Rust tests exercise lifecycle decisions, transaction guards and an SDK mock that
commits then loses the response and safely replays after expiry. These checks do
not establish deployed IAM enforcement or a live wake.
