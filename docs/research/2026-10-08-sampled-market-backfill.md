# Sampled market: local 24-hour rebuild receipt

Subsequent production wiring and current activation instructions are documented in
[the rollout guide](2026-10-08-sampled-production-wiring.md). The release-boundary
section below describes the earlier local-only commit, not the updated PR head.

Read-only production access; no S3/DynamoDB writes, deployment, start-marker change,
or API cutover. Local artifacts are in `.market-history-local/sampled-day-v1/`
(ignored by Git). They include a frozen job manifest, original compressed archives,
raw ABI observations, Parquet, checksummed serving pages, and verification receipts.
Retain that directory for the eventual importer; it contains no RPC credential.

## Verified result

Window: **2026-10-07 01:15 UTC through 2026-10-08 01:15 UTC**, half-open.

- 216 existing committed archive batches reused; 781,575 compressed bytes.
- 288 bucket-end observations; 2,154,528 bytes of raw JSON evidence.
- 57,046-byte ZSTD Parquet export. Re-decoding every row reproduces published
  prices and inventory in both currencies.
- 48 immutable serving pages; 1,394,010 total bytes.
- All **1,440 pool/bucket native volume and trade-count records match existing
  production DynamoDB records**, with no mismatches or missing comparisons.
- 29 executions; all 288 buckets have complete direct-event coverage.
- Prices available for all 1,440 pool/buckets in each currency.
- 1,415 quiet pool/buckets have prices and verified zero executions.
- Local loopback HTTP returned 200 with 288 buckets: ETH 687,485 bytes;
  USDC 699,884 bytes. Both fit the current 2 MiB response cap. Server closed after
  both requests; no background service remains.

These are five separate pool series within one market response, not a blended
market price. Volume uses the bucket-end conversion rate. Production execution
candles remain unchanged.

## Resume and request evidence

The initial bounded pass stopped after preserving 214 observations. Its original
error handler withheld diagnostic details and did not save a final request receipt;
do not claim an exact whole-job request total. Its configured ceiling was 3,500
RPC calls; last progress at 192 buckets reported 3,152 calls and 49,956,423 bytes.
Subsequent code now emits fixed failure codes and request counters on failure.

Before resume, boundary lookup was improved to use verified archive headers as
brackets. It still checks the boundary successor against RPC. The resumed run
reused all 214 observations and fetched only 74: **702 requests, 9,821,799 bytes**
(one chain check, 627 headers, 74 Multicalls), completing in about 46 seconds locally.
No failed observation was fabricated or carried forward. Transport-wide failures
currently stop the local job safely and require resuming; they are not classified
as permanent historical gaps. Per-call reverts remain explicit missing values.

This combines two code revisions and is not a clean all-day performance benchmark.
No dollar-cost estimate, Lambda memory/throughput proof, or complete historical
provider availability claim follows from it. The existing service's low observed
bill is encouraging but remains a separate measurement.

## Reproduction

Set `AWS_PROFILE`, `AWS_REGION`, `FAME_HISTORY_TABLE`, `FAME_HISTORY_BUCKET` and
provide `FAME_HISTORY_RPC_URL` through the approved secret mechanism. Never paste
or record the RPC URL. Use the same output directory to resume an incomplete job;
its frozen policy, source manifests and metadata must match.

```sh
yarn nodets scripts/market-history/sampled-backfill.ts .market-history-local/new-day
yarn nodets scripts/market-history/verify-sampled-backfill.ts .market-history-local/new-day
yarn nodets scripts/market-history/sampled-http-rehearse.ts .market-history-local/new-day
```

Backfill runs exclusively read-only AWS Query/Get operations and local writes. A
single-writer lock rejects concurrent local runs; after a hard process kill, verify
no owner process remains before removing its stale `lock` file. Atomic immutable
writes reject conflicts instead of overwriting evidence. New output directories
select a new last-completely-archived day; existing jobs keep their original range.

Verification makes read-only production comparisons. HTTP rehearsal uses loopback
and shuts down. None of these tools is a production ingestion or serving endpoint.

## Release boundary

The PR can preserve the reader, math, tests, local tools and receipts. **Deploying
this PR does not activate sampled collection or the new API.** Do not request a
production cutover yet. Remaining work includes stable source/dataset identities,
dated membership, deployed hook qualification, durable production snapshot jobs,
S3 import of this local evidence, DynamoDB publication/fencing, API/consumer wiring,
20-pool and Lambda proofs, and operator merge/deployment approval for that change.
The data-import step must validate these artifacts against the final schema; it
must not blindly assume this prototype's pages are production-ready.
