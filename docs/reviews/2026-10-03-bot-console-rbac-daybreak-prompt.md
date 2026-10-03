# Independent Daybreak security review: bot console RBAC

Review the `codex/bot-console-rbac` branch against `origin/main` in
`fame-lady-society/society-bots`. Local worktree: `/private/tmp/society-bots-rbac`.
You are an independent reviewer. Do not modify production resources, retrieve
credentials, send Discord/Telegram messages, merge, deploy, or change the source.
You may run local tests and construct isolated reproduction tests. Return findings
with severity, exact file/line, exploit prerequisites, impact, reproduction, and
minimal fix. Clearly distinguish confirmed defects from design tradeoffs.

Objective: prove owner-managed scoped RBAC and sticky browser sessions resist
privilege escalation, cross-resource reads, stale authorization, and session replay.
There are no teams, public invitations, agent credentials or Overclaw controls in
this increment. Agent/service entries are inventory; they must confer no usable
runtime identity or vault permission. The real Telegram connection flow must remain
functional for owners and connection managers.

Review these boundaries:

1. Discord OAuth state, identity/MFA check, session issuance/renewal and origin checks.
2. Seven-day idle / thirty-day maximum lifetime, hashed cookie storage, epoch-based
   revocation, disable/re-enable, logout races, renewal races, and old-session rejection.
3. Every protected HTTP method/path, including status metadata, message revisions,
   pagination, invites, group decisions, session info, access registry and audit.
4. Reader exact-group scope and manager/message separation; malformed scopes,
   forged principal kinds, duplicate IDs, service-owner grants, and direct API calls.
5. Owner-only access changes, simultaneous owner removals, stale policy versions,
   mutable request attribution, and atomic policy/audit persistence. Inspect actual
   DynamoDB transaction conditions, not only the in-memory test double.
6. UI cache isolation after changes in identity/roles/scopes, error handling, and
   whether displayed controls truthfully match backend permissions.
7. IAM, CDK create-only owner bootstrap, retention, policy size limits, recovery and
   downgrade behavior. The initializer must never regrant revoked access on update.
8. Sensitive information in errors, payloads, audit records, frontend output or logs.

Run application tests/build and targeted CDK tests if dependencies are available.
No local tests establish deployed AWS behavior or browser OAuth acceptance.
The known convenience tradeoff is that Discord account/MFA state is not re-fetched
until login; permission changes and session revocations are checked on every API
request. Identify whether additional fresh-auth requirements are warranted for owner
changes, without silently changing the product requirements.

Finish with: blocking findings, nonblocking findings, validation performed, coverage
limits, and an explicit recommendation on readiness for deployment review.
