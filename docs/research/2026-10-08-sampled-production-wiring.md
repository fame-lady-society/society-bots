# Sampled market production wiring and rollout

## Activation behavior

Deploying the updated history stack adds sampled collection to the existing
five-minute collector invocation and sampled publication to the existing one-minute
worker. No new schedules, services, IAM permissions, daily cutoff, or feature flag.
Execution capture, its immutable start marker, reference collection and existing
HTTP responses continue unchanged during consumer migration.

The first invocation creates `sampled:<policy revision>/collected` conditionally.
It records the next aligned five-minute start and a finalized anchor; retries reuse
that marker. Each observation is a checksummed create-only S3 object under
`raw/sampled/`, with its manifest and next timestamp committed atomically in
DynamoDB. Four buckets maximum per invocation; time/request limits retain progress.
The first observation appears after a full eligible bucket has closed and finalized.

Publication consumes committed sampled evidence and checksum-verified existing
execution archives. It waits until the execution archive reaches the bucket end,
then publishes native counts/amounts and sampled conversions. This deliberately
allows price publication to lag collection by an execution-collector interval;
API gaps distinguish unpublished data. A failed connector call can leave converted
prices unavailable while native amounts remain present. Known archive gaps or
rejected events retain partial coverage rather than being called complete.

A bounded scan of up to 16 execution manifests / 8 MiB brackets the bucket. Shared
archives are cached for the invocation. Oversized scans fail explicitly; they do
not discard events. Adding busy direct pools requires requalifying this bound or
implementing resumable per-bucket aggregation before onboarding. Current five-pool
history has been checked with the local day rebuild; no claim is made about every
future pool workload.

## Publication and serving

The production layout refines the earlier hourly-page sketch: one immutable page
per currency/bucket, plus a rolling 288-bucket manifest. The two pages and manifest
activation fit a single transaction with an observation-hash condition. A generation
compare-and-swap rejects stale publishers. Lost successful responses recover from
the committed manifest. Old pages are retained, allowing readers that pinned an
older generation to finish safely. This avoids rewriting hourly history on every
new bucket. No automatic deletion policy is introduced.

The authenticated existing route gains an explicitly selected dataset:

`GET /fame/history?view=sampled-market&currency=ETH|USDC&resolution=300&from=...&to=...`

Existing `view=market` and `view=pool` contracts are unchanged; this is not a silent
replacement of execution candles with sampled prices. Coordinate the eventual
frontend switch and retirement of obsolete mapping separately.

The reader uses only existing DynamoDB transaction-read permissions. It pins the
manifest and retrieves exact checksum-addressed pages in batches of 64, with the
existing seven-second work budget and 2 MiB response cap. No S3/RPC/native analytics
on the request path. Fields identify `bucket-end-spot` conversion and sampling.
Before any publication it returns 503 `sampled-history-not-ready`. Once publication
exists, requested missing buckets have `outside-published-window` or
`not-yet-published` status with null price/volume; they are not fabricated zeroes.

## Proof and limits

- Unit and API-handler tests exercise route validation, bounded ranges, checksum
  failure, gaps, cursor resume and map-order-independent generation hashing.
- DynamoDB Local plus in-memory checksummed S3 verifies competing collectors,
  successful publication followed by a lost response, stale-publisher rejection,
  native trade aggregation and both ETH/USDC readers.
- The same rehearsal loads 288 synthetic buckets and reads both currencies through
  the production reader. This is scale/transaction proof, not a live 288-bucket
  production deployment. CI runs it via `worker-rehearse.ts`.
- Real bundled collector/reader imports and CDK tests pass. Existing IAM suffices.
- Local production-chain backfill evidence and native-volume comparisons are in
  [the day rebuild receipt](2026-10-08-sampled-market-backfill.md).

No production writes or deployment were performed to obtain these proofs. Existing
local artifacts have not been imported into S3/DynamoDB by this change. Deployment
starts forward collection; it does **not** expose the rebuilt day immediately.
Historical import must preserve the live marker, have separate progress, validate
the final policy/schema and publish through fenced generation updates. That importer
is still follow-up work. Policy changes create a distinct sampled namespace and
require an explicit rebuild; automatic pool-membership expansion remains follow-up.

## Operator sequence

1. Review and merge PR #45 after the latest CI checks pass.
2. Run the **Market history** workflow on `main`; deployment remains an operator
   action. This starts forward sampled collection/publication, while old consumers
   continue receiving their existing data.
3. After the first eligible bucket and execution range are published, verify
   `fame-sampled-collection` and `fame-sampled-publication` structured logs advance,
   then request both currencies through the existing bearer-authenticated endpoint.
   A full-day query initially contains explicit gaps outside the new coverage.
4. Keep the frontend on its current contract until historical import and the
   consumer cutover are separately reviewed. Never rewind the execution start marker.
5. For rollback, deploy the prior application revision. Execution data and the old
   API remain intact; sampled objects/cursors can be retained for investigation and
   resume. Do not delete or rewrite either dataset to roll back code.
