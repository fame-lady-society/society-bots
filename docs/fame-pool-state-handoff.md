# FAME Pool-State Index Handoff

This repo now owns the `society-bots` side of the FAME pool-state read model used by `www` quote solving. Here `www` means the GitHub project `fame-lady-society/www`; on this machine, the companion checkout is `../fls-www`, not `../www`. The goal is to keep fast, fresh latest reserve and concentrated-liquidity head state available for the reviewed FAME swap pool universe, while leaving route authority and quote correctness tests in `www`.

## Cross-Repo Contract

- `www` remains authoritative for reviewed pool metadata, route candidates, venue capability, and quote parity.
- `society-bots` consumes a generated registry artifact from `fame-lady-society/www` (local checkout `../fls-www`) and indexes current Base reserve state for quote-model-capable pools, CL head snapshots for reviewed CL pools, and one complete `cl-replay-v1` snapshot for `slipstream-usdc-weth-100`.
- `www` calls the authenticated `society-bots` API from server-side quote paths. If indexed state is stale, unknown, unsupported, malformed, or not a quote model the caller can replay, `www` falls back to its existing live quote adapter.
- `society-bots` exposes raw replay primitives only. `www` owns Slipstream exact-input math, same-block live-quoter parity, route attribution, shadow mode, and any later promotion from live fallback to local CL quotes.

Primary `www` references:

- [Implementation plan](../../fls-www/docs/plans/2026-05-17-001-feat-society-bots-fame-pool-state-plan.md)
- [Route-lab indexed mode docs](../../fls-www/docs/fame-swap-route-lab.md)
- [Registry source](../../fls-www/src/features/fame-swap/solver/poolStateRegistry.ts)
- [Registry export script](../../fls-www/scripts/fame-swap-pool-state-registry.ts)
- [Indexed pool-state client](../../fls-www/src/features/fame-swap/solver/quotes/indexedPoolStateClient.ts)
- [Indexed reserve adapter](../../fls-www/src/features/fame-swap/solver/quotes/indexedReserveAdapter.ts)
- [Quote API wiring](../../fls-www/src/app/api/fame/swap/quote/handler.ts)

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

- A generated Base v1 pool registry copied from the local `../fls-www` checkout of `fame-lady-society/www`.
- Runtime validation for pool ids, addresses, capability flags, fees, and tracked-only reasons.
- A DynamoDB latest-state table model keyed by exact pool identity plus a per-chain cursor.
- A scheduled Base indexer Lambda that scans safe blocks for reserve-changing `Sync` logs, seeds quiet pools with `getReserves`, and advances the cursor only after successful processing.
- Reserve reconciliation after every log scan: every quote-model pool is read with `getReserves` at the safe block, and mismatched or missing latest rows are repaired before freshness/cursor advancement.
- An authenticated HTTP API route, `POST /fame/pool-state`, for bounded batch latest-state reads, protected by both API Gateway Lambda authorizer and API Lambda token checks.
- Structured indexer/API logs for freshness, status counts, registry id, and block coverage.
- Passive operational health signals: SQS-backed async failure destinations plus no-action CloudWatch alarms for indexer Lambda errors, indexer Lambda throttles, missed invocations, and failure queue depth.
- A replay snapshot lane for `slipstream-usdc-weth-100`: slot0, current liquidity, dynamic fee, full initialized tick bitmap words, initialized tick liquidity records, block identity, chunk counts, and state hash.

The indexed quote-model pool set covers Uniswap V2 constant-product pools plus volatile Solidly/Equalizer and volatile Aerodrome V2 pools. Stable pools, native wrapping, pools missing reviewed CL metadata, and unknown invariants stay visible as tracked-only or unsupported.

Slipstream, Slipstream2, Uniswap V3, and Uniswap V4 pools with reviewed metadata now have complete CL head snapshots: identity, fee metadata, tick spacing, state-view address where relevant, `sqrtPriceX96`, current tick, active liquidity, source, registry provenance, and `observedThroughBlock`. These rows are not local CL replay authority, do not carry tick-boundary warnings, and must not make `www` skip live reads for CL quote math.

`slipstream-usdc-weth-100` is the sole exception for replay state. It can publish a complete `cl-replay-v1` capsule, but the capsule is still indexed market-state evidence, not quote authority. `www` must reject stale, future-block, incomplete, malformed, mismatched-registry, mismatched-token-order, outside-range, replay-failed, or parity-failed state and serve the live quoter result while shadow mode is active.

## Final Review Notes

This section is for the `society-bots` coding agent doing the final review of this repo's side of the pool-state work. The companion `www` review is being handled separately in `fame-lady-society/www`, locally cloned as `../fls-www`.

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
- Run indexed route-lab from local `../fls-www` with `BASE_RPC_URL` or `FAME_POOL_STATE_CURRENT_BLOCK`.
- Run a `www` quote API smoke check.
- Run `yarn fame-pool-state:delta-replay-smoke <input-json>` with redacted indexer/quote evidence and attach the report.
- Watch at least five scheduled indexer intervals and confirm non-regressing `observedThroughBlock`, no Lambda errors/throttles, and failure queue depth `0`.

## Registry Refresh

When `www` changes the route universe, refresh the artifact from the local `../fls-www` checkout of `fame-lady-society/www`:

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
- `unsupported`: the pool is reviewed but not eligible for the requested indexed state surface.

The producer freshness default is configured by `FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS`. Callers may ask for stricter freshness, but cannot loosen the producer default.

Delta CL replay maintenance is separate from the quoteable replay pointer. The indexer may write `cl-replay-candidate-v1` shadow capsules and `cl-replay-maintenance-v1` lifecycle rows, then publish a quoteable replay pointer only after a checkpoint-clean trusted promotion. `/fame/pool-quotes` only emits `cl-quote-v1` when maintenance is trusted and exactly compatible with the replay pointer. Warming, event-gap, drift-failed, repairing, or source-mismatched maintenance rows surface as unavailable compact quote evidence so `www` keeps live fallback. The supported Slipstream maintenance event surface is `Swap`, `Mint`, `Burn`, and no-op `Collect`; unknown topics still fail closed.

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
- CL head snapshots are complete head-state rows, but they intentionally stop before boundary-window indexing, tick bitmap reads, or local CL quote replay. Fallback remains a normal client decision based on state kind, freshness, helper availability, and parser validity rather than a boundary warning bit.
- `cl-replay-v1` snapshots are latest-pointer plus chunk rows. The indexer writes chunks before publishing the pointer, and the API only returns replay state when every expected bitmap/tick chunk matches snapshot id, block identity, source registry id, and state hash.
- The replay snapshot intentionally uses periodic safe-block full scans first. Event-driven tick maintenance is deferred until this one-pool full-state proof has exact same-block parity against the live Slipstream quoter.
- Replay state includes the pool's dynamic `fee()` value at the snapshot block. Registry fee labels are not enough for local Slipstream replay.
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

Run from local `../fls-www` when proving consumption:

```sh
bun test src/features/fame-swap/solver/poolStateRegistry.test.ts src/features/fame-swap/solver/quotes/indexedPoolStateClient.test.ts src/features/fame-swap/solver/quotes/indexedReserveAdapter.test.ts src/features/fame-swap/solver/quotes/rankRoutes.test.ts src/features/fame-swap/solver/quoteWire.test.ts src/app/api/fame/swap/quote/route.test.ts scripts/fame-swap-route-lab.test.ts
BASE_RPC_URL=<rpc> FAME_POOL_STATE_API_URL=<url> FAME_POOL_STATE_SERVICE_TOKEN=<token> bun scripts/fame-swap-route-lab.ts --indexed
BASE_RPC_URL=<rpc> FAME_POOL_STATE_API_URL=<url> FAME_POOL_STATE_SERVICE_TOKEN=<token> bun scripts/fame-swap-cl-replay-parity.ts
```

Attach durable release evidence before enabling `www` production helper env:

- Smoke: authenticated helper call, valid response shape, at least one `fresh` quote-model pool, and returned `observedThroughBlock`.
- Soak: at least five scheduled indexer intervals with recent success logs, non-regressing `observedThroughBlock`, no unexpected errors/throttles, and failure queue depth `0`.
- Route lab: indexed success plus fallback-relevant stale, unknown, unsupported, malformed, and unavailable-helper cases.
- CL replay parity: exact same-block local-vs-live `amountOut` equality for representative WETH -> USDC and USDC -> WETH amounts, with snapshot id, block, state hash, bitmap word count, and initialized tick count attached.
- Evidence location: PR comment, checklist section, or linked artifact that reviewers can inspect without reconstructing the process from chat.

## Durable Follow-Ups

- Fix PR cleanup so `BotCert-PR-<number>` is deleted in `us-east-1`, and stop swallowing unexpected CloudFormation delete/wait failures with blanket `|| true`.
- Make malformed V4 registry rows impossible or explicitly rejected when they contain both `poolAddress` and `poolKey`; V4 CL head state should remain pool-key keyed instead of address keyed.
- Parallelize the independent reserve-state and CL head-state DynamoDB `BatchGet` calls if helper latency from CL opt-in becomes material.
- Use the first full replay capsule to decide whether event-driven tick maintenance, bounded tick windows, or hybrid safe-block snapshot plus event replay is worth the complexity.

## Next Safe Extensions

- Add SPX/FAME and cbBTC/FAME only after the authoritative `www` route metadata includes those pools.
- Add stricter freshness or faster ingestion only after scheduled indexing proves useful in route-lab evidence.
- Add stable or additional concentrated-liquidity local replay only after `www` proves the one-pool Slipstream math and parity harness.
- Extend CL indexing toward tick windows, event-driven updates, or boundary-adjacent quote assistance only after the current complete replay snapshot surface proves useful.
