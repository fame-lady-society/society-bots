# Isolated FAME/cbBTC and FAME/SPX admission

Implementation branch: `codex/isolated-genesis-pools`, based on PR #56 head
`709e443`. Production registry, active pointer and storage were not changed.
The target is eight direct FAME pools, with seven distinct conversion sources.

## Verified identities and routes

| Source | Address | Creation block | UTC creation |
| --- | --- | ---: | --- |
| Aerodrome volatile cbBTC/FAME | `0x3ed81ea504b5987611d4e270884539fe648694f0` | 21374567 | 2024-10-21 19:21:21 |
| Aerodrome volatile SPX/FAME | `0x02360e4d2bd3129e02a8953a04fc68b08e57f7b3` | 21194336 | 2024-10-17 15:13:39 |
| Uniswap V3 USDC/cbBTC, 0.05% | `0xfbb6eed8e7aa03b138556eedaf5d271a5e1e43ef` | 19763050 | 2024-09-14 12:04:07 |
| Slipstream WETH/SPX, tick spacing 200 | `0x4ba1e3e9280facbacafa7baf4ae0b78bea60beca` | 20549217 | 2024-10-02 16:49:41 |

Both direct pools use factory `0x420dd381b31aef6683db6b902084cb0ffece40da` and
the verified Aerodrome Pool implementation. Factory `getPool(token,FAME,false)`
returned each address. The factory is distinct from Equalizer's factory.

cbBTC (`0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf`) and SPX
(`0x50da645f148798f68ef2d7db7c1cb22a6819bb2c`) both have **8 decimals**.
Token order, factory, stable flag/tick spacing and historical decimals were
checked; symbol matching alone was not used to admit a token.

- cbBTC → USDC uses the selected Uniswap pool; ETH conversion continues through
  the existing WETH/USDC 0.05% pool in reverse.
- SPX → WETH uses the Slipstream pool; USDC conversion continues through the
  existing WETH/USDC pool.
- The existing WETH/USDC pool is `0xd0b53d9277642d899df5c87a3966a349a798f224`.

Blockscout creation transactions were checked against RPC receipts. For each
source, code is absent immediately before its creation block and present at
creation. First-transaction dates were later and were not used as start blocks.
Creation transaction hashes are in `2026-10-10-pool-admission-origins.json`.
Blockscout reads briefly returned HTTP 429; serialized retries succeeded.

## Historical proof

`verify-isolated-pools.ts` used the existing bounded RPC transport and sampler.
At each direct pool's launch bucket, near the end of its first day, and a recent
finalized bucket, both ETH and USDC conversion samples were available. The
conversion pools therefore existed and had usable liquidity at those tested
points. This does **not** prove uninterrupted historical pricing, sufficient
execution depth, or manipulation resistance across their lifetimes. Routes are
frozen spot valuation inputs; missing route prices remain explicit gaps.

The successful probe used 191 RPC requests and 1,882,052 response bytes in about
20 seconds. This excludes Blockscout discovery and unsuccessful diagnostic runs.
It captured 2,000 blocks from each direct launch: cbBTC had three swaps and two
adds; SPX had five swaps and one add. Every captured event decoded. Native amounts
stay exact, and canonical raw archives retain auxiliary logs as well.

Aerodrome Swap/Burn parameter ordering differs from the existing Solidly ABI.
The implementation adds a distinct `AerodromeV2` decoder instead of mislabeling
these pools as Solidly. The checked-in ABI fixture came from the verified Pool
implementation. Tests exercise all nine event layouts, economic classification,
8/18-decimal amounts, inverse cbBTC conversion, and missing-route behavior.

Detailed probe receipt: `2026-10-10-cbbtc-spx-probe.json`. Local raw/sample evidence:
`/private/tmp/fame-isolated-pool-admission-v2`. This temporary directory is not a
durable production archive. Earlier diagnostic artifacts are kept separately.

## Operator entry points and completion boundary

With `FAME_HISTORY_RPC_URL` supplied securely:

```sh
yarn nodets scripts/market-history/verify-isolated-pools.ts /path/to/fresh-local-evidence
yarn nodets scripts/market-history/prepare-isolated-backfill.ts /path/to/local-job 1720828800 1791590400
```

Verification performs bounded chain reads and local writes only. Preparation
performs no RPC/AWS calls and writes an immutable manifest. Repeating preparation
with the same inputs is idempotent; changed inputs cannot overwrite the job.
The prepared interval is explicit and bucket-aligned. Windows are at most one
UTC day and also split at direct-pool launch buckets. Outputs say
`prepared-not-collected`; preparation is not a completed backfill.

The admission registry is imported only by explicit isolated tooling/tests.
Neither deployed `registry.ts` nor the swap service includes these additions.
The multi-day capture/resume controller, actual creation-bucket membership rules,
cross-day opening observations, and staging publication are the next increment.
No full genesis run, remote staging creation, production import or activation
occurred in this increment.
