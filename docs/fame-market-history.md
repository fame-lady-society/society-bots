# FAME market history

## Implementation status

The approved plan is `docs/plans/2026-10-03-001-feat-affordable-market-history-plan.md`.
This first increment implements a bounded Base log collector, lossless compressed
S3 batches, atomic DynamoDB manifests/cursors/pending aggregation work, and
periodic capture of existing liquidity state. It has a separate CDK stack entrypoint.
It does not alter the quote poller or notifier. The `Market history` GitHub Actions
workflow deploys the separate `FameMarketHistory` stack; the existing bot stack's
deployment does not deploy this service.

No production collection, measured cost claim, candle API, Parquet job, or
historical backfill has shipped. Steps 2 and 3 remain outstanding.

## Which events are captured?

`eth_getLogs` filters by the emitting contract address, not the transaction's
destination or caller. A wallet calling a router, which internally calls one of
the registered pools, produces pool logs that this collector captures. Nested
calls do not require transaction traces or per-transaction receipts. Reverted
calls leave no persistent logs. Under `DELEGATECALL`, the log emitter is the
calling execution context (for example the proxy), not the implementation.

Logs emitted by a token contract, router, position manager, or unrelated pool
are not automatically included merely because they participated in the same
transaction. The current scope archives all logs from the five pool addresses.
That preserves pool swap and liquidity events for the planned per-pool charts;
it does not claim a wallet ledger, router attribution, or all FAME transfers.
Shared-manager venues such as V4 need their own emitter plus indexed pool-ID
filters if added later.

One multi-address log query covers each range, with bounded splitting only when
required. Header requests are shared by events in the same block. There are no
per-trade receipts, transaction fetches, traces, or notification enrichments.
This is a cost-conscious baseline, not a proven optimum: all-address log capture
retains extra LP-transfer events, and quiet runs still validate boundary headers.

## Scope and challenged assumptions

1. **Event filters can miss liquidity events.** The initial collector requests
   all logs emitted by the five exact direct-FAME pool addresses in the generated
   registry. This includes swaps, liquidity events, and LP transfers. It excludes
   all connector pools and never requests an entire shared V4 PoolManager.
   This is a deliberate revision of event-topic filtering: measure the extra LP
   log bytes first. An unrecognized event remains losslessly archived, even while
   its decoder/derived interpretation awaits verification. Raw coverage does not
   imply normalized trade/candle coverage.
2. **There are no direct-FAME V4 pools in this registry.** Do not implement a
   speculative V4 reader now. A future direct V4 entry fails scope construction
   until indexed pool-ID filtering and tests are added. Quote eligibility does
   not govern history scope. Archive scope includes actual pool identities, so
   quote-only registry revisions do not reset event coverage.
3. **Finalized reads are delayed.** The collector requires the RPC `finalized`
   tag and Base chain ID 8453. It never substitutes latest. Verify the provider's
   implementation and actual lag in rehearsal. Boundary/header consistency does
   not cryptographically prove that a provider returned every log: compare event
   identities against a second source on representative ranges before activation.
4. **Liquidity observations are not finalized events.** The quote table may be
   newer than finalized history. Snapshots preserve their original observed
   block/update time and are labeled `source-observation-unverified`. Missing
   rows are explicit. No new time/finality is fabricated, and no TVL/depth claim is
   made. Repeated snapshots across batches must be deduplicated by pool and source
   observation identity by the later aggregation worker.
5. **Busy ranges can exhaust header calls.** Only event-bearing blocks and
   boundaries need headers. If necessary the collector commits a fully read
   prefix within its remaining request allowance. It must never call that prefix
   the full requested range. Oversized responses split into smaller RPC ranges;
   single-block overflow fails without publication. Max event count still requires
   a smaller configured range if exceeded; this is a fail-fast limit, not truncation.
6. **S3 and DynamoDB are not one transaction.** Objects are uploaded and SHA-256/
   length-verified first. One DynamoDB transaction conditionally publishes the
   active scope, manifest, next cursor, and pending work. Conditional S3 creation
   prevents replacing an existing content-addressed object. Failed publication
   can leave unreferenced objects; readers must enumerate committed manifests,
   not bucket contents. A later retry may capture a newer liquidity observation
   and therefore create a different object; only the winning manifest is visible.
7. **Request allowance is not a dollar cap.** Every outbound RPC attempt reserves
   one unit with a conditional daily DynamoDB update; viem retries are disabled.
   Failed reservations stop outbound calls. A lost reservation is conservative.
   Read-only rehearsal uses a per-run allowance but does not mutate the daily
   ledger, so its cost must be accounted separately. AWS requests, SSM reads,
   headers, provider method weights, and storage/version growth need measurement.
8. **No ABI assumptions are required to retain raw logs.** Canonical V2 and
   Slipstream sources support the planned decoder families, but per-deployment
   ABI/token-decimal verification is still needed before normalized candles.
   Blockscout ABI lookup on 2026-10-03 returned exhausted PRO credits; no equivalent
   live validation is claimed. Request operator assistance if credits or another
   approved verified-source route is needed for that phase.

Initial inventory (generated identities, no copied pool address list):

| Registry ID | Venue family | Raw coverage |
| --- | --- | --- |
| scale-equalizer-frxusd-fame | Solidly | All emitting logs |
| scale-equalizer-scale-fame | Solidly | All emitting logs |
| scale-equalizer-weth-fame | Solidly | All emitting logs |
| slipstream-basedflick-fame | Slipstream | All emitting logs |
| uniswap-v2-fame-direct | UniswapV2 | All emitting logs |

Historical creation blocks and token decimals are deliberately not guessed.
The live start block is an explicit deployment input; earlier history is missing.

## Layout and recovery

- Raw S3 objects: `raw/fame-market-raw-v1/chain=8453/scope=<digest>/<from>-<to>/<sha256>.jsonl.gz`.
- First JSONL row: schema, scope/registry provenance, range headers, and liquidity
  observations. Remaining rows: original event bytes plus identity and timestamp.
- Cursor: `pk=scope:<digest>, sk=cursor`, consistent read, conditional next block
  and previous hash. Configuring a different initial start never resets a cursor.
- Active scope: `pk=history:8453, sk=active-scope`. Identity/filter changes stop
  collection until an explicit coverage transition is reviewed; they never
  silently restart from the original start block.
- Manifest: same partition, `sk=range:<16-digit-start>`.
- Pending aggregation: `pk=work:<digest>, sk=range:<16-digit-start>`; no worker
  consumes this until step 2. Never delete it merely because aggregation is absent.
- Daily allowance: `pk=budget:base-history, sk=YYYY-MM-DD` in UTC. Only these
  accounting rows have a 90-day TTL. Manifests/cursors/archive do not expire.

A failed run never commits a partially scanned range. Check the last committed
cursor and daily allowance before retrying. A changed committed block hash requires
operator investigation and a canonical repair procedure; do not reset the cursor
or advance it past the problem. Even a caught-up invocation rejects a conflicting
finalized boundary or a finalized head behind committed coverage.
Automated replacement/repair tooling belongs to
the backfill/rebuild increment and must be finished before exposing candle history.

## Configuration and bounded rehearsal

Production runtime requires `FAME_HISTORY_RPC_URL` (HTTPS, do not print),
`FAME_HISTORY_TABLE`, `FAME_HISTORY_BUCKET`, `FAME_HISTORY_POOL_STATE_TABLE`,
`FAME_HISTORY_START_BLOCK`, and `FAME_HISTORY_DAILY_REQUESTS`. Rehearsal requires
only the RPC URL, existing pool-state table, and explicit start block; it can run
before any history resources are created. Supply `FAME_HISTORY_TABLE` only when
intentionally rehearsing from an existing history cursor.
Optional bounds: `FAME_HISTORY_MAX_REQUESTS` (256), `FAME_HISTORY_MAX_BLOCKS`
(500), `FAME_HISTORY_MAX_EVENTS` (5000), and `FAME_HISTORY_MAX_RESPONSE_BYTES`
(4 MiB per response). Transport also enforces an 8 MiB total response allowance
per run. These are safety bounds, not validated production sizing.

With explicitly supplied runtime environment, run:

```sh
yarn nodets scripts/market-history/rehearse.ts
```

This reads the existing liquidity table (and history cursor only if configured)
and makes bounded RPC requests.
It never writes S3, manifests, cursors, or the daily ledger. It reports request
counts by method, response bytes, covered prefix, event count, and compressed size.
It still consumes provider quota. Do not load or print a general secret dump to
prepare the environment. A real dry-run needs AWS read access and the chosen RPC.

Verified local setup on 2026-10-03: Doppler project `fls`, config `dev`, contains
`BASE_RPC`; the directory's inherited Doppler config was unrelated (`fame-contracts`).
Specify the project/config explicitly rather than changing global/local defaults
or loading unrelated secrets. GitHub has both `BASE_RPCS_JSON` and
`FAME_POOL_STATE_INDEXER_BASE_RPCS_JSON`; GitHub exposes their names, not readable
values. The deployed indexer's primary endpoint differs from Doppler's `BASE_RPC`.

Reproduce the fixed historical sample locally with Node 24 and a valid
`fls-power` AWS session (the secret is passed only through the process environment;
do not enable shell tracing):

```sh
AWS_PROFILE=fls-power AWS_REGION=us-west-1 \
FAME_HISTORY_RPC_URL="$(doppler secrets get BASE_RPC --project fls --config dev --plain)" \
FAME_HISTORY_POOL_STATE_TABLE=Bot-prod-FamePoolState5E3B5F6E-S7X39UX7FUQJ \
FAME_HISTORY_START_BLOCK=52090000 FAME_HISTORY_MAX_BLOCKS=50000 \
FAME_HISTORY_MAX_REQUESTS=64 FAME_HISTORY_TABLE= \
yarn nodets scripts/market-history/rehearse.ts
```

This is a fixed reproducible test range, not the proposed production start block.

## Deployment boundary

Deployment runs through `.github/workflows/market-history.yml`. Pull requests
run tests/type checks. After merge, explicitly dispatch `Market history` from
`main` with the reviewed `start_block` and `daily_requests`. Keep the original
start block on subsequent deployments; changing it is not a backfill mechanism.
The workflow uses the existing AWS Actions credentials, verifies account
`590183914614`, discovers the pool-state table from `Bot-prod` in `us-west-1`,
and synchronizes the first `FAME_POOL_STATE_INDEXER_BASE_RPCS_JSON` endpoint to
`/society-bots/market-history/base-rpc` as an SSM SecureString. No new GitHub RPC
secret is required. SSM publication is a production mutation performed only by
that deployment job. CI credentials need `ssm:PutParameter` on that path as well
as the existing CDK deployment permissions; this has not been verified by a run.

`deploy/bin/market-history.ts` remains the dedicated CDK app. Local
`yarn cdk --app "yarn history:app" synth` from `deploy/` only prepares a template
after setting the inputs below. Production deployment belongs in CI.

**There is no history HTTP endpoint in this increment.** EventBridge invokes
the collector every five minutes. The proposed later authenticated chart route
is `/fame/history` on the existing API (`https://api.fame.support/fame/history`);
that route is not implemented or deployed. Existing `/fame/pool-state` and
`/fame/pool-quotes` routes serve current state/quotes, not historical charts.
Required deploy inputs:

- `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`.
- `FAME_HISTORY_RPC_PARAMETER`: existing SSM SecureString path holding one HTTPS
  RPC URL. Runtime fetches it with decryption; the URL is not in the CDK template.
  The initial policy assumes the AWS-managed SSM key; a customer-managed key needs
  an explicitly scoped KMS grant before deployment.
- `FAME_HISTORY_START_BLOCK`: reviewed finalized starting block, integer >= 1.
- `FAME_HISTORY_DAILY_REQUESTS`: explicit daily request allowance based on measured
  provider prices and the operator's monthly budget.
- `FAME_HISTORY_POOL_STATE_TABLE`: existing pool-state table for observations.

The dedicated stack immediately schedules collection every five minutes upon
deployment. There is no feature flag. It retains a private/versioned S3 bucket and
on-demand DynamoDB table on removal. A 512 MiB, five-minute Lambda has reserved
concurrency one, bounded invocation work, no automatic Lambda retries, a failure
queue, and passive error/throttle/failure-depth/missed-invocation/coverage-lag
alarms. Successful invocations emit coverage-lag, request-count, and response-byte
metrics; failed collection attempts log bounded request metrics and a fixed error
code, never the provider message. No NAT gateway is created.
Passive alarms do not notify anyone; wire an approved destination if notifications
are required. Never present a synthesized template as deployment evidence.

Before deploying: agree the dollar target, verify provider finalized/range behavior,
cross-check sample event identities, project actual provider/AWS cost, and demonstrate
catch-up rate exceeds new block production. No cost soak has occurred yet.

## Validation

Run focused collector/RPC/storage tests, root `yarn types`, the history CDK tests,
and deploy build. Tests exercise upload/checkpoint crash boundaries, empty ranges,
canonical identity, exact byte preservation, duplicate conflicts, provider failures,
budget limits, busy-range prefixes, and private/retained infrastructure.

An external review must challenge event completeness, allowance accounting, failure
visibility, native runtime assumptions for step 2, and whether the actual measured
budget can sustain the requested scope. Keep its findings and resolutions here.

### Review record, 2026-10-03

Local validation under Node 24.16.0: all 369 root tests passed (36 suites),
including 39 history tests; all three history CDK tests passed, including actual
bundled Lambda import. Root `yarn types`, deploy `yarn build`, and `git diff
--check` passed. CDK tests synthesize the dedicated construct with dummy inputs;
they do not validate an AWS deployment. Live read-only results follow below.
The CI follow-up adds nine passing secret-configuration tests; root `yarn types`
and workflow YAML parsing also pass. The GitHub workflow itself has not run.

Implementation review challenged these assumptions and added regression coverage:

- A new pool/filter revision must not start at the original historical start:
  an active-scope record now rejects that transition atomically.
- A caught-up collector must still detect a conflicting finalized boundary or a
  provider head behind committed coverage; it now fails before reporting success.
- A retry must not replace a raw object: conditional S3 creation verifies the
  existing checksum instead. Mutable liquidity observations can create a new
  candidate object; publication remains conditional and exposes only one.
- Request counts alone do not bound response memory: the transport also caps
  total streamed bytes per run, including discarded oversized responses.
- Passing mocked storage tests does not prove deployed IAM, provider completeness,
  or affordability. These remain explicit live-rehearsal acceptance items.

Independent Grok review is **incomplete**. Three read-only attempts (repository
inspection, self-contained file packet, then three core files in a clean working
directory) returned no review findings before stalling. Each process was stopped
and joined. Startup logs included unrelated MCP authentication failures, but the
cause of the stalled model response was not established. No independent approval
is claimed; rerun that review before production activation.

The user directed discovery of existing GitHub/Doppler credentials. AWS profile,
account, pool-state table, and RPC references are now resolved. The exact monthly
budget, sustained cost/catch-up measurements, deployed ABI/decimal verification,
and independent review remain outstanding. Do not claim full step 1 acceptance
from these bounded samples. The dedicated CDK app also synthesized successfully with
dummy account/table/parameter inputs and lookups disabled; no resources were
created.

### Live read-only rehearsal, 2026-10-03

All runs used the unchanged `yarn nodets scripts/market-history/rehearse.ts` entrypoint
and read existing liquidity rows. They made no S3/DynamoDB/SSM writes and no deployment.

| Source | Inclusive blocks | Events | RPC calls | Response bytes | Compressed candidate |
| --- | --- | ---: | ---: | ---: | ---: |
| Doppler `fls/dev BASE_RPC` | 52140000–52140499 | 0 | 7 | 51,142 | 3,086 bytes |
| Doppler `fls/dev BASE_RPC` | 52135000–52139999 | 0 | 7 | 48,934 | 3,085 bytes |
| Deployed pool-state indexer primary RPC | 52090000–52139999 | 17 | 13 | 151,302 | 5,075 bytes |

The eventful run took 9.74 seconds including TypeScript startup: one `eth_getLogs`,
eleven block-header requests, and one chain-ID request. Seventeen means raw pool
events, not seventeen trades. Two diagnostic log queries against both endpoints
returned the same 17 events, agreeing on emitting address, block identity,
transaction identity/order, log index, topics, data, and removed status. This is
agreement between configured endpoints; independent underlying infrastructure
has not been established.

One diagnostic transaction fetch confirmed nested-call capture: transaction
`0x5c6042102156ea0b3cfaf5703a81671c7ae140048b63922a9fafc1cbe647dbe7`
targets `0x0000000000001ff3684f28c67538d4d072c22734`, while a returned log was emitted
by the tracked SCALE/FAME pool `0xbbf6e67f14ed21884d9e12505a9b979fc42808be`.
This transaction lookup was validation only; ingestion does not fetch transactions.

The initial near-head attempt made two preflight requests and two collector requests,
but scanned no range: preflight reported finalized block 52142739, followed by
52142578 from the same endpoint. The first finalized timestamp was 1,098 seconds
old. Subsequent fixed ranges avoided this head disagreement. A committed cursor
ahead of a regressed finalized head fails closed; an unstarted scope may simply
wait for its configured start. Finalized semantics/lag and sustained throughput
still need monitoring before claiming a five-minute chart freshness bound.

These samples prove the configured RPC accepts combined pool-address queries and
that both empty and eventful dry runs complete. They do not measure monthly bills,
busy-market throughput, decoder correctness, or live S3 publication permissions.

## Source references

- [Uniswap V2 pair](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
- [Slipstream events](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/interfaces/pool/ICLPoolEvents.sol)
- [eth_getLogs address/range semantics](https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs)

These source references are family-level context, not proof of deployed-bytecode
equivalence for every pool.
