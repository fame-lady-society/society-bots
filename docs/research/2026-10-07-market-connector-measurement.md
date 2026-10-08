# Local conversion-pool ingestion measurement

Read-only RPC measurement on 2026-10-08 UTC (2026-10-07 America/Denver). No production writes, deployment, backfill, or application changes. Uses the existing Base RPC credential via AWS SSM; credentials are not recorded.

## Method

Four disjoint finalized 500-block windows, spaced six hours apart. Each spans 998 seconds between first and last timestamps: approximately 16 minutes 40 seconds of block coverage, or 66 minutes 40 seconds total. This samples the preceding day; it is not a complete 24-hour scan.

Six log queries per window: all five direct FAME addresses together, then each of five selected connector sources. Address-based queries request all events (a conservative event-filter baseline). The V4 query uses the reviewed PoolManager address plus indexed BASEDFLICK/ZORA PoolId; it never reads the whole manager. Empty V4 results do not independently qualify that decoder or prove historical pool inactivity outside these windows.

| From block | Through block | First timestamp UTC | Last timestamp UTC |
|---:|---:|---|---|
| 52314289 | 52314788 | 2026-10-08T00:05:25+00:00 | 2026-10-08T00:22:03+00:00 |
| 52303489 | 52303988 | 2026-10-07T18:05:25+00:00 | 2026-10-07T18:22:03+00:00 |
| 52292689 | 52293188 | 2026-10-07T12:05:25+00:00 | 2026-10-07T12:22:03+00:00 |
| 52281889 | 52282388 | 2026-10-07T06:05:25+00:00 | 2026-10-07T06:22:03+00:00 |

## Measured logs

| Source | Events per 500 blocks, chronological | Total JSON response bytes | Total log request seconds |
|---|---|---:|---:|
| all-five-fame-pools | 0, 0, 0, 0 | 147 | 1.567 |
| uniswap-v3-usdc-weth-5bps | 207, 508, 412, 205 | 1,178,210 | 1.493 |
| uniswap-v3-zora-weth | 11, 7, 4, 2 | 21,237 | 0.673 |
| scale-equalizer-usdc-frxusd | 0, 0, 0, 0 | 147 | 1.052 |
| scale-equalizer-usdc-scale | 0, 0, 0, 0 | 147 | 2.003 |
| uniswap-v4-basedflick-zora | 0, 0, 0, 0 | 147 | 1.251 |

The entire probe made **43 RPC requests**, receiving **1,483,793 bytes** of decoded HTTP response bodies. This includes chain verification, window boundary headers, 24 log queries, and ten additional header samples. All queries completed without retries or splitting. RPC requests are not provider billing units; no dollar cost was measured.

## Header overhead

WETH/USDC had 103–204 event-containing blocks per 500-block window. Across every source and all four windows there were 635 distinct event-containing blocks. Ten real header reads averaged 11,966 response bytes and 0.187 seconds. `eth_getBlockByNumber(..., false)` still returns transaction hashes; these are not minimal timestamp-only records. Header sample is small and not randomized.

Fetching WETH/USDC headers sequentially would therefore take an estimated 19–38 seconds per 500-block batch at the sampled latency, versus 0.31–0.45 seconds for its log query. This is an estimate, not a measured complete collector invocation. Deduplicate header reads across sources and batches; evaluate bounded concurrency or JSON-RPC batching without assuming batching reduces provider billing. Preserve actual block timestamps and hashes rather than assuming a fixed block cadence.

## Rough scale, not a billing forecast

If these sampled rates persisted for a day: roughly 29,300 events, 26 MB of log-response JSON, and 3.1 MB of gzip-compressed log arrays per day. Gzip is only a compression proxy, not measured Parquet or S3 size. Fetching every unique event-block header would add approximately 13,700 RPC calls/day and 164 MB/day at the small header sample mean. Live five-minute log polling and boundary/snapshot calls add further requests.

The current 500-block, 5,000-event, 4 MiB response ceilings comfortably fit these log samples. Header reads approach the 256-request run ceiling in busier windows and dominate the modeled requests. Byte size, event rate, and latency spikes remain unmeasured.

## Decision and next validation

The selected WETH/USDC connector dominates this sample; selected ZORA/WETH is modest, and the other connectors are quiet. This does not establish a permanent activity ranking. Retain the planned architecture and prioritize shared header caching plus bounded fetch concurrency before broader ingestion.

Before deployment, run a full contiguous day through the actual proposed collector/materializer, including required-event filters, pinned state bootstrap and validation, replay, Parquet, serving publication, and restart behavior. Measure peak batches and sustained catch-up against five-minute scheduling. Reconcile provider dashboard billing units with the same time window; AWS request/storage/compute cost is not measured here. This probe makes no pricing or end-to-end completeness claim.

Local reproducibility artifacts: `/tmp/fame-connector-measure.py` and `/tmp/fame-connector-measure.json` (temporary; report records immutable block windows). The JSON includes finalized boundary hashes, event-topic counts, event-block identities, and timings. Re-running requires AWS `fls-power` access to the existing RPC SSM parameter.
