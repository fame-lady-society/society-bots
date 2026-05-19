# FAME Pool-State Index Handoff

This repo now owns the `society-bots` side of the FAME pool-state read model used by `www` quote solving. The goal is to keep fast, fresh latest-reserve state available for the reviewed FAME swap pool universe, while leaving route authority and quote correctness tests in `www`.

## Cross-Repo Contract

- `www` remains authoritative for reviewed pool metadata, route candidates, venue capability, and quote parity.
- `society-bots` consumes a generated registry artifact from `www` and indexes current Base reserve state for the quote-model-capable pools in that artifact.
- `www` calls the authenticated `society-bots` API from server-side quote paths. If indexed state is stale, unknown, unsupported, or malformed, `www` falls back to its existing live quote adapter.

Primary `www` references:

- [Implementation plan](../../www/docs/plans/2026-05-17-001-feat-society-bots-fame-pool-state-plan.md)
- [Route-lab indexed mode docs](../../www/docs/fame-swap-route-lab.md)
- [Registry source](../../www/src/features/fame-swap/solver/poolStateRegistry.ts)
- [Registry export script](../../www/scripts/fame-swap-pool-state-registry.ts)
- [Indexed pool-state client](../../www/src/features/fame-swap/solver/quotes/indexedPoolStateClient.ts)
- [Indexed reserve adapter](../../www/src/features/fame-swap/solver/quotes/indexedReserveAdapter.ts)
- [Quote API wiring](../../www/src/app/api/fame/swap/quote/handler.ts)

Primary `society-bots` references:

- [Operational docs](./fame-pool-state-index.md)
- [Generated registry artifact](../src/fame-swap-pool-state/registry/base-v1-pools.json)
- [Registry parser and validation](../src/fame-swap-pool-state/registry/index.ts)
- [Indexer](../src/fame-swap-pool-state/indexer.ts)
- [API handler logic](../src/fame-swap-pool-state/api.ts)
- [DynamoDB helpers](../src/fame-swap-pool-state/dynamodb/pool-state.ts)
- [CDK construct](../deploy/lib/fame-pool-state.ts)

## What Landed Here

The `society-bots` implementation adds a new `src/fame-swap-pool-state` module plus CDK wiring:

- A generated Base v1 pool registry copied from `www`.
- Runtime validation for pool ids, addresses, capability flags, fees, and tracked-only reasons.
- A DynamoDB latest-state table model keyed by exact pool identity plus a per-chain cursor.
- A scheduled Base indexer Lambda that scans safe blocks for reserve-changing `Sync` logs, seeds quiet pools with `getReserves`, and advances the cursor only after successful processing.
- Reserve reconciliation after every log scan: every quote-model pool is read with `getReserves` at the safe block, and mismatched or missing latest rows are repaired before freshness/cursor advancement.
- An authenticated HTTP API route, `POST /fame/pool-state`, for bounded batch latest-state reads, protected by both API Gateway Lambda authorizer and API Lambda token checks.
- Structured indexer/API logs for freshness, status counts, registry id, and block coverage.
- Passive operational health signals: SQS-backed async failure destinations plus no-action CloudWatch alarms for indexer Lambda errors, indexer Lambda throttles, missed invocations, and failure queue depth.

The first indexed quote-model pool set covers Uniswap V2 constant-product pools plus volatile Solidly/Equalizer and volatile Aerodrome V2 pools. Stable pools, native wrapping, Slipstream, Uniswap V3, Uniswap V4, and unknown invariants stay visible as tracked-only or unsupported; this repo must not pretend those are locally replayable until `www` adds authoritative math and tests.

## Final Review Notes

This section is for the `society-bots` coding agent doing the final review of this repo's side of the pool-state work. The companion `www` review is being handled separately.

Recent follow-up changes in `society-bots`:

- Indexer correctness:
  - `src/fame-swap-pool-state/indexer.ts` now reconciles every quote-model pool with `getReserves` at the safe block after Sync log processing.
  - Missing rows are still counted as `seededPools`; existing rows whose reserves differ are counted as `reconciledPools`.
  - Pool `observedThroughBlock` and the chain cursor advance only after reconciliation succeeds for every quote-model pool.
  - A reconciliation write uses source `getReserves` and a same-block max event version so the safe-block repair wins after all logs through that safe block have already been processed.
- API correctness:
  - `src/fame-swap-pool-state/api.ts` accepts exactly one pool request key shape: `{ poolId }` or `{ chainId, poolAddress }`.
  - Mixed request keys are request validation errors, not best-effort lookups.
  - If stored `observedThroughBlock` is greater than caller `currentBlock`, the API returns `stale` so `www` falls back live.
- Gateway auth:
  - Added `src/fame-swap-pool-state/lambdas/authorizer.ts`.
  - `deploy/lib/http-api.ts` protects `POST /fame/pool-state` with an API Gateway Lambda authorizer before the API Lambda is invoked.
  - The API Lambda still performs its existing token check as defense in depth.
- Pool-state-only dev deploy:
  - Added `deploy/lib/fame-pool-state-dev-stack.ts` and `POOL_STATE_ONLY=true` handling in `deploy/bin/deploy.ts`.
  - Added PR label lane `DEPLOY_POOL_STATE_DEV` in `.github/workflows/pr-deploy.yml`.
  - That path deploys only DynamoDB, indexer Lambda, API Lambda, authorizer Lambda, HTTP API route, and endpoint output. It intentionally does not require image, Discord, Farcaster, custom domain, or cert env.
- Tests/docs:
  - Added API, indexer, authorizer, and CDK coverage for the above.
  - Updated this handoff and operational docs to describe reconciliation, future-block stale behavior, authorizer protection, and rollout order.

Files most relevant to review:

- `src/fame-swap-pool-state/indexer.ts`
- `src/fame-swap-pool-state/api.ts`
- `src/fame-swap-pool-state/lambdas/authorizer.ts`
- `deploy/lib/fame-pool-state.ts`
- `deploy/lib/http-api.ts`
- `deploy/lib/fame-pool-state-dev-stack.ts`
- `deploy/bin/deploy.ts`
- `.github/workflows/pr-deploy.yml`
- `deploy/test/fame-pool-state.test.ts`
- `src/fame-swap-pool-state/indexer.test.ts`
- `src/fame-swap-pool-state/api.test.ts`
- `src/fame-swap-pool-state/lambdas/authorizer.test.ts`

Review reminders:

- There are unrelated dirty changes in the broader repo from other work. Keep this review focused on the pool-state module, deploy wiring, and PR workflow lane.
- Do not add registry-authority duplication here. `www` remains the authoritative source for pool metadata, route eligibility, and quote math tests.
- Do not broaden this into historical backfill, chunked scanners, WAF/private networking, stable-pool math, or notifier coverage. Those are intentionally out of scope for this pass.
- The pool-state dev stack is allowed to be pragmatic and shared; the goal is fast proof of the helper and quoter integration, not a polished environment matrix.

Final todos before enabling `www` production helper env:

- Set or generate `FAME_POOL_STATE_DEV_SERVICE_TOKEN`.
- Deploy with `DEPLOY_POOL_STATE_DEV`.
- Copy the emitted `FamePoolStateDevEndpointUrl` into `www` dev as server-only `FAME_POOL_STATE_API_URL`.
- Set matching `FAME_POOL_STATE_SERVICE_TOKEN` in `www` dev.
- Run an authenticated helper smoke call.
- Run indexed route-lab from `www` with `BASE_RPC_URL` or `FAME_POOL_STATE_CURRENT_BLOCK`.
- Run a `www` quote API smoke check.
- Watch at least five scheduled indexer intervals and confirm non-regressing `observedThroughBlock`, no Lambda errors/throttles, and failure queue depth `0`.

## Registry Refresh

When `www` changes the route universe, refresh the artifact from the `www` repo:

```sh
bun scripts/fame-swap-pool-state-registry.ts > ../society-bots/src/fame-swap-pool-state/registry/base-v1-pools.json
```

Then run the `society-bots` registry, indexer, API, and deploy tests. Do not hand-edit pool metadata in `society-bots`; fix the source metadata or classification in `www`, regenerate, and commit the generated artifact.

## Runtime Behavior

Freshness is measured by `observedThroughBlock`, not by the last block where reserves changed. A quiet pool is fresh if the indexer has scanned recent safe blocks and observed no reserve-changing events.

Status meanings:

- `fresh`: indexed state exists and satisfies the effective freshness bound.
- `stale`: indexed state exists but is too far behind the requested block context.
- `unknown`: the pool is absent from the registry or has no latest row yet.
- `unsupported`: the pool is reviewed but not eligible for v1 local reserve replay.

The producer freshness default is configured by `FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS`. Callers may ask for stricter freshness, but cannot loosen the producer default.

## AWS Surface

`deploy/lib/fame-pool-state.ts` creates:

- DynamoDB table: latest pool state rows and cursor rows.
- Scheduled indexer Lambda: requires `BASE_RPCS_JSON`, validated as a non-empty JSON array of non-empty RPC URLs.
- API Lambda: requires an environment-scoped service token. Main deploy uses `FAME_POOL_STATE_SERVICE_TOKEN`; PR deploy uses `FAME_POOL_STATE_PR_SERVICE_TOKEN`.
- EventBridge schedule: defaults to once per minute.
- HTTP API route: `POST /fame/pool-state`.

The API accepts auth through `Authorization: Bearer <token>`. `www` should set `FAME_POOL_STATE_API_URL` and `FAME_POOL_STATE_SERVICE_TOKEN` only on the server side.

PR deploys must run under `STAGE=PR-<number>` so they synthesize `Bot-PR-<number>` and `BotCert-PR-<number>` instead of the shared dev stack. Cleanup deletes only those named CloudFormation stacks and does not require the production helper token.

For pool-state-only live validation before merge, add the `DEPLOY_POOL_STATE_DEV` label to the PR. That deploys `BotPoolStateDev` with only `BASE_RPCS_JSON` and `FAME_POOL_STATE_DEV_SERVICE_TOKEN`, and emits `FamePoolStateDevEndpointUrl` for `/fame/pool-state`. It does not require image, Discord, Farcaster, custom domain, or cert env.

For messy full-app validation before merge, add the `DEPLOY_DEV` label to the PR. That updates the existing `Bot-dev` / `BotCert-dev` stacks with `IMAGE_BASE_HOST_JSON=["dev","fame.support"]`, uses `FAME_POOL_STATE_DEV_SERVICE_TOKEN`, and disables the scheduled event processors for that deploy path. It does not trigger the production `main` deploy workflow.

The scheduled indexer failure destination and passive alarms are intended for inspection, not paging. For this community service, first-release readiness requires the release owner to inspect the failure queue depth, passive alarm states, and recent `observedThroughBlock` logs before enabling `www` production helper env.

## Important Implementation Details

- The indexer decodes both Uniswap V2-style `Sync(uint112,uint112)` and Solidly/Aerodrome-style `Sync(uint256,uint256)` events. Dropping either would make freshness misleading.
- The Lambda bundle copies `base-v1-pools.json` beside `index.mjs`; the registry parser reads that file at runtime.
- Latest-state writes are monotonic by reserve event version and `observedThroughBlock` so duplicate, out-of-order, or older overlapping runs cannot rewind state freshness.
- `getReserves` reconciliation uses the safe block after log processing, so quiet pools stay fresh and missed/mismatched Sync-derived reserves are repaired without adding a historical backfill system.
- Unknown Sync logs are treated as fatal before cursor advancement.
- API freshness fails safe: if an indexed row is somehow observed through a block greater than the caller's `currentBlock`, the response is `stale`.
- API requests accept exactly one key shape per pool: `{ poolId }` or `{ chainId, poolAddress }`. Mixed key shapes are rejected.
- API transport errors and malformed indexed quote responses are expected to make `www` fall back to live reads, not to produce a best-effort quote from bad state.
- DynamoDB `UnprocessedKeys` are treated as incomplete helper reads, not as missing pool state.

## Verification Checklist

Run from `society-bots`:

```sh
TMPDIR=/tmp node --experimental-vm-modules ./node_modules/.bin/jest src/fame-swap-pool-state/registry/index.test.ts src/fame-swap-pool-state/dynamodb/pool-state.test.ts src/fame-swap-pool-state/indexer.test.ts src/fame-swap-pool-state/api.test.ts src/fame-swap-pool-state/lambdas/api.test.ts src/fame-swap-pool-state/lambdas/authorizer.test.ts
TMPDIR=/tmp ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Run from `society-bots/deploy`:

```sh
TMPDIR=/tmp node --experimental-vm-modules ./node_modules/.bin/jest test/fame-pool-state.test.ts
TMPDIR=/tmp ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Run from `www` when proving consumption:

```sh
bun test src/features/fame-swap/solver/poolStateRegistry.test.ts src/features/fame-swap/solver/quotes/indexedPoolStateClient.test.ts src/features/fame-swap/solver/quotes/indexedReserveAdapter.test.ts src/features/fame-swap/solver/quotes/rankRoutes.test.ts src/features/fame-swap/solver/quoteWire.test.ts src/app/api/fame/swap/quote/route.test.ts scripts/fame-swap-route-lab.test.ts
BASE_RPC_URL=<rpc> FAME_POOL_STATE_API_URL=<url> FAME_POOL_STATE_SERVICE_TOKEN=<token> bun scripts/fame-swap-route-lab.ts --indexed
```

Attach durable release evidence before enabling `www` production helper env:

- Smoke: authenticated helper call, valid response shape, at least one `fresh` quote-model pool, and returned `observedThroughBlock`.
- Soak: at least five scheduled indexer intervals with recent success logs, non-regressing `observedThroughBlock`, no unexpected errors/throttles, and failure queue depth `0`.
- Route lab: indexed success plus fallback-relevant stale, unknown, unsupported, malformed, and unavailable-helper cases.
- Evidence location: PR comment, checklist section, or linked artifact that reviewers can inspect without reconstructing the process from chat.

## Durable Follow-Ups

- Fix PR cleanup so `BotCert-PR-<number>` is deleted in `us-east-1`, and stop swallowing unexpected CloudFormation delete/wait failures with blanket `|| true`.

## Next Safe Extensions

- Add SPX/FAME and cbBTC/FAME only after the authoritative `www` route metadata includes those pools.
- Add stricter freshness or faster ingestion only after scheduled indexing proves useful in route-lab evidence.
- Add stable or concentrated-liquidity local replay only after `www` owns the math and parity tests.
