# AWS candidate backfill and same-scope continuation

The first milestone collected `[2024-07-13 00:00, 2024-08-12 00:00)` UTC, starting with
Base launch block 17,019,741. It contains only Uniswap V2 and V3 FAME/WETH. The
reviewed WETH/USDC pool supplies bucket-end conversion samples. The other current
FAME pools launched later; cbBTC/SPX remain excluded until a separately planned
chunk. There is no production dataset promotion operation in this implementation.

## Reviewed continuation jobs

The first three immutable jobs retain the same scope:

| Job | UTC interval (end exclusive) |
| --- | --- |
| `launch-30d-v1` | July 13–August 12, 2024 |
| `august-30d-v1` | August 12–September 11, 2024 |
| `september-30d-v1` | September 11–October 11, 2024 |

These three use the same two pools, dataset, conversion policy and metadata.
The fourth job, October 11–November 10, adds a dated four-pool definition while retaining earlier pages in place; see
[October candidate admission](2026-10-11-october-candidate-admission.md). The original job key/specification
and completed receipt are preserved; no migration or progress reset is needed.

`november-30d-v1` continues November 10–December 10, 2024 (UTC, end exclusive)
with the same four pools, including SPX and cbBTC. It retains October's scope,
policy, dataset definition, October 11 sample start and capture-start block.
Only its ending boundary advances. It does not replay older archives, create a
new dataset definition or switch a reader pointer. The prior four job hashes
remain unchanged.

After operator merge and **History candidate** deployment, verify the deployed
revision and explicitly start `november-30d-v1` using the control command below.
November start requires October's completed receipt and aligned checkpoints.
Its initialization also verifies the original dataset boundary against October.
Production remains on its existing dataset.

The [October verification receipt](2026-10-12-october-candidate-verification.json)
records all 30 daily chart responses in each currency: 8,640 priced market
buckets per currency, plus all post-creation SPX/cbBTC pool buckets. Activity
pagination was sampled at the beginning, middle and end, rather than exhaustively
reconciled against chain logs.

The worker selects the earliest incomplete reviewed job. Missing or paused jobs
stop selection, so deployment/completion never automatically queues another
month. Starting a successor transactionally requires its predecessor to be
complete and unleased, the expected active candidate scope, raw and Parquet at
the predecessor's end block plus one, and collected/published samples at the
new interval start. Misaligned checkpoints fail with an actionable error.
Existing starts are idempotent and do not resume paused jobs.

Raw capture includes the first block at/after an interval's exclusive time end.
Continuation starts at the following block, retaining any edge-block events for
the new bucket. The global sample start and previous bucket observation remain
unchanged. Publication continues with the existing generation chain and dated
pages; no serving-policy switch or old-page rewrite is involved. Work remains
bounded per invocation/range, not per month in memory.

After the continuation PR is merged, the operator runs **History candidate** on
`main`. Verify deployment before starting the next job:

```sh
yarn nodets scripts/market-history/candidate-control.ts status fls-power august-30d-v1
yarn nodets scripts/market-history/candidate-control.ts start fls-power august-30d-v1
yarn nodets scripts/market-history/candidate-control.ts pause fls-power august-30d-v1
yarn nodets scripts/market-history/candidate-control.ts resume fls-power august-30d-v1
```

Once August is complete and its API seams are verified, explicitly start
`september-30d-v1` with the same command. Starting September before August completes
is rejected. Commands without a job argument still target `launch-30d-v1`;
`query` continues to read the shared candidate dataset. Status includes the
selected job's receipt/counters and the dataset's current four checkpoints, which
can advance beyond an older completed job. Usage counters are per job.

Before extending the deployed corpus, reconcile the first month's full dated
coverage and known gaps against the retained evidence. After each continuation,
verify both currencies across midnight/chunk seams, old and new chart reads,
activity identity/counts (including the retained edge block), and quiet prices.
The same candidate-only IAM/storage boundaries remain in force. Do not change
the production active pointer or run the production Market history deployment.

## Isolation and execution

`FameHistoryCandidate` is a separate CloudFormation stack with its own retained,
private, versioned S3 bucket and on-demand DynamoDB table. Worker IAM references
only these candidate resources and the existing RPC SecureString. The existing
production history stack, API route, active pointer and live cursors are untouched.
A read-only candidate Lambda uses the same API handler, accessible by IAM
invocation only; it has no public route or function URL.

Deployment creates infrastructure, **not a running job**. The scheduled worker
checks the job first; absent, paused, complete or leased jobs make no SSM/RPC calls.
An explicit start creates the frozen chunk specification. Repeating start is
idempotent and never resets or resumes an existing paused job.

The worker pipelines bounded checkpoints:

1. Capture up to 2,000 blocks / 5,000 events using the existing adaptive log scanner.
   Immutable S3 upload/checksum verification precedes the atomic raw cursor commit.
2. Reuse the existing bounded aggregator to derive native records and canonical
   Parquet partitions. It reads at most eight context archives, never a whole month.
3. Capture actual historical pool state at verified five-minute boundaries, then
   publish chart pages and activity indexes through the existing transactional
   publisher. Dated pages remain available after the rolling window advances.
4. Repeat until raw, Parquet, samples and publication all reach the frozen target.
   Gaps remain explicit under the existing sampled-price policy.

Each invocation handles at most 256 steps, 2,000 RPC requests, 64 MiB response
bytes, and a bounded time window inside the five-minute Lambda timeout. Requests
are sequential with a 100 ms minimum spacing. Capacity exhaustion yields to the
next five-minute schedule; there is no daily budget cutoff. A step is a raw range,
Parquet range, sample, or publication, so roughly 128 quiet buckets is the upper
bound per invocation before raw/Parquet work. Expect hours for this trial, not the
local runner's continuous execution speed; measure AWS throughput before promising
launch-to-present completion times.

A six-minute job lease exceeds the worker's five-minute hard timeout, and reserved
concurrency is one. A timed-out process cannot overlap its replacement. Raw,
Parquet, sample and publication cursors remain independent. A saved sample with
pending publication is published before another sample is fetched. Explicit pause
stops after the current checkpoint; inspect `leaseActive` before treating it as
quiescent. A forced timeout may delay retry until a later schedule tick.

Token metadata is frozen in the candidate dataset definition, rather than loaded
from a newer deployment on resume. Scope, route policy, decoder version and chunk
boundaries are checked. Unexpected changes fail visibly and retain checkpoints.

## Operator deployment and controls

Merge the dependency chain and this PR, then run the **History candidate** GitHub
Actions workflow on `main`. It deploys only `FameHistoryCandidate`. Do not run the
production **Market history** workflow for this milestone. Merge and deployment
remain operator actions. No cloud backfill has run merely because local checks pass.

After deployment, use the explicit account-checked control script with the AWS
profile. It resolves resources from the dedicated stack; it accepts no arbitrary
table or bucket override and uses the selected profile's exported credentials.

```sh
yarn nodets scripts/market-history/candidate-control.ts status fls-power
yarn nodets scripts/market-history/candidate-control.ts start fls-power
yarn nodets scripts/market-history/candidate-control.ts pause fls-power
yarn nodets scripts/market-history/candidate-control.ts resume fls-power
```

Status reports separate raw/Parquet block cursors and sampled/published timestamps,
lease activity, the last outcome and observed RPC counts/bytes. These counters are
not provider billing units; a hard process kill can leave its final usage unrecorded.
Per-invocation structured logs include a run ID, fixed error code and method counts.
No service-specific paid alarms, dashboards, or custom metrics are added. Errors
leave progress intact and retry on later invocations; persistent errors need operator
inspection. Pause the job while repairing a deterministic fault.

Query the private candidate reader without switching the public chart:

```sh
yarn nodets scripts/market-history/candidate-control.ts query fls-power 'view=availability&before=1720828800'
yarn nodets scripts/market-history/candidate-control.ts query fls-power 'view=chart&series=market&currency=USDC&resolution=300&from=1720828800&to=1720915200'
yarn nodets scripts/market-history/candidate-control.ts query fls-power 'view=activity&currency=ETH&resolution=300&from=1720828800&to=1720915200&limit=100'
```

Queries return the Lambda HTTP-response envelope. Activity may require multiple
`nextCursor` requests, including empty pages while scanning quiet buckets. Verify
both currencies, first/last day, midnight joins and selected interior days. Compare
the first seven days against the retained local trial, including its initial price
gaps. Do not treat `completed` alone as approval to promote production.

## Validation and remaining proof

Local verification uses `candidate-rehearse.ts`: real DynamoDB Local transactions,
real DuckDB/Parquet, deterministic chain fixtures and an in-memory S3 adapter. It
runs five bounded invocations through 297 sampled buckets, then verifies older
chart/activity reads in ETH and USDC after rolling-window eviction. It exercises
idempotent start, pause/resume, competing owners, expired leases, stale-owner
rejection, a lost S3 upload response, and earliest-history navigation. This is
storage-protocol proof, not AWS IAM, real S3 transport, or a 30-day historical capture.
The earlier seven-day trial supplies actual historical-chain evidence.

Implementation checks passed: root TypeScript, 244 history/operator tests,
deployment TypeScript, and five CDK tests including candidate IAM isolation.
The final Linux image imported the candidate handler and ran native DuckDB with
networking disabled. The final local rehearsal also rejected a changed frozen
job specification. It made zero AWS writes and zero RPC calls.

Before declaring the AWS trial verified:

- Confirm the deployed worker/reader identities and their candidate-only resources.
- Start the job; verify increasing cursors, actual S3 archives and private API reads.
- Pause/resume in AWS and reconcile the first day with the local reference receipt.
- At completion, verify all 8,640 buckets, event identity/counts, price gaps and
  dated API pagination; record actual RPC traffic, invocation time and storage.
- Keep production on its existing dataset. Further date chunks, later pool lifecycle
  admission, and any production promotion require their own reviewed operation.

The reviewed chunk list deliberately has no arbitrary extension or activation command.
Existing local artifacts remain a comparison corpus; this AWS rehearsal captures its
own evidence to validate the real credential/storage path after deployment.

Continuation checks additionally exercise blocked/skipped predecessors, mismatched
frontiers, idempotent starts, pause/resume, stale owners and preservation of the
original completed job using DynamoDB Local. Those transaction tests seed completed
boundary checkpoints: they do not pretend to replay an additional month. Core tests
verify next-range capture excludes the retained edge block and sampling carries the
opening observation. Cloud continuation and full-range reconciliation remain
post-deployment proof; local test success alone does not establish either.

Continuation validation on 2026-10-11: TypeScript and all 248 history/operator
tests passed. The real DynamoDB Local/DuckDB rehearsal passed for both successor
admissions and the retained chart/activity API; it made no AWS writes or RPC
calls. The candidate Linux image imported its handler and executed native DuckDB
with networking disabled. No candidate job was started during implementation.

November continuation validation: TypeScript and 269 history/operator tests pass.
The DynamoDB Local/DuckDB rehearsal seeds a completed October boundary, then
executes November capture, Parquet aggregation, sampling and publication. It
checks the unchanged dataset pointer/definition, October receipt and original
cursor starts, rejects an incomplete predecessor and changed dataset boundary,
and exercises idempotent start and pause/resume. This made no AWS writes or RPC
calls; it is not a claim that a full month was captured locally.
