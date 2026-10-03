# FAMEliza bot console

Role-protected React/Vite application for `https://bot.fame.support`, deployed in the
FLS AWS account `590183914614`. Source and infrastructure are scoped to this app;
existing FAME APIs and bot deployments are unchanged.

## Run a local rehearsal

Use Node 24+ and Yarn 1:

```sh
cd apps/bot-console
yarn install --frozen-lockfile
yarn dev
```

Open `http://127.0.0.1:5173`. The separate loopback-only mock API runs on 5174.
Click **Open local rehearsal** to manage synthetic identities and roles, inspect
Telegram messages, and rehearse group connections.
No platform messages, inference requests or moderation actions are sent. Mock
state resets when the process restarts. Stop with Ctrl-C. The mock login uses a
single shared local session and must never be hosted or exposed through a tunnel.

The production build contains no local fixture server or authentication bypass.
The Telegram inbox displays captured messages from explicitly configured groups.
It intentionally exposes no live moderation execution endpoint in this release.
The local development proxy is not part of the deployed application.

## Authentication

Discord OAuth2 authorization-code flow, `identify` scope only, using oauth4webapi.
The backend checks the immutable Discord ID against the current access registry
and requires `mfa_enabled === true`. Missing MFA is rejected. This confirms MFA
is enabled, not that Discord performed a fresh second-factor challenge. It does
not supply phishing-resistant application step-up authentication. Add explicit
WebAuthn step-up before broad privileged administration if that assurance is needed.

Random browser-bound OAuth state expires after five minutes and is atomically
consumed. Opaque sessions expire after seven days without renewal. A visible console tab
renews its session every minute through a same-origin POST, up to a fixed thirty-day
maximum from login. Background tabs and ordinary data polling do not renew sessions;
only hashes are persisted in DynamoDB. Expiry is checked independently of TTL
cleanup. The `__Host-` session cookie is Secure, HttpOnly, host-only and SameSite=Lax.
API responses are never cached. Mutations require the exact production Origin.
The callback URI is fixed; no caller-supplied return URL. OAuth provider tokens
are used only to retrieve identity and are not persisted or sent to the browser.

The authoritative access registry is read on every request. Disabling a person or
revoking their sessions rejects their next request; role/scope changes apply without
a new login. Discord account/MFA changes are checked at the next login; existing
sessions expire in at most thirty days. Existing sessions require a fresh login
after the RBAC deployment. OAuth failure details and credentials are
not logged. The static login shell is public; every data API checks the session.
The mock API cannot prove actual OAuth login, Discord MFA behavior or live access.

Initial authorized operator: `931691901592145930`, from the existing FAMEliza
configuration and explicitly approved by the operator. The secondary Discord
account is NOT an administrator. Do not grant access through names, email,
server membership or generic Discord administrator permissions.

## CI deployment setup

The isolated `.github/workflows/bot-console.yml` validates PRs and deploys only
main via the `bot-console-production` GitHub environment. It does not deploy the
existing Society stacks. A manual dispatch on a non-main ref validates only.

Deployment configuration:

OAuth source credentials are in Doppler: workspace **Flick**, project
**fls-society-agents**, existing config **prd-controller**:

- `DISCORD_OAUTH_CLIENT_ID`: `1037807133737111572` for the existing FAMEliza app.
- `DISCORD_OAUTH_CLIENT_SECRET`: the client secret from that app's OAuth2 page.
- `BOT_CONSOLE_ADMIN_IDS`: `931691901592145930`.

This config is a source for secure provisioning, not an automatic runtime sync.
Provision the dedicated AWS secret below with these values mapped to `clientId`,
`clientSecret`. The former `adminIds` field is no longer used for authorization. GitHub receives only ARN configuration;
it does not need the Discord client secret or a Doppler token.
Only these three keys may be copied; do not export or sync the controller config.
The dedicated `bot-console/auth` secret was provisioned in FLS us-east-1 on
2026-10-02. Future rotations must explicitly update that runtime secret.

1. Register a Discord OAuth application (or explicitly configure the existing
   FAMEliza application) with redirect
   `https://bot.fame.support/api/auth/callback`. A bot token is not a client secret.
2. Securely create a dedicated Secrets Manager secret named `bot-console/auth`
   in FLS **us-east-1** with JSON fields `clientId`, `clientSecret`, and
   the OAuth credentials. Access is bootstrapped separately by the CDK registry. Never put the value into Git, CI variables,
   command-line arguments, or chat. Use the AWS console/approved secret tooling.
3. The separately provisioned `FlsBotConsoleAccess` stack defines the GitHub OIDC
   role, CloudFormation execution role, and mandatory runtime permissions boundary.
   CI can deploy only `FlsBotConsole`; it cannot update its access stack, assume
   bootstrap roles, or read secret values. Asset writes use the `bot-console/`
   prefix in the existing bootstrap bucket. Runtime roles are bounded to console
   data and deployment operations. The execution role has broader CloudFront,
   certificate and HTTP API management permissions; it is trusted only by
   CloudFormation and can be passed only by the dedicated deployment role.
4. The `bot-console-production` GitHub environment permits only the main branch.
   Its `BOT_CONSOLE_DEPLOY_ROLE_ARN` and `BOT_CONSOLE_AUTH_SECRET_ARN` variables
   contain role/secret ARNs, not credentials. The access stack and environment
   were provisioned on 2026-10-02. The first application deployment completed
   through CI on 2026-10-02 after correcting publishing-layer and DNS read access.
5. Review the CDK diff before the first deployment. The stack creates the bot DNS
   record, ACM certificate, private S3/CloudFront distribution, Lambda/API Gateway,
   DynamoDB sessions/messages, Telegram queues and scoped secret access.
   Deployment alone does not register a Telegram webhook.
6. Merge through normal review; CI deploys `FlsBotConsole`. Test owner login/MFA,
   deny the secondary account, check logout/expiry, and confirm no live actions.

The existing `fame.support` zone is `Z034031717ABI6HYEJD9J`. The new stack uses
us-east-1 for the CloudFront certificate and all console resources to avoid
cross-region certificate plumbing. It remains separate from existing us-west-1
Society services. The public verification portal is proposed at
`verify.fame.support`, with a separate OAuth client/session boundary and API
permissions. No public verification site or DNS is created by this app.

## Validation

```sh
cd apps/bot-console
yarn test
yarn build
cd ../../deploy
yarn test --runInBand test/bot-console.test.ts test/bot-console-access.test.ts
yarn esbuild bin/bot-console.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/bot-console.mjs
BOT_CONSOLE_AUTH_SECRET_ARN=arn:aws:secretsmanager:us-east-1:590183914614:secret:bot-console/auth-AbCdEf yarn cdk synth --app 'node dist/bot-console.mjs' --quiet
```

The sample ARN is synthesis-only. Production CI requires the real secret ARN.
Tests cover state replay/expiry, missing MFA, unauthorized IDs, session expiry,
revocation, CSRF, storage failure, and infrastructure isolation. Browser rehearsal
is separate from a real Discord test server with the owner and secondary account.
No phone number is required by this app. Discord can impose its own account/server
verification requirements; its documentation says VoIP numbers are not accepted
for phone verification. Use a registered bot for automation, never a user self-bot.

## Access-stack CI

The Bot console access workflow tests and synthesizes on PRs. On main, it deploys
through the separate `bot-console-access-production` environment. Application
deployment waits for it. Manual dispatch from main is also supported. Access deployment runs when access sources, workflow, or CDK dependencies change;
normal application-only releases skip that approval. Manual dispatch always checks
the access stack, with unchanged permissions producing an empty changeset.

The dedicated OIDC role can update only `FlsBotConsoleAccess`, using a dedicated
execution role scoped to the two application deployment roles and runtime boundary.
Neither workflow can change the access-CI roles. No long-lived AWS keys are used.
Review the `bot-console-access-template` artifact before deployment approval.

One-time operator bootstrap, also used for future CI-authority changes:

```sh
cd deploy
yarn esbuild bin/bot-console-access-ci.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/bot-console-access-ci.mjs
yarn cdk diff FlsBotConsoleAccessCi --app 'node dist/bot-console-access-ci.mjs' --profile fls-admin
yarn cdk deploy FlsBotConsoleAccessCi --app 'node dist/bot-console-access-ci.mjs' --profile fls-admin
```

Before merging, create `bot-console-access-production` with a required operator
reviewer, only `main` allowed, and administrator bypass disabled. The first CI
update replaces the access stack's CDK bootstrap execution role with the scoped
`FlsBotConsoleAccessExecution` role.

Before enabling live moderation, add exact-action approvals and an executor as a
separate reviewed increment. This release has no Discord listener, announcement
publisher, inference calls or Rose commands.

## Telegram capture

The receiver authenticates Telegram's webhook secret and accepts messages and
observed edits only from allowlisted group IDs. It acknowledges only after SQS
accepts the normalized record. A separate writer saves immutable revisions and a
latest-message projection with conditional writes; retries repair partial writes
without duplicating evidence or replacing newer edits. Failed records retry five
times before moving to the dead-letter queue (14-day retention). The incoming
queue retains records for four days. Inspect failures before manually redriving;
the worker checks the current allowlist again.

Text, sender attribution, attachment metadata and observed revisions are retained
for three years from the original message date. Expired records are hidden before
DynamoDB TTL cleanup. Photos/files are not downloaded. Telegram message deletion
is not reflected here, and messages/edits before capture cannot be reconstructed.
Point-in-time recovery is enabled, so backups can temporarily retain expired data.
Both evidence and untrusted instructions are rendered as plain text.

Only the authenticated operator can read messages, paginate history or inspect
connection configuration and approximate queue counts. A recorded webhook setup
time is not a live Telegram health check; an idle group is not proof of failure.
The receiver and writer have no Telegram bot token. A separate verifier Lambda
can read `bot-console/telegram-verifier`; its only handler checks the exact group
ID and bot administrator membership. Only the console API can invoke it. There is
no generic Telegram proxy or message sender.

### Connect and manage groups

1. Sign in as an approved operator and open the Telegram inbox.
2. Select **Connect group** and copy the command, for example
   `/start@famesocietybot 7KMP-X4RT`.
3. Add the bot to the intended group as an administrator and send the command
   there. No numeric ID lookup is needed. The bot does not reply.
4. The panel shows a **pending** request with the group name, numeric ID,
   Telegram sender and console code issuer. Check the group and select
   **Approve capture** or **Reject**. Approval verifies current bot membership.
5. Send a new message, then edit it. Verify both versions in captured history.
   Capture starts with original messages dated after the approval second, avoiding
   same-second/pre-approval backlog. Edits to older messages are not imported.
6. **Disconnect** stops capture and preserves existing history. To reconnect,
   generate a fresh code, send it in the group and approve the new request.

Codes have eight random Crockford Base32 symbols (40 bits), displayed `XXXX-XXXX`.
Lowercase and omission of the hyphen are accepted. They expire after ten minutes,
are single-use, and only SHA-256 hashes are stored. TTL cleanup is not the expiry
check. The Telegram sender need not match the console operator: possession of the
code authorizes a pending request, while panel approval still gates capture.
Invalid, expired, revoked and used codes are silently ignored. Private chats,
channels, forwarded/edited commands and anonymous sender-chat commands cannot
redeem them. Pending or already-active groups cannot consume another code.
**Revoke code** invalidates an unused code; generating another from the same panel
first revokes its previous unused code. Plaintext codes exist only in the issuing
browser view; reloading loses them.

Redemption allows five well-formed attempts per group per minute and 100 across
all groups per minute. Issuance allows ten codes per operator per minute. Atomic
transactions consume the code, establish the pending request and record attribution
together. Conditional decisions prevent concurrent operators overwriting each other.
All approved operators can manage associations. Group/decision audit records are
retained; invite/rate records expire.

Commands are intercepted before group authorization and excluded from message
storage, including later edits to the same message. Every archive write checks the
active association and command exclusion in its transaction. Disconnect prevents
in-flight writes; reconnect assigns a fresh association ID so old queue records
cannot resume capture. Groups with prior history remain in the inbox. A Telegram
group upgrade that changes its numeric ID requires a new connection.

### Deploy this increment

1. Review the access-stack changes. Existing CI updates `FlsBotConsoleAccess`
   before deploying the application. No change to `FlsBotConsoleAccessCi` is needed.
2. **Before merging**, provision the verifier credential:

   ```sh
   cd apps/bot-console
   AWS_PROFILE=fls-admin node --import tsx scripts/telegram-setup.ts provision-verifier
   ```

   This operator-only script reads just `TELEGRAM_BOT_TOKEN` from Doppler
   `fls-society-agents / prd-controller` into memory, verifies the AWS account and
   bot identity, then writes the dedicated AWS secret. CI never handles its value.
   Repeat only on token rotation. Never paste credentials into arguments or logs.

3. For this first queue-format cutover only, run
   `AWS_PROFILE=fls-admin node --import tsx scripts/telegram-setup.ts pause`.
   This removes the webhook without dropping pending updates. Wait for the old
   incoming queue's visible and in-flight counts to reach zero and investigate any
   dead letters before proceeding. Keep the pause short: Telegram retains pending
   updates for at most 24 hours. Do not run a competing getUpdates poller.
   Merge the reviewed change and approve the access workflow's IAM update. Main CI
   deploys the registry, verifier and console. A create-only custom resource seeds
   **FLS Bot `-1004423197212`**, already operator-approved and live-tested on
   2026-10-03, before switching the API/receiver/writer to the registry. It imports
   no other groups, preserves message history, and never overwrites the association
   on subsequent deployments. Its activation cutoff is zero to preserve previously
   approved capture. The receiver secret's creation template remains unchanged to
   avoid rotating its live webhook secret; no runtime consults its obsolete `chats`
   property.
4. After successful deployment, run the `register` command below to resume
   delivery with the existing secret, preserving Telegram's pending updates.
   If deployment rolls back before registration, use the previous revision's
   setup script and its group-ID registration instructions to restore delivery.
   Do not use this revision's `register` against the old app: it removes the
   obsolete secret-backed group list required by that app.
   Resume delivery within Telegram's 24-hour retention window.
   Confirm FLS Bot is active and its prior history remains visible. Test a fresh
   connection, invalid code, rejection, approval, message/edit capture, disconnect
   and reconnect in an operator-controlled test group. Local checks do not establish
   live delivery proof for this new flow.

The original webhook test succeeded on 2026-10-03 for FLS Bot: a new message and
its edit appeared in the authenticated inbox. Onboarding needs its own live test.

### Webhook maintenance

Connecting groups does not re-register the webhook. The initial rollout pause
above is a one-time cutover step; normal application releases keep registration.
For a fresh environment or explicit maintenance only:

```sh
AWS_PROFILE=fls-admin node --import tsx scripts/telegram-setup.ts inspect
AWS_PROFILE=fls-admin node --import tsx scripts/telegram-setup.ts register
```

Registration verifies the bot and AWS account, refuses another service's webhook,
preserves pending updates and records registration time. It no longer accepts a
group ID or edits associations. Manage those in the panel. Inspect before retrying
failed setup; only sanitized errors are emitted.


## Owner-managed access

Access & roles is the production RBAC interface. Owners can register people by
stable `discord:<user-id>`, assign roles/scopes, disable access, and revoke every
session for a person. Identity names are labels only. All people still need Discord
MFA enabled at login. Sign-in requires an enabled human principal with a role.

Roles are a reviewed catalog, not user-editable policy expressions:

| Role | Permissions | Scope |
| --- | --- | --- |
| Owner | Access administration, connection management, message reads | `*` |
| Connection manager | Connection reads/changes, invite generation/revocation | `*` |
| Inbox reader | Group metadata and captured messages/history | `telegram:*` or `telegram:<negative-chat-id>` |

Readers cannot manage connections, access other groups, or read the access registry
and audit. Managers cannot read messages. Only owners edit grants. The owner role
is human-only. Disabling the final owner or removing their owner role is rejected.
Concurrent changes use the global policy revision and cannot remove both remaining
owners. A stale edit must be refreshed and deliberately resubmitted.

Agents and services have distinct registered IDs (`agent:name`, `service:name`).
These entries are inventory only until a workload authentication integration is
implemented: no token is minted, no caller can authenticate by claiming an ID,
and grants do not alter Overclaw or vault authority. This release contains no
teams, role inheritance, join links, service delegation, or runtime controls.
Telegram connection codes remain connection credentials; they cannot grant portal
access. Future human invitations need an explicitly typed purpose and separate
redemption flow, even if the UI eventually shares a common invitation experience.

The registry is bounded at 100 principals and 20 grants per principal. A single
policy document makes owner constraints and optimistic concurrency atomic. Each
change and its before/after audit receipt are a DynamoDB transaction. The UI shows
the latest 50 receipts; older receipts remain in the retained table. This is an
application audit trail, not tamper-proof storage against an AWS administrator.

Sessions use hashed random tokens in Secure/HttpOnly cookies. Revocation advances
a per-person session generation; disabling also advances it, so re-enabling a
person does not revive those sessions. Seven-day idle / thirty-day absolute expiry
is a deliberate convenience tradeoff: the console checks grants every request but
does not recheck Discord MFA/account status until login. Existing session cookies
without a generation are rejected. Logout remains atomic and renewal cannot recreate
a deleted session. Permission-dependent browser query caches are partitioned by the
current principal/grants so a changed scope does not reuse another scope's data.

### RBAC deployment

The retained Access table is read/written only by the console API, plus a narrowly
scoped create-only bootstrap resource. Bootstrap seeds existing operator
`discord:931691901592145930` as the initial owner. It never rewrites later grants.
No new OAuth credential or manual secret prerequisite is needed. The existing
console DynamoDB boundary covers the table; review the synthesized permissions.

Deploy through normal console CI, sign in again, and verify the owner panel before
adding users. Test a second account with an exact-group reader grant, confirm direct
API denials, change its scope, revoke sessions, and verify the account must log in
again. Check the audit for each change. Local rehearsal uses synthetic in-memory
access and cannot prove real Discord login or AWS transaction behavior.

Do not roll back to the old allowlist-based application after admitting non-owners
without an explicit access review: it does not enforce this RBAC model. If all owner
access is lost due to external corruption, recovery is an operator-reviewed AWS
policy repair with a recorded incident; there is no public recovery endpoint.
