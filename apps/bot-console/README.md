# FAMEliza bot console

Admin-only React/Vite application for `https://bot.fame.support`, deployed in the
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
Click **Open local rehearsal** to inspect synthetic Telegram/Discord cases,
including 204 captured messages. Review, confirm or reject simulated proposals.
No platform messages, inference requests or moderation actions are sent. Mock
state resets when the process restarts. Stop with Ctrl-C. The mock login uses a
single shared local session and must never be hosted or exposed through a tunnel.

The production build contains no local fixture server or authentication bypass.
Its inbox is empty until a real authenticated ingestion/case service is added.
It intentionally exposes no live moderation execution endpoint in this release.
The local development proxy is not part of the deployed application.

## Authentication

Discord OAuth2 authorization-code flow, `identify` scope only, using oauth4webapi.
The backend checks the immutable Discord ID against the current admin allowlist
and requires `mfa_enabled === true`. Missing MFA is rejected. This confirms MFA
is enabled, not that Discord performed a fresh second-factor challenge. It does
not supply phishing-resistant application step-up authentication. Add explicit
WebAuthn step-up before broad privileged administration if that assurance is needed.

Random browser-bound OAuth state expires after five minutes and is atomically
consumed. Opaque sessions expire after 15 minutes without silent extension;
only hashes are persisted in DynamoDB. Expiry is checked independently of TTL
cleanup. The `__Host-` session cookie is Secure, HttpOnly, host-only and SameSite=Lax.
API responses are never cached. Mutations require the exact production Origin.
The callback URI is fixed; no caller-supplied return URL. OAuth provider tokens
are used only to retrieve identity and are not persisted or sent to the browser.

Auth config is loaded every request, so allowlist removal revokes access on the
next request. Discord account/MFA changes are checked at the next login; existing
sessions expire in at most 15 minutes. OAuth failure details and credentials are
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
`clientSecret`, and the `adminIds` array. GitHub receives only ARN configuration;
it does not need the Discord client secret or a Doppler token.
Only these three keys may be copied; do not export or sync the controller config.
The dedicated `bot-console/auth` secret was provisioned in FLS us-east-1 on
2026-10-02. Future rotations must explicitly update that runtime secret.

1. Register a Discord OAuth application (or explicitly configure the existing
   FAMEliza application) with redirect
   `https://bot.fame.support/api/auth/callback`. A bot token is not a client secret.
2. Securely create a dedicated Secrets Manager secret named `bot-console/auth`
   in FLS **us-east-1** with JSON fields `clientId`, `clientSecret`, and
   `adminIds: ["931691901592145930"]`. Never put the value into Git, CI variables,
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
   were provisioned on 2026-10-02; the application itself is not deployed yet.
5. Review the CDK diff before the first deployment. The stack creates the bot DNS
   record, ACM certificate, private S3/CloudFront distribution, Lambda/API Gateway,
   DynamoDB sessions and scoped secret access. No bot credentials or live listeners.
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

## Operator-only access provisioning

This stack is intentionally excluded from application CI deployment. Changes
require review and an authorized FLS operator. From `deploy`:

```sh
yarn esbuild bin/bot-console-access.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/bot-console-access.mjs
yarn cdk diff FlsBotConsoleAccess --app 'node dist/bot-console-access.mjs' --profile fls-admin
yarn cdk deploy FlsBotConsoleAccess --app 'node dist/bot-console-access.mjs' --profile fls-admin
```

Before enabling live moderation, add authenticated ingestion, durable evidence,
exact-action approvals and an executor as a separate reviewed increment. This
release has no Telegram/Discord listener, announcement publisher or Rose commands.
