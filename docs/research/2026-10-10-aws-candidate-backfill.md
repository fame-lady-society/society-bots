# AWS candidate backfill and same-scope continuation

The first milestone collected `[2024-07-13 00:00, 2024-08-12 00:00)` UTC, starting with
Base launch block 17,019,741. It contains only Uniswap V2 and V3 FAME/WETH. The
reviewed WETH/USDC pool supplies bucket-end conversion samples. The other current
FAME pools launched later and enter through the dated admissions below. There is no production dataset promotion operation in this implementation.

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

## Full catch-up run

After the four completed jobs, `full` captures November 10, 2024 through the
latest completed UTC day at **explicit start time**. The cutoff is persisted
once with a hash of every chunk specification. Repeating start or resuming later
never moves it. The final interval may be shorter than 30 days; completion stops
collection instead of turning this into a live collector.

The first catch-up chunk admits all eight known direct pools. Besides the four
already present, it includes Equalizer FAME/WETH and FAME/SCALE (November 19,
2024), Slipstream FAME/BASED FLICK (August 22, 2025), and Equalizer FAME/frxUSD
(March 12, 2026). Creation blocks gate price sampling and index membership;
raw logs retain events from each creation transaction. Conversion pools are
sampled at bucket end, not indexed trade by trade. The existing reviewed routes
are retained. Missing historical state or zero active liquidity remains a gap;
no price is fabricated. The BASED FLICK launch probe has such a gap in the direct
pool rate although both conversion legs are available.

The candidate reader receives a dated eight-pool definition at November 10.
July–November pages remain under their original definitions and stay readable;
only the final October observation is remapped for opening weights. Nothing is
replayed, rewritten or promoted to production. All later chunks reuse this
scope and its original capture/sample starts. The four deployed job hashes stay
unchanged. A changed future plan fails closed rather than silently changing the run.

Operator rollout: merge PR #66 and deploy **History candidate** on main. Verify
the revision, then explicitly start the run:

```sh
yarn nodets scripts/market-history/candidate-control.ts start fls-power full
yarn nodets scripts/market-history/candidate-control.ts status fls-power full
yarn nodets scripts/market-history/candidate-control.ts pause fls-power full
yarn nodets scripts/market-history/candidate-control.ts resume fls-power full
```

The five-minute worker automatically creates each successor only after its
predecessor is complete, unleased and all four checkpoints align. Run-wide pause
blocks work and successor admission, including at a chunk boundary; a request
already in flight may finish before the worker checks pause again. Individual
chunk pause is also retained and requires its own explicit resume. Deployment
alone never starts `full`. Status reports the fixed cutoff, completed chunk
count, active chunk, frontiers and per-job usage. There is no daily spending
cutoff, new paid monitoring, parallel capture or increased request pace.

Eight-pool capture uses at most 1,200 Base blocks per range (previously 2,000)
so pool and market candles fit the existing atomic publication limit. This
assumes Base's two-second block cadence, with two extra buckets reserved for
boundary context; a larger timestamp gap still fails explicitly for repair.

Evidence: [October coverage](2026-10-12-october-candidate-verification.json),
[remaining pool origins](2026-10-13-remaining-pool-origins.json), and
[historical launch probes](2026-10-13-full-pool-launch-probe.json). The read-only
launch probe used 45 RPC requests and 664,714 response bytes per execution.
The frxUSD origin was separately verified by binary search over historical
`eth_getCode` because Blockscout did not expose its creation receipt. Blockscout
first-transaction dates are not used as creation dates.

The worker selects the earliest incomplete reviewed job. Missing or paused legacy jobs stop selection. After an explicit `full` start,
missing catch-up jobs are created automatically within the frozen plan. Starting a successor transactionally requires its predecessor to be
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
- Keep production on its existing dataset. Any production promotion requires its own reviewed operation.

The full run has a fixed cutoff and no production activation command.
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

Full-run validation: TypeScript and 275 history/operator tests pass. The real
DynamoDB Local/DuckDB rehearsal executes capture, Parquet, sampling and
publication after eight-pool admission. Seeded month-end checkpoints then verify
automatic successor creation, original dataset starts, a one-day final chunk,
run-wide pause at handoff, retry-stable cutoff and no work beyond it. It preserves
prior definitions and October's completed receipt. This local fixture makes no
AWS writes or chain RPC requests and does not claim a full-month local capture.

### RPC failure diagnosis (2026-10-13)

The full candidate run advanced despite multiple invocations ending with
`rpc-failure`. The deployed transport discarded the underlying category, so
those existing logs cannot establish whether the provider timed out, throttled,
rejected a historical read, or returned malformed data. A local read-only probe
of 24 November 10 historical samples succeeded (72 requests, 938,699 response
bytes); this does not establish AWS/provider reliability.

Transport metrics now retain `lastFailure` with a fixed failure kind (`timeout`,
`network`, `http`, `provider`, or `invalid-response`), an allowlisted method,
duration in milliseconds, and optional numeric HTTP status/RPC error code.
Candidate logs and `candidate-control.ts status fls-power full` expose it under
`lastMetrics`. No provider text, request parameters, URLs, response bodies, or
exception causes are retained. The only request-derived diagnostics are validated
numeric `fromBlock` and `toBlock` for failed `eth_getLogs` requests; tags, reversed
ranges and unsafe integers are omitted. This is the last failure within that invocation,
not a cumulative history; CloudWatch retains previous invocation records.

Request/byte/deadline limits still yield normally, range limits still split,
and checkpoints still resume on the next run. No in-request retries were added
without evidence of the failure category. After operator merge, deploy only
the **History candidate** workflow, then inspect `lastMetrics.lastFailure` on
the next failed invocation: HTTP 401/403 requires credential/access checks;
429 requires provider rate-limit investigation; timeout/network/5xx warrants
bounded retry consideration; provider codes need a targeted historical-read
probe. Repeated failure at the same checkpoint must not be treated as progress.
This change does not switch datasets, restart jobs, or deploy production.

### Candidate timeout recovery and grouped publication

Candidate RPC requests may retry a timeout once, after 250 ms, only if the
backoff plus another full attempt fits with a one-second reserve and
request/response allowances remain. Candidate `eth_getLogs` attempts have a
20-second timeout; all other methods and the live worker retain 10 seconds. Both attempts count against the same invocation limits. The diagnostic
retains the timeout and increments `timeoutRetries`, even if the retry succeeds.
Other failures and exhausted retries still surface normally. The live worker does
not enable this option.

Candidate publication collects up to 12 five-minute buckets, stages immutable
currency pages/activity indexes and retained generation manifests, then switches
the affected day pointers and rolling publication/checkpoint in one conditional
transaction. Every observation checksum remains guarded by that transaction.
Previous/new generation manifests retain their existing expiry semantics, but are
ordinary staged writes instead of large transactional writes. A group may span
midnight; both day pointers move together. The reader contract is unchanged.
Publication lag is drained on resume, at the chunk boundary and at normal bounded
invocation completion; an exception leaves collected samples available to the
next invocation. Staging may leave unreachable immutable artifacts on failure;
no reader pointer exposes them. There is no history rebuild or dataset switch.

`yarn nodets scripts/market-history/publication-benchmark.ts` verifies real
DynamoDB Local transactions, including interrupted staging, checksum rejection,
lost commit response, stale-writer rejection and cross-midnight equivalence.
Local capacity reporting is not billing evidence. With `--aws-profile fls-power`,
it creates and deletes disposable `FameHistoryCandidate-benchmark-*` tables and
compares the existing single-bucket publisher to groups of 12 using DynamoDB's
returned consumed capacity. It seeds the same 288 synthetic eight-pool buckets
for each path; raw capture, sampling and activity-index creation are excluded.
The comparison uses [AWS item-size and transactional write accounting](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html).
This isolates publication cost per indexed day, not total backfill cost or a
promise of production savings. No active candidate or production data is used.

Rollout: merge, then run **History candidate** only. Existing candidate checkpoints
resume automatically. Inspect `timeoutRetries` with `lastFailure` and continued
publication progress; a recovered timeout should no longer end the invocation.


Candidate log timeout follow-up: read-only probes at the failed checkpoint
36212528 compared 1,200-block reads with 600- and 300-block splits. Across three
rounds all returned zero events; full-range reads took 0.69–1.38 seconds, versus
1.04–1.94 and 1.81–2.15 seconds total for splits. This local evidence does not
reproduce AWS tail latency or prove that 20 seconds resolves every timeout.
Keep the 1,200-block cap; after candidate deployment, use numeric failed ranges,
`durationMs`, `timeoutRetries`, phase and checkpoint movement to assess recovery.
A failed final retry remains an error; no gaps are silently skipped.
