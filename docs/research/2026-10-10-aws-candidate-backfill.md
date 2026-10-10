# AWS candidate backfill: first 30 days

This milestone collects `[2024-07-13 00:00, 2024-08-12 00:00)` UTC, starting with
Base launch block 17,019,741. It contains only Uniswap V2 and V3 FAME/WETH. The
reviewed WETH/USDC pool supplies bucket-end conversion samples. The other current
FAME pools launched later; cbBTC/SPX remain excluded until a separately planned
chunk. There is no dataset promotion operation in this implementation.

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

The fixed first chunk deliberately has no arbitrary extension or activation command.
Existing local artifacts remain a comparison corpus; this AWS rehearsal captures its
own evidence to validate the real credential/storage path after deployment.
