# Captured Base history sample

Captured on 2026-10-03 using `scripts/market-history/capture-sample.ts`, the
deployed pool-state indexer's primary RPC, and read-only access to the existing
pool-state table. The RPC URL and AWS credentials are not included. This is
public on-chain event/state evidence, not mocked trade data.

- Chain: Base (8453); inclusive range: 52090000–52139999.
- Scope: five direct FAME pools from the generated registry recorded in the archive.
- `raw.jsonl.gz`: one range/header/observation record, then 17 raw event records.
- `manifest.json`: original object checksum, byte count, range hashes, event
  identity digest, and uncompressed-content checksum. Its S3 key describes the
  candidate object; this fixture was saved locally and was not uploaded.
- `tokens.json`: token0/token1 for all five pools and decimals for all five unique
  tokens, queried at block 52090000. Every captured token reports 18 decimals.
  The pinned block hash was checked before and after the metadata reads.
- Capture total: 30 RPC requests (1 chain ID, 13 headers, 1 logs, 15 eth_call),
  192,291 response bytes, 5,076 compressed archive bytes, 10.79 seconds including
  TypeScript startup. The uncompressed checksum was added from these original
  bytes during the predeployment manifest format tightening.

The provisional decoder identifies five trades and twelve other pool events,
with no unknown or rejected events. V2 and Solidly trades are represented;
Slipstream decoding is tested synthetically elsewhere. This sample does not
prove every deployed ABI or provider completeness under load. Prior diagnostic
queries against both configured RPC endpoints matched all 17 event identities;
independence of their underlying infrastructure is unknown.

Liquidity observations were read at capture time. Their `observedThroughBlock`
and other source fields are preserved as-is and may lie outside this historical
trade range. They must not be represented as historical liquidity at the event
timestamps. Repeated observations do not create fresh samples.

The fixture covers a sparse range, not the selected pools' full lifetime. The
local proof uses conservative partial coverage at boundary candles. Older pools
outside the explicit registry scope are not included. See
`docs/fame-market-history.md` for replay commands and the production boundary.
