# Reference collection stalled on large block responses

On October 8, the ETH/USDC chart publication and its sampled collector checkpoint remained at 08:10 UTC. The publisher reported zero lag because it had published everything the collector had committed; that metric does not measure wall-clock freshness. Both reference collectors repeatedly reported `collection-failed` before and after the activity API deployment. The raw event collector later advanced to finalized block 52,341,490; its boundary valuation reads passed a separate read-only probe.

## Confirmed cause

The reference and sampled collectors use a 256 KiB per-response limit. `eth_getBlockByNumber(..., false)` still returns all transaction hashes; it is not a header-only response. A read-only reproduction of the saved checkpoint failed at block 52,328,973 with `RangeLimit: RPC response byte limit exceeded`. Reading that same block with a 4 MiB cap succeeded; the response was 326,359 bytes. The stored anchor hash matched the provider. There was no evidence of a reorg or lost checkpoint.

The generic failure label obscured the typed capacity error because `failureCode` did not recognize `RangeLimit` inside viem's cause chain.

## Fix and evidence

Block reads (`eth_getBlockByNumber` and `eth_getBlockByHash`) receive at least the existing raw collector's 4 MiB allowance. Other methods retain their configured smaller cap. The cumulative response allowance, request count and deadline bounds remain enforced. This changes an accepted response size; it does not request full transaction objects or additional polling.

Typed, wrapped `RangeLimit` errors now report `rpc-response-limit`, and `WorkLimit` errors report `work-limit`, without logging provider messages or credentials.

With the fix, the same saved 08:10 bucket resolved its closing boundary to blocks 52,328,976 / 52,328,977 (08:14:59 / 08:15:01 UTC). Its historical sampled-price call derived all 10 configured rates successfully. The read-only reproduction used 17 RPC requests and 1,895,735 response bytes, with zero AWS writes. This proves the blocking boundary and sample can be read; it does not prove production recovery before deployment.

## Reproduction and recovery

```sh
AWS_PROFILE=fls-power AWS_REGION=us-west-1 \
FAME_HISTORY_TABLE='<existing history table>' \
yarn nodets scripts/market-history/diagnose-collection.ts
```

The diagnostic reads the saved sampled cursor and configured SSM RPC parameter, validates the anchor, finds the next boundary and derives its price sample. It makes at most 40 RPC calls, writes no AWS state, and emits only block metadata, fixed diagnostic labels and response counters. Credentials and provider error text stay out of logs.

Deploy through the existing CI workflow after operator merge. Do not reset either collector cursor or skip the blocked bucket. Existing scheduled collection should resume at 08:10, and publication will follow; bounded runs mean catch-up is gradual. Check the sampled collection checkpoint and the API's published-through timestamp against wall time, not only publisher `lagBuckets`. Verify the newly published activity indexes as well. Existing activity materialization and chart data require no rebuild.

Regression tests cover a 326 KB block response, rejection above 4 MiB, unchanged contract/log limits, cumulative limits, and nested fixed error labels. Larger future responses can still hit bounds; the new label makes that failure identifiable rather than silently appearing caught up.
