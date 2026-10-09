# Six-pool history rollout

The deployed five-pool dataset stays active while a replacement is prepared.
Code deployment and dataset activation are separate operations. Operator merges
and deploys; the backfill runner never does either automatically.

## What changes

- Three production entrypoints resolve the active scope and its immutable
  definition from DynamoDB. Deployment no longer selects an empty new revision.
  A warm reader adds one small pointer GetItem; the immutable definition adds
  one more GetItem on first use. Existing page
  batching, gzip, ETags and repair-aware cursors remain intact.
- Definitions live separately from the active pointer because the previously
  deployed collector replaces that pointer on each raw commit.
- The expansion tool accepts only additive direct-pool changes. Existing pool
  identities, routes and token metadata are retained. Route edits, removal,
  changed decoder policy and genesis coverage are not handled by this command.
- Source archives are checksum-verified. Existing native events are reused;
  RPC log scans cover only the added V3 emitter. New archives have the six-pool
  identity plus source-manifest provenance. Old archives and cursors are untouched.
- Existing legacy valuation snapshots are retained at their original boundaries.
  If capacity splits introduce an unsampled boundary, its legacy valuation is
  explicitly unavailable. Original observations are never relabeled in time.
- Six-pool historical boundary samples use the existing on-chain sampler for all
  pools and conversion routes. An opening bucket precedes the visible 288-bucket
  window. Failed/missing historical calls retain the sampler's explicit gaps.
- Staging builds raw archives, Parquet, native execution OHLC/volume, compact chart
  pages and activity sidecars. Sampling and raw progress have separate cursors.
  Old oracle-reference publications are not imported into the new namespace;
  compact ETH/USDC charts use sampled on-chain conversion, not that legacy oracle
  reference lane.

## Prepare and stage

Use the existing AWS profile, region, table and bucket. Supply the RPC URL through
an existing secret-injection mechanism; never put its value in shell history.

```sh
export AWS_PROFILE=fls-power
export AWS_REGION=us-west-1
export FAME_HISTORY_TABLE=FameMarketHistory-HistoryD990305F-18XHQL85466VU
export FAME_HISTORY_BUCKET=famemarkethistory-historyarchive4304ea9e-dmwohucmgmln

yarn nodets scripts/market-history/expand-scope.ts prepare /private/tmp/fame-six-pool-expansion.json
# Requires FAME_HISTORY_RPC_URL in the environment. Explicit AWS staging writes:
yarn nodets scripts/market-history/expand-scope.ts stage /private/tmp/fame-six-pool-expansion.json --apply
```

`prepare` reads the active registry from verified existing archives and writes a
local immutable job. The job binds table ARN/account/region, bucket owner, source
and target definitions, original raw start, and sampling start. Keep this file
outside the repository. Recreating it with a new moving window is not resume.

Repeat `stage` with the SAME file. Each run attempts at most 12 raw ranges, 12
sample buckets and 12 aggregation ranges/publications, within a four-minute RPC
allowance (512 calls, 32 MiB total response allowance). Limits bound one run and
preserve committed progress; there is no daily cutoff. Raw ranges are capped at
500 blocks and shrink on capacity pressure. A failed single-block range remains
explicitly blocked rather than skipped. Each run prints counts, cursors, RPC
methods/bytes and publication progress without provider URLs.

The first successful registration writes immutable source and target definitions
and a job record. It does **not** select the target or move a live checkpoint.
Raw and Parquet staging transactions guard the old active scope. Concurrent
stagers use the existing conditional cursor/lease/publication writes; one wins,
and the other resumes from committed state on rerun.

This admission preserves the original live raw start (2026-10-06), even though
only the recent day is published. It reuses those few days of existing raw data
and adds V3 logs. It does not initiate the July 2024 genesis backfill.

## Deploy, verify, activate

1. Register/stage the job, finish review and merge PR #52 through the operator.
2. Operator runs the **Market history** workflow on `main`. Its preflight requires
   an existing history table and a valid active definition before deployment.
   This rollout workflow is for the existing stack, not first-time provisioning.
3. Verify the deployed collector, publisher and reader still use the five-pool
   dataset. Continue staging until raw and aggregation checkpoints catch up and
   a full 288-bucket six-pool chart window is published.
4. Read-only verification:

   ```sh
   yarn nodets scripts/market-history/expand-scope.ts verify /private/tmp/fame-six-pool-expansion.json
   ```

   It checks both currencies' immutable page checksums, all activity indexes and
   chunks, and unchanged native counts/atom volumes for complete overlapping
   five-pool buckets. It requires exact raw frontier/hash equality, caught-up
   Parquet aggregation and a full-day publication at least as recent as live.
   Verification is bounded to four minutes, 4,096 activity chunk reads and 32 MiB
   of activity bodies; exceeding this requires a separately reviewed larger
   verification run, not a daily operating cutoff.

5. **Only after the definition-aware deployment is verified**, operator-authorized
   handoff (this reruns verification immediately before the transaction):

   ```sh
   yarn nodets scripts/market-history/expand-scope.ts activate /private/tmp/fame-six-pool-expansion.json --apply
   ```

   A single transaction compares source/target raw cursors, publication
   generations, target sampling/aggregation progress, immutable definitions and
   job identity before changing the active pointer. A concurrent advance aborts
   the entire switch. Stage/verify again; never reset a cursor to force it through.
   An ambiguous/lost activation response is resolved by rerunning the command:
   matching active scope and completed job are reported as already active.

6. Probe authenticated `view=chart` and `view=activity` in ETH and USDC. Expect six
   pool identities, 288 published buckets, valid quiet-bucket reference values
   where available, and one row per event. A pre-cutover chart/activity cursor
   belongs to another revision and must receive the existing reset response.
   Observe subsequent scheduled raw/sample/publication advances on the new scope.

An in-flight old raw collector can fail its guarded commit at activation. Its
next invocation resolves the new scope. In-flight sampled work can finish in the
old namespace without overwriting new-scope pages. Old objects and definitions
are retained; there is no automatic rollback. Returning to the old dataset later
requires its checkpoints to be caught up and a reviewed handoff, not merely
changing an environment variable.

## Evidence and remaining proof

- Read-only production preparation succeeded for five source pools and six target
  pools, original start 52,264,484 and then-committed frontier 52,359,345. This is
  a point-in-time receipt, not a claimed current frontier.
- Unit tests cover additive identity checks, source corruption/reorg rejection,
  merged-event preservation, prefix resume, explicit replay bounds, invalid
  definitions and handoff readiness.
- DynamoDB Local rehearsal covers competing registration, lost-response resume,
  old collector pointer replacement, separate raw/Parquet staging, stale cursor
  and generation rejection, atomic activation and old-writer rejection.
- The existing 288-bucket sampled/HTTP rehearsal remains separate from the
  synthetic publication manifests used to test handoff transaction conditions.
- Local checks do not prove AWS IAM, historical provider availability, successful
  production staging, deployment, activation or frontend acceptance. Record those
  separately when performed.

### First bounded AWS staging receipt

Job `de80fcd2d75e3dc7863a0b12e78aa65dadecfdff7f648c0f059ee2144bbd17c1`
was registered and one staging run completed using the existing AWS/RPC access:
12 raw ranges and 12 Parquet aggregation ranges; target raw next block 52,266,783.
Twelve five-minute samples were retained (one hour). The publisher returned
`waitingFor: execution-archive` and published zero buckets because raw expansion
had not reached that recent sampling window. That is the intended completeness
boundary, not a reason to advance/reset the publisher.

Measured: 311 RPC requests, 4,099,951 response bytes: 274 block headers, 13 chain-ID
checks, 12 log queries and 12 sampled Multicalls. Wall time was about 70 seconds.
These are provider request/response counts, not billed credit units. The active
pointer remained on the five-pool source; no deployment or activation occurred.
A full 24-hour replacement is **not ready yet**. Continue the same job after review;
do not create a replacement plan with a moving start.

Final local validation for this rollout change: 453 tests across 45 history,
pool-state and operator-script suites; four CDK tests; application TypeScript;
DynamoDB Local transaction rehearsal; captured raw-to-Parquet rebuild; and the
Linux/amd64 container proof with network disabled, read-only filesystem, 512 MiB
memory and 256 MiB temporary storage. The container proof caught and now covers
copying `additional-pools.json` into the actual image.
