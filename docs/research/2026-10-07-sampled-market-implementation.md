# Sampled market implementation: first local slice

Follow-up: [completed local 24-hour rebuild receipt](2026-10-08-sampled-market-backfill.md).
The following four-bucket receipt records the initial step; production integration
remains pending.

Implements the initial contract/math and read-only reader from the consolidated
market plan. This is not connected to the production collector, publication store
or HTTP API. Existing execution OHLC, volume and historical archives are untouched.

## Implemented

- `sampled-market.ts`: ETH/USDC route policy, exact rational conversion, a one-bucket
  draft v2 response, separate price/event/inventory availability, closing-rate gross
  volume, pool-held inventory and transaction deduplication. Native atomic volumes
  survive conversion failures. Unknown activity is not zero. No converted OHLC.
- `sampled-rpc.ts`: 49 shared ABI subcalls for the existing ten unique direct and
  connector sources, in one finalized-block Multicall. No oracle, tick enumeration
  or connector event indexing. Raw result bytes are retained for deterministic
  offline decoding; balances fail independently of prices.
- `sampled-rehearse.ts`: 1–4 most recent closed buckets, bounded RPC transport,
  existing boundary search with successor/hash verification, and a create-only local
  evidence/response artifact. Does not collect trades, so volume remains unknown.

With `FAME_HISTORY_RPC_URL` provided securely:

```sh
yarn nodets scripts/market-history/sampled-rehearse.ts /tmp/sample-market.json 4
```

## Live read-only receipt

Four bucket starts: 1791420600, 1791420900, 1791421200, 1791421500.
Selected end blocks: 52315776, 52315926, 52316076, 52316226.
All five direct pools returned usable prices and inventory in both ETH and USDC
at all four boundaries. Full local evidence: `/tmp/fame-sampled-market-rehearsal.json`.
No provider URL or credentials are stored in that artifact.

47 RPC calls: one chain check, 42 header reads, four Multicalls. Total decoded
response bodies: 700,457 bytes. Approximately five seconds including local runner
startup, not a Lambda benchmark. This verifies recent read compatibility, not full
historical coverage, hook safety, provider billing or exact intrabucket prices.
Header lookup still dominates request counts; cache/lookup improvements remain.

| Path | Recent reads | Qualification still needed |
|---|---|---|
| FAME/WETH, both pools | ETH and WETH/USDC available | Full-day replay/snapshot comparison |
| FAME/frxUSD | Stable USDC connector available | Deployed invariant proof and edge fixtures |
| FAME/SCALE | USDC connector available | Full-day coverage and identity proof |
| FAME/BASED FLICK | V4 BASEDFLICK/ZORA and V3 ZORA/WETH available | Hook/PoolKey qualification and historical availability |

## Serving layout sketch

Start with immutable one-hour pages per currency (12 buckets), plus a small
publication manifest containing 24 page references per 24-hour currency window.
A five-series response and page have fixture size checks against the existing
2 MiB API and 400 KiB item caps. These fixtures do not prove DynamoDB attribute-size
accounting or production latency. Readers pin the manifest; updates stage a changed
page and conditionally activate a new manifest, reusing other pages. Manifest
fencing, checksums, maximum serialized page size, actual DynamoDB Local testing,
20-pool growth and optional-series pagination must be proven before this layout
is final. No serving persistence is implemented by this slice.

## Remaining before release

1. Complete family/hook qualification, stable/inverse/decimal fixtures and explicit
   per-source failure provenance. Reviewed token decimals are currently limited to
   existing assets; future cbBTC requires explicit metadata support.
2. Separate durable source, membership and dated policy identities; currently the
   prototype derives a revision from the reviewed registry/routes and does not
   implement dated membership. Unknown quote assets fail qualification explicitly.
3. Archive observations with independent live/refill/repair cursors, implement
   bounded Multicall chunking, classify recoverable/permanent historical failures,
   and resume without blocking later buckets.
4. Integrate actual direct-pool event aggregation and implement immutable serving
   publication/API. The materializer currently accepts caller-supplied per-pool
   bucket aggregates; the caller must prove their event coverage and deduplication.
5. Run a contiguous day and 20-pool workload under Lambda limits, review, coordinate
   consumer cutover and deploy through CI. This initial probe is not the full-day
   cost or end-to-end release rehearsal.

Existing live service remains the deployed implementation until these gates pass.
