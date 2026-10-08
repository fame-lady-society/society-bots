# Genesis deployment inventory — Base market history

Verified read-only on 2026-10-08 using authenticated Blockscout Pro MCP.
Repository baseline: `f704e112a83ba13dc05f588acce1e6b2fa418897`.
Scope: the five direct FAME pools selected by `historyScope`, plus the five
conversion sources selected by `sampledPolicy`. This is not a discovery of every
historical FAME venue. Previously excluded pools remain excluded.

## Verified boundaries

| Registry ID | Creation / initialization block | UTC timestamp | Creation transaction |
|---|---:|---|---|
| uniswap-v3-usdc-weth-5bps | 3620407 | 2023-09-06 19:56:01.000000Z | [transaction](https://base.blockscout.com/tx/0xedb1f442fbc11aa4c0b46d4301ffd50304bc39f6abf125636088c227af75e6e6) |
| scale-equalizer-usdc-scale | 9024316 | 2024-01-09 22:06:19.000000Z | [transaction](https://base.blockscout.com/tx/0x19744fe1afc427e3c95221bbc9ac771d53e652c4a55252303ca5a89a242d7e6e) |
| uniswap-v2-fame-direct | 17019741 | 2024-07-13 00:00:29.000000Z | [transaction](https://base.blockscout.com/tx/0x4bf357967b670f85ee4929953045b9e2071fb7f5d85cda08d536ae6e8e2fabc5) |
| scale-equalizer-weth-fame | 22613864 | 2024-11-19 11:51:15.000000Z | [transaction](https://base.blockscout.com/tx/0x1ba44f547a477aa049a32a06d74f90039a9f36dd621287195a9344a2249d68df) |
| scale-equalizer-scale-fame | 22614190 | 2024-11-19 12:02:07.000000Z | [transaction](https://base.blockscout.com/tx/0xbff542bf4017bd33db2b9a9e70c45c18408d963b257188ef9353e1604283c605) |
| uniswap-v3-zora-weth | 29319573 | 2025-04-23 17:14:53.000000Z | [transaction](https://base.blockscout.com/tx/0x94d4e533a391cef88b49eed9bb6adfbbaea63b7d70b2b0de2f343d14eeb010cd) |
| uniswap-v4-basedflick-zora | 33270814 | 2025-07-24 04:22:55.000Z | [transaction](https://base.blockscout.com/tx/0x646ab412d417206431c445cc8853640ae25c8f8a7c114fd4bf7e86780e277d71) |
| slipstream-basedflick-fame | 34552255 | 2025-08-22 20:17:37.000000Z | [transaction](https://base.blockscout.com/tx/0x19572790ca90942a0d76dc6d55623ac062f5a0610512499b0ee2161285a8d256) |
| scale-equalizer-usdc-frxusd | 38096669 | 2025-11-12 21:24:45.000000Z | [transaction](https://base.blockscout.com/tx/0x89c5eed6e8af5e31650f51071cad1a32b80c60bc2413149244772e2dd0c40f46) |
| scale-equalizer-frxusd-fame | 43282547 | 2026-03-12 22:27:21.000Z | [transaction](https://base.blockscout.com/tx/0x7659316d381f035c3ba6b4f004f9b233f61d1fa47ab6e7c7517dc118daf4d3e2) |

The earliest direct pool is Uniswap V2 FAME/WETH, block **17,019,741**.
Include the creation block itself when collecting logs.

## Evidence and limitations

For eight address-based pools, Blockscout supplied a creation transaction hash;
each transaction was separately read and confirmed successful at the listed block.
Do not equate the address endpoint's `first_transaction_details` with creation:
Equalizer FAME/WETH reports November 28 there, but its creation transaction is
November 19. Uniswap V2 FAME/WETH similarly reports July 22 instead of July 13.

FAME/frxUSD had no creation hash in the address response. A bounded-address Mint
query from block 0 through 43,283,000 returned two events. Reading the earliest
transaction's complete nine-log response established:
- factory `0xEd8db60aCc29e14bC867a497D94ca6e3CeB5eC04`;
- `PairCreated`, log 510, naming the exact FAME/frxUSD pair and token addresses;
- positive `Sync`, log 515, and first `Mint`, log 516;
- block 43,282,547, March 12, 2026 at 22:27:21 UTC.

The V4 BASED FLICK/ZORA pool has no separate contract address. A PoolManager log
query filtered by both Initialize signature and exact pool ID returned its
initialization at block 33,270,814, log 845. Manager:
`0x498581ff718922c3f8e6a244956af099b2652b2b`; pool ID:
`0x0fe6333346fcd0ffa4be3fda91f271bda52c6755f604b06483b709666d363628`.
The event identifies both registry currencies, fee 30000, tick spacing 200, and
hook `0xd61a675f8a0c67a73dc3b54fb7318b4d9140904`.
Manager deployment is not pool initialization.

The four other direct creation transactions show funding to the pool; reserve
pools also show LP minting. These establish useful launch evidence, not a proof
of uninterrupted tradability thereafter. V3/V4 initialized price and token
deposits alone do not establish positive active liquidity at every price.

Before ingestion, confirm boundaries against the configured archival RPC using
creation receipts (including emitter/identity), canonical block hashes, and
historical state at launch and representative later buckets. For ordinary pools,
code absence at block n-1 and presence at n is an additional check where supported.
For V4 use Initialize and keyed state, never manager code existence.
A failed historical call must remain distinguishable from a source not yet created.

## Current route chronology

- WETH direct pools: ETH identity; USDC via Uniswap V3 WETH/USDC 5 bps.
- SCALE: SCALE/USDC, then WETH/USDC for ETH.
- frxUSD: stable USDC/frxUSD, then WETH/USDC for ETH.
- BASED FLICK: V4 BASED FLICK/ZORA, then V3 ZORA/WETH; add WETH/USDC for USDC.

Each currently selected conversion source was created before the direct pool
that needs it. That removes one obvious chronology conflict; it does not prove
historical liquidity, hook behavior, archive availability, or price quality.
Do not scan all swaps from these busy conversion pools: retain five-minute,
historical block-end state sampling.

## Evidence receipt

The accompanying JSON retains registry identities, creation transactions and the
selected log evidence. It excludes credentials and MCP session identifiers.
This investigation performed no production writes and started no backfill.
