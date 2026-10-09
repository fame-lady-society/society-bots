# FAME market history

For dated chart and activity reads beyond the rolling live window, see
[Serving retained FAME history](historical-serving.md).

## Implementation status

The approved plan is `docs/plans/2026-10-03-001-feat-affordable-market-history-plan.md`.
This first increment implements a bounded Base log collector, lossless compressed
S3 batches, atomic DynamoDB manifests/cursors/pending aggregation work, and
periodic capture of existing liquidity state. It has a separate CDK stack entrypoint.
It does not alter the quote poller or notifier. The `Market history` GitHub Actions
workflow deploys the separate `FameMarketHistory` stack; the existing bot stack's
deployment does not deploy this service.

The next local increment verifies captured raw data → native DuckDB → Parquet →
execution candles → a bounded authenticated loopback HTTP response. A fresh
Parquet-only rebuild produces identical results. CI now runs this proof both on
the runner and in the Lambda Node 24 Linux image.

The cloud worker and atomic publication path are now implemented and packaged in
the dedicated stack. Neither collector nor worker has been deployed. The candle
API, measured production cost, and historical backfill remain unfinished.

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
   event-heavy responses also yield only at whole-block boundaries. If response
   bytes or other invocation resources leave no verifiable prefix, save a halved
   scan-window hint for the unchanged cursor and retry on the next scheduled run.
   The hint expires logically when coverage advances. A single block that exceeds
   capacity fails visibly without skipping it; an operator must adjust sizing.
6. **S3 and DynamoDB are not one transaction.** Objects are uploaded and SHA-256/
   length-verified first. One DynamoDB transaction conditionally publishes the
   active scope, manifest, next cursor, and pending work. Conditional S3 creation
   prevents replacing an existing content-addressed object. Failed publication
   can leave unreferenced objects; readers must enumerate committed manifests,
   not bucket contents. A later retry may capture a newer liquidity observation
   and therefore create a different object; only the winning manifest is visible.
7. **Cost awareness never gates collection.** There is no daily request ledger or
   daily/monthly cutoff. Each attempt records request counts by method, response
   bytes, progress, yields, and failures in ordinary structured diagnostic logs;
   viem retries are disabled. These are best-effort records, not a billing ledger:
   hard termination can lose final logs. No custom CloudWatch metrics, dashboards,
   or alarms are provisioned. Monitoring is deferred to Overclaw; no integration
   is added here. Efficiency comes from filtered block-range batches, fetching
   only necessary headers, committing complete prefixes, and resuming at durable
   checkpoints. Compare request counts with provider usage when investigating cost.
8. **No ABI assumptions are required to retain raw logs.** Canonical V2 and
   Slipstream sources support the planned decoder families, but per-deployment
   ABI verification is still needed before production normalized candles. The
   local fixture pins on-chain token order and decimals at a recorded block/hash;
   its decoder is explicitly provisional.
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

Historical creation blocks are deliberately not guessed. Token decimals are
queried at a pinned block for local analysis, never assumed from token symbols.
The first deployment automatically records a finalized Base block as the live
start. Later deployments reuse it; earlier history remains missing until backfill.

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
  It includes both compressed-object SHA-256 and uncompressed-content SHA-256.
  The latter permits durable rebuild verification without requiring a future
  gzip implementation to produce byte-identical compressed output. This is a
  predeployment format tightening; no legacy manifest fallback is provided.
- Pending aggregation: `pk=work:<digest>, sk=range:<16-digit-start>`; the worker
  marks it `done` in the same transaction that publishes candles and progress.
- Aggregation progress/lease: `pk=scope:<digest>, sk=aggregation`. The cursor is
  independent of collection. A random owner and three-minute lease fence writes.
- Five-minute candles: `pk=candles:<scope>:<pool-id>:300`, timestamp padded to
  16 digits in `sk`. Records include source revision, metadata revision, and
  through-block; volume is replaced, never incremented.
- Canonical derived partitions: `pk=partitions:<scope>, sk=range:<16-digit-start>`.
  Only references from these committed records are visible. Objects under
  `derived/<scope>/<from>-<to>/<sha256>/` are immutable Parquet/evidence objects.
  Listing that prefix alone also finds orphan candidates and is not a dataset.
- Adaptive scan window: `pk=scope:<digest>, sk=scan-window`, with `nextBlock` and
  `maxBlocks`. This scheduling hint never changes coverage. Concurrent writes
  cannot replace a newer cursor's hint or enlarge its retry window. A hint for an
  already committed cursor is ignored. Manifests/cursors/archive do not expire.

A failed run never commits a partially scanned range. Check the last committed
cursor, scan window, lag, and failure logs before retrying. A changed committed block hash requires
operator investigation and a canonical repair procedure; do not reset the cursor
or advance it past the problem. Even a caught-up invocation rejects a conflicting
finalized boundary or a finalized head behind committed coverage.
Automated replacement/repair tooling belongs to
the backfill/rebuild increment and must be finished before exposing candle history.

## Configuration and bounded rehearsal

Production runtime requires `FAME_HISTORY_RPC_URL` (HTTPS, do not print),
`FAME_HISTORY_TABLE`, `FAME_HISTORY_BUCKET`, `FAME_HISTORY_POOL_STATE_TABLE`,
and `FAME_HISTORY_START_BLOCK`. Rehearsal requires
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
It never writes S3, manifests, cursors, or scan-window hints. A capacity yield
reports the smaller recommended range for a subsequent rehearsal. It reports request
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
`main` without a starting-block input. Immediately before initial deployment, CI
reads Base's finalized head and saves its block number, hash, timestamp and selection
time in the standard SSM parameter `/society-bots/market-history/start` using a
create-only write. The marker remains outside the stack and is reused after failed
deployments, retries, updates and stack replacement. Concurrent initializers use
the first successful marker. Access errors or malformed records fail rather than
choosing a replacement. Retain this parameter with the archive; deleting it is not
a supported reset or backfill mechanism. CI needs GetParameter/PutParameter on
this exact path as well as the existing RPC parameter. The chosen boundary is
printed in the Actions summary and exported by CloudFormation as `StartBlock`.
Selection happens at deployment startup, so blocks produced while infrastructure
is being created are included when the collector starts.
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

**There is no deployed history HTTP endpoint.** EventBridge invokes
the collector every five minutes. The proposed later authenticated chart route
is `/fame/history` on the existing API (`https://api.fame.support/fame/history`);
production integration for that route is not implemented or deployed. The local
proof serves the same path on an ephemeral loopback port using a random test
bearer token, then shuts down. Existing `/fame/pool-state` and
`/fame/pool-quotes` routes serve current state/quotes, not historical charts.
Required deploy inputs:

- `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION`.
- `FAME_HISTORY_RPC_PARAMETER`: existing SSM SecureString path holding one HTTPS
  RPC URL. Runtime fetches it with decryption; the URL is not in the CDK template.
  The initial policy assumes the AWS-managed SSM key; a customer-managed key needs
  an explicitly scoped KMS grant before deployment.
- `FAME_HISTORY_START_BLOCK`: injected by CI from the durable initial marker,
  integer >= 1. Local rehearsals still supply their own explicit block.
- `FAME_HISTORY_POOL_STATE_TABLE`: existing pool-state table for observations.

The dedicated stack immediately schedules collection every five minutes and
aggregation every minute upon deployment. There is no feature flag. It retains a private/versioned S3 bucket and
on-demand DynamoDB table on removal. A 512 MiB, five-minute Lambda has reserved
concurrency one, bounded invocation work, no automatic Lambda retries, and a failure
queue. Completed collection results log request counts by method, response bytes,
coverage lag, progress, and yields. Failures log request counts and a fixed code,
never provider messages. These are ordinary JSON logs with seven-day retention,
not embedded metric records. No CloudWatch alarms, dashboard, custom metrics, or
metric filters are created. Standard AWS service metrics remain available.
No NAT gateway is created.
The separate x86-64 container aggregator has 512 MiB, a two-minute timeout,
reserved concurrency one, no automatic retries, and the shared failure queue.
It logs outcomes and lag, reads raw objects, and writes verified
derived objects and DynamoDB records; it has no RPC secret or pool-state access.
Both functions are enabled by the same explicit CI deployment.
Monitoring and notifications are deferred to Overclaw. No new monitor, schedule,
or integration is included. Never present a synthesized template as deployment evidence.

Before deploying: verify provider finalized/range behavior,
cross-check sample event identities, project actual provider/AWS cost, and demonstrate
catch-up rate exceeds new block production. No cost soak has occurred yet.

## Validation

Run focused collector/RPC/storage tests, root `yarn types`, the history CDK tests,
and deploy build. Tests exercise upload/checkpoint crash boundaries, empty ranges,
canonical identity, exact byte preservation, duplicate conflicts, provider failures,
invocation resource bounds, busy-range prefixes, and private/retained infrastructure.

An external review must challenge event completeness, request efficiency, failure
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
account, pool-state table, and RPC references are now resolved. Sustained
cost/catch-up measurements and deployed ABI verification remain outstanding.
The review follow-up below records the later independent reviews. Do not claim full step 1 acceptance
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

### Local analytics and Linux runtime proof, 2026-10-03

The committed fixture is `src/fame-market-history/fixtures/base-52090000-52139999`.
An explicit capture against the deployed indexer's primary RPC retained 17 raw
logs, headers, and existing liquidity observations locally. It also queried each
pool's token order and each unique token's decimals at block 52090000, checking
the anchor before and after. This capture used 30 RPC calls, 192,291 response
bytes, and 10.79 seconds including TypeScript startup. It made no AWS writes.
The fixture README records provenance and limitations.

From the repository root, Node 24 with installed dependencies:

```sh
yarn nodets scripts/market-history/e2e.ts \
  src/fame-market-history/fixtures/base-52090000-52139999 \
  /tmp/fame-history-proof
```

Choose a new output directory each time. The command verifies manifest checksums,
decodes events, writes actual ZSTD Parquet, compares every stored column exactly,
and runs the same `CANDLE_SQL` on raw and Parquet inputs. It then rebuilds in a
fresh DuckDB instance using only `events.parquet` and `evidence.json`, verifies
the original raw-content checksums, re-decodes raw payloads, and compares the
whole dataset. Finally it checks HTTP 401 without authentication, 400 for an
oversized request, 404 for POST, and an exact 200 response for a trade candle.
It writes `history.json`, `evidence.json`, `events.parquet`, and `api-example.json`;
the sibling `-rebuilt` directory holds the independent rebuild. It needs no
RPC, AWS credentials, or network other than local loopback.

To capture a different bounded sample, supply the same explicit environment as
the read-only rehearsal and use `yarn nodets scripts/market-history/capture-sample.ts
/tmp/new-history-sample`. This command consumes RPC quota and reads existing
liquidity state but writes evidence only to the new local directory. It uses the
configured initial block, not an existing history cursor. It adds token metadata
calls to the same request/deadline allowance. A partial local capture is not a
publishable dataset; `e2e.ts` requires all files and validates their checksums.

Native Lambda Linux proof (no application credentials enter this build context):

```sh
yarn nodets scripts/market-history/prepare-container.ts /tmp/history-container
docker build --platform linux/amd64 -t history-runtime-proof /tmp/history-container
docker run --rm --platform linux/amd64 --network none --memory 512m --cpus 1 \
  --read-only --tmpfs /tmp:rw,size=256m history-runtime-proof
```

The tested Node 24 base image resolved to
`sha256:b5f6c6f20c76dd64924c4d09b1e3eadd91ea59eb3279d63eb99bc9102c61f58f`.
DuckDB Node API is pinned to `1.5.6-r.1` in both application and minimal image
lockfiles. The successful local Linux run produced 5 trades, 0 unknown events,
0 rejected trades, and 6,047 Parquet bytes from 17 raw logs. It completed the
aggregation/rebuild/HTTP checks in 793 ms and reported 245,555,200 RSS bytes at
completion. This is one small fixture run under Docker, not a Lambda cold-start,
peak-memory, busy-window, throughput, or billing measurement. DuckDB uses one
thread, a 128 MB engine memory limit, bounded spill, and disabled extension
autoload/install; the container provides the process-wide memory cap.

Semantics and deliberately bounded scope:

- Prices are quote-token units per FAME, rounded down to 18 decimal places.
  Trade amounts and summed volumes remain exact integer strings; DuckDB sums
  them using `BIGNUM`, including sums larger than uint256. Price intermediates
  use JS bigint and fit checked `DECIMAL(38,0)` bounds. Underflow, overflow,
  zero/same-sign swaps, and ambiguous multi-leg V2 swaps are rejected trades.
- Known signatures require exact static ABI layouts. Unknown signatures remain
  raw and make their bucket partial; malformed known events fail the job before
  publication. V2/Solidly have live examples; Slipstream has synthetic coverage
  but has not been exercised by a live trade in this fixture. Family-source
  ABIs are provisional pending per-deployment review.
- Five-minute, hourly, and daily candles currently aggregate directly from the
  same raw events with the same SQL. There is no separate rollup materializer.
  Ordering uses block number, transaction index, and log index. A complete quiet
  candle has null OHLC and zero volume; missing and partial coverage are explicit.
  Boundary timestamps are conservatively excluded from complete coverage.
- Jobs accept at most eight archives and 10,000 total events, with at most
  10,000 five-minute pool points across the requested span. Duplicate batches
  are deduplicated; overlaps and inconsistent adjacent ranges fail. HTTP reads
  at most 1,000 precomputed points and never starts ingestion.
- Existing liquidity observations retain their original observed block and
  unverified-finality label; identical observations are deduplicated. They are
  preserved alongside events, not reconstructed into historical TVL or assigned
  the trade range's timestamps.

Review added regression cases for gzip-version independence, exact uint256 sums,
reversed token orientation, price precision bounds, malformed ABI layouts,
metadata anchor conflicts, tampered Parquet, gaps, unknown events, ambiguous
swaps, and conservative coverage. A fourth bounded Grok review attempt for this
increment returned no findings before its three-minute timeout; the process was
stopped and joined. Independent review remains incomplete.

Final local checks for this increment: all 389 root tests in 38 suites passed,
including 11 analytics tests; all three history CDK tests passed, including the
real collector bundle import. Root type checking, deploy build, workflow YAML
parsing, and whitespace checks passed. CI itself has not run. The existing
collector bundle remains independent of the native analytics runtime.

Remaining work before production history can be offered: production API/auth
integration; serving retention and rollup materialization; busy-window and
deployed cost tests; deployed ABI verification; and resumable historical
backfill/repair tooling. The next section records the worker/publication milestone.

### Cloud worker and atomic publication milestone, 2026-10-03

`worker.ts` consumes one sequential committed range per invocation. It loads
earlier adjacent archives until it can recompute the first affected five-minute
bucket without dropping earlier trades. It uses the existing verified DuckDB
pipeline; missing context, overlapping inputs, unexpected hashes, and excessive
work fail without advancing progress. Only affected five-minute candles publish.
Hourly/daily materialization is deferred; the local analytical core still supports
those resolutions, but the cloud worker does not publish incomplete replacements
for larger buckets.

The canonical Parquet partition contains events from the target range only.
Earlier context affects candle computation but is never duplicated into that
partition. The evidence sidecar preserves raw range checksums and source
liquidity observations for a later rebuild. Objects upload with conditional
creation and SHA-256 verification. A single DynamoDB transaction then checks the
active scope, target manifest checksum, lease owner/expiry, expected aggregation
cursor, pinned decoder/metadata revision, and pending work identity. That same
transaction publishes every affected candle, the partition references, completed
work status, and next cursor. Publication is all-or-nothing. The future API must
still choose suitable read consistency: multiple reads spanning a concurrent
commit are not automatically a snapshot merely because the writer is atomic.

The bounded live worker allows eight input archives, 10,000 combined events, and
90 affected pool/candle records per transaction (95 total operations). The default
500-block collector range is intended to fit this limit. A larger custom range
or extremely fragmented input can fail this limit: it does not silently split,
skip, or label incomplete data as complete. Sustained busy-window sizing remains
an acceptance item. There is no automatic canonical repair or metadata migration;
a decoder/metadata change stops with a rebuild requirement. No compatibility
path for earlier experimental formats has been added.

Token order/decimals are pinned in `src/fame-market-history/token-metadata.json`,
with the on-chain anchor/provisional-review provenance from the captured sample.
Assumption: these deployed tokens' decimals and pool token identities remain
stable. A registry mismatch fails validation. The worker does not spend RPC calls
rechecking them on every run. Before changing a deployment's metadata, review the
contracts and implement the corresponding explicit rebuild. Do not present the
provisional family decoder as verified for every deployed contract.

Failure behavior:

- Crash before publication: uploaded candidates remain unreferenced, pending
  work remains pending, and the next worker retries after the lease expires.
- Transaction succeeds but the response is lost: the next invocation reads the
  advanced checkpoint and cannot duplicate the completed range's volume.
- Expired or replaced worker: conditional publication rejects its entire write.
- Collector commits while the worker reads pending work: a DynamoDB transactional
  read obtains work, cursor, and manifest together, avoiding a false missing-work
  error caused by independently timed reads.
- No pending range: release the lease and return caught-up. Polling uses bounded
  key reads, never a DynamoDB scan. Publication retains work records as evidence.

Reproduce the actual transaction rehearsal using a disposable local database:

```sh
# Terminal 1, foreground; stop with Ctrl-C after the rehearsal.
docker run --rm -p 127.0.0.1:18001:8000 \
  amazon/dynamodb-local@sha256:ff89bd48ff32cd8d9be5fee8873b65b8854dc408f1afe881be6eb00247bc0dab \
  -jar DynamoDBLocal.jar -inMemory -sharedDb

# Terminal 2, repository root.
yarn nodets scripts/market-history/worker-rehearse.ts
```

This uses real DynamoDB Local transactions and native DuckDB, with an in-memory
S3 adapter. It requires a loopback endpoint, supplies dummy credentials, creates
one uniquely named table, and deletes it afterward. It verifies interrupted
publication, stale-owner rejection, lost-response recovery, exact cross-range
volume, and nonoverlapping Parquet partitions. It does not test AWS IAM or real
S3 durability. CI runs this rehearsal using the pinned database image.

The container now has a production `runtime` stage with `index.handler` and a
separate `proof` stage. The proof imports the actual worker bundle/metadata before
running the existing offline event-to-HTTP fixture. The Linux run passed within
512 MiB (883 ms for the fixture pipeline; 252,727,296 RSS bytes at completion).
This remains a small local fixture measurement, not a deployed Lambda cost test.

Local checks: 398 root tests, root type checking, three history CDK tests including
collector bundle import and worker infrastructure, deploy build, and the actual
DynamoDB Local rehearsal passed. A fifth bounded Grok attempt returned no findings
before its three-minute timeout and was stopped/joined; independent review remains
outstanding. CI/deployment status is separate from these local results.

Activation follows review/merge and the existing manual CI dispatch. Choose a
recent finalized start for live collection; backfill is deferred. Inspect the
diagnostic logs and observed provider usage after dispatch. After deploy,
verify collector `archived` and worker `published` logs, aggregation progress
catching the collector cursor, committed partition checksums, and candle coverage.
Both Lambda names, bucket, and table are stack outputs. A public history endpoint
is still a separate next increment.

## Operational-awareness review follow-up (2026-10-04)

The operator chose soft cost awareness with no spending cutoff. Removed the daily
DynamoDB reservation and required daily-limit deployment input. Invocation bounds
remain resource controls: completed prefixes commit and subsequent schedules resume.
The repeated-invocation tests cover provider range rejection, 6,000 events exceeding
one job's event capacity, and a streamed response exceeding 4 MiB. They assert
eventual progress and exact event identities with no gaps or duplicates; a failed
oversized first attempt saves a smaller window without claiming coverage.

Independent consistency, simplification, security, and adversarial reviews found
two collector progress stalls and a candle-completion bug. The collector now retains
verified prefixes when request/event capacity is reached and persists a smaller
window if response bytes prevent any prefix from being verified. The worker rebuilds
the preceding range's final candle and intervening empty buckets when new coverage
arrives, including an exact five-minute boundary or timestamp gap. Regression tests
compare all published candles with a full rebuild using the same SQL.

These are local/synthetic checks. They do not establish deployed throughput,
provider completeness, billing accuracy, or AWS permissions. A single block that
cannot fit configured resource limits still requires operator intervention; it is
reported as failure rather than skipped. A timestamp gap requiring more than 90
candle writes also needs explicit operator reconciliation because the current
publication is atomic; reducing a collector range cannot repair a gap between
adjacent blocks. Tests verify no progress or candles change in that case.
No automatic budget shutdown exists.

Final local validation: 410 root tests, root type checking, three history CDK
tests, and deploy build passed. DynamoDB Local verified actual scan-window
conditions (narrower wins, stale writes cannot enlarge/replace it, and advancing
coverage ignores the old hint), plus existing worker crash/lease recovery.
The offline Lambda Linux proof passed under 512 MiB: 17 events, five trades,
matching Parquet-only rebuild and HTTP 200 (842 ms, 251,224,064 RSS bytes).
Security, adversarial, and simplification follow-up reviews found no remaining
blocker in these changes. No deployment or production writes were performed.

The operator subsequently clarified that the requirement is efficient algorithms
and batching, with monitoring eventually handled by Overclaw. Removed all ten
CloudWatch alarms, the dashboard, and the twelve custom metric series/EMF emitter.
Ordinary structured logs, existing checkpoints, and the failure queue retain
diagnostic evidence. Log ingestion/storage still has normal usage-based costs;
this change adds no dedicated paid monitoring resources. The collector batching,
adaptive range recovery, and candle-boundary fixes remain intact.
Validation after removal: all 78 history/script tests, root type checking, three
history CDK tests, and deploy build passed. The CDK checks explicitly assert zero
alarms, dashboards, and metric filters.

## Market API implementation (2026-10-05; not deployed)

The service now materializes a market partition alongside the five pool partitions.
`GET /fame/history?view=market&resolution=300&from=<unix-seconds>&to=<unix-seconds>`
returns native quote groups, combined FAME execution volume, ETH and USD OHLC/VWAP,
and valued liquidity. Use `view=pool&pool=<registry-id>` for native pool candles.
Both endpoints require the existing pool-state service bearer credential. The
website server should keep that credential private; it is not a browser token.

Ranges are aligned, half-open `[from,to)`, five-minute buckets, at most 288 buckets
(24 hours). Unknown or duplicate parameters and future ranges beyond the current
bucket fail before storage reads. Responses use `Cache-Control: private, no-store`.
Published zero-trade buckets have zero volume and null OHLC. Unpublished buckets
have null values and an explicit reason. Missing rows inside published coverage
fail with 503 instead of silently inventing empty candles. The reader captures
progress, queries one partition, then rechecks publication; it retries once on a
concurrent publish, with a seven-second read deadline and two-page/two-MiB limits.

ETH/USD and connector observations are archived at each finalized range boundary
using two batched Multicalls per range, independent of trade count. An execution
uses only a prior-block observation no older than 30 minutes. Chainlink's Base
ETH/USD standard proxy supplies the USD anchor; no stablecoin peg is assumed.
Prices use observed pool spots, with explicit priced/unpriced FAME denominators.
Gross volume counts each pool execution, including arbitrage across two pools.
Do not interpret this as unique user flow. Connector spots can be manipulated in
thin pools and are not executable quotes; their snapshot age is not the age of
the pool's last trade. Zero active CL liquidity makes that connector unavailable.

Liquidity uses actual token balances at each pool contract, valued at that pool's
FAME spot and independent quote routes. It includes custody balances such as fees
and donations, and is not active trading depth. Missing/stale pools yield explicit
partial subtotals. These are sampled balance/FX observations even where swap event
coverage is complete. No future observation is used to fill an earlier trade.
Raw snapshots (including oracle rounds and timestamps) survive Parquet rebuilds.

Deployment order: merge/release the bot-stack API/authorizer outputs first, then
manually dispatch **Market history** on main; CI selects or reuses the start marker.
CI discovers `HistoryApiId` and `HistoryAuthorizerId` from `Bot-prod`, verifies
the existing `$default` stage auto-deploys, and creates the authenticated route in
`FameMarketHistory`. It adds no new service credential, default stage, dashboard,
alarm, custom metric, or cost cutoff. API requests never invoke RPC, S3 or DuckDB.

Verification commands:

```sh
yarn test --runInBand src/fame-market-history scripts/market-history
yarn types
# Temporary DynamoDB Local on 127.0.0.1:18001; no AWS writes:
yarn nodets scripts/market-history/worker-rehearse.ts
# Raw and Parquet-only equivalence, including market output:
yarn nodets scripts/market-history/e2e.ts src/fame-market-history/fixtures/base-52090000-52139999 /tmp/new-history-proof
# Optional bounded read-only RPC source check, using local configured RPC:
yarn nodets scripts/market-history/valuation-rehearse.ts
```

The worker rehearsal now serves the production parser/reader through a loopback
HTTP adapter and exercises the entire 288-bucket market response. Its synthetic
valued dataset used two DynamoDB pages and approximately 1.34 MB. The source
rehearsal verified all quote routes and balance reads at Base block 52,233,578 in
four RPC requests (59,930 response bytes). Neither proves production IAM,
gateway authentication, billing, or historical RPC state availability.

Final local validation passed 112 history/script tests, 26 history/pool-state CDK
tests, root type checking and deploy build. The offline Linux/amd64 Lambda image
also passed its raw/Parquet rebuild proof with no network and a 512 MiB limit.
Publication revisions fingerprint both connector and direct-pool valuation
configuration; conflicting archived source configurations require explicit
reconciliation rather than being published under a new label. `publishedAt` is
Unix milliseconds; query ranges and coverage timestamps are Unix seconds.

## Source references

- [Uniswap V2 pair](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
- [Slipstream events](https://github.com/aerodrome-finance/slipstream/blob/main/contracts/core/interfaces/pool/ICLPoolEvents.sol)
- [eth_getLogs address/range semantics](https://www.alchemy.com/docs/chains/ethereum/ethereum-api-endpoints/eth-get-logs)
- [Chainlink historical observations](https://docs.chain.link/data-feeds/historical-data)
- [Base ETH/USD feed](https://data.chain.link/feeds/base/mainnet/eth-usd)
- [Chainlink Base feed directory](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json)
- [DynamoDB transactional IAM](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)

These source references are family-level context, not proof of deployed-bytecode
equivalence for every pool.


## Five-minute reference prices

The market view always includes independent finalized reference points for FAME/ETH,
ETH/USD, ETH/USDC, FAME/USD and FAME/USDC. See the [consumer contract](handoffs/2026-10-07-fls-www-market-chart.md#bucket-reference-prices-implemented-pending-backend-deployment)
and [implementation receipt](plans/2026-10-07-001-feat-market-reference-prices-plan.md#implementation-receipt-2026-10-07).

The first collector invocation persists its own activation bucket in
`reference:<scope>/collected`; publication advances `reference:<scope>/published`.
Both run independently of trade history, process at most four buckets per invocation,
and resume after failures. Old buckets are explicitly unavailable. There is no
automatic historical refill. Source-policy changes require an explicit reviewed
rebuild design; editing the policy does not silently rewrite existing prices.

Archives use `raw/reference/<scope>/...` and `derived/reference/<scope>/...` in the
existing bucket. Structured log events `fame-reference-collection` and
`fame-reference-publication` report results, lag and sanitized failure codes;
collection also reports request counts by method and response bytes. The API reads
DynamoDB only. Existing bearer authentication, 288-bucket range, and 2 MiB response
limits apply.

Read-only source qualification using the existing RPC parameter (no AWS writes):

```sh
AWS_PROFILE=fls-power AWS_REGION=us-west-1 \
  yarn nodets scripts/market-history/reference-probe.ts
```

The command suppresses credential/provider errors and never prints the RPC URL.
It compares designated reference sources with all tracked FAME pools at one pinned
block. Provider billing must be checked separately. Existing CI also runs the
reference transaction/API rehearsal and offline Linux Parquet proof.

### Bucket-end reference refill

`refill-references.ts` fills backward from the immutable live reference activation,
using the same pinned historical Multicall sampler and as-of Chainlink round as
live collection. It does not approximate historical prices from today's reserves,
interpolate, carry a trade close forward, or assume USDC equals USD.

```sh
# Freeze an aligned --from timestamp once; repeat the exact command to resume.
AWS_PROFILE=fls-power yarn nodets scripts/market-history/refill-references.ts \
  --from 1791328800 --max-buckets 12
# Add --apply to execute. Maximum 288 buckets per run and 24 hours before activation.
```

The command checks the production AWS account and discovers the existing stack's
resources. It reads the RPC parameter in memory without logging its value.
Its `reference:<scope>/refill` record stores the frozen target, live join timestamp,
canonical anchor and backward publication frontier. Each bucket uploads immutable
raw evidence and round-trip-verified Parquet, then atomically inserts the reference
manifest/serving row and advances only that frontier. Live collection/publication
cursors, execution candles, and execution volume are untouched. A concurrent writer
loses the conditional transaction; an ambiguous successful response resumes from
persisted progress. Completed buckets are never overwritten.

A failed/reverted source or stale oracle produces explicit unavailable values.
Transport failures retry three times and then stop without consuming the bucket;
an RPC outage is not evidence that a historical price is unavailable. Malformed
ABI results, chain disagreement, work limits and archive failures stop for operator
investigation/resumption. Header bracketing/search is cached; all source calls for
a bucket share one pinned Multicall. The run is sequential with bounded request,
response-byte and time allowances. These do not change live collection limits.

The market reader combines the independently published backward interval with
live reference publication. It checks both frontiers before/after reading and
retries if either changes. `referenceProgress.startTimestamp` reflects the earliest
published reference bucket; its forward publication timestamp/revision retains the
existing meaning. Buckets outside published coverage remain explicitly unavailable.
No-trade buckets may have reference prices while their execution OHLC stays null
and volume stays zero. No frontend change is required.

Validation includes backward resume, source gaps, outage/integrity stopping,
concurrent API snapshot changes, and real DynamoDB Local transactions with competing
writers and a lost successful response. The same rehearsal round-trips native DuckDB
Parquet and proves both live cursors remain unchanged.
