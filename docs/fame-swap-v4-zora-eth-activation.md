# FAME V4 ZORA/ETH Activation Evidence

This note defines the release evidence contract for the reviewed no-hook ZORA/ETH Uniswap V4 compact quote lane.

## Scope

- Target pool: `uniswap-v4-zora-eth`.
- PoolKey: `0xd694bd7285eeeee19d3d5da38f613859168c422d628def88a0c95dad12071f3a`.
- Quote lane: compact `cl-quote-v1` rows with explicit reviewed-pool evidence.
- Not in scope: broad Uniswap V4 support, `uniswap-v4-usdc-eth`, V3 ZORA/USDC activation, stable-pool activation, Slipstream2, gauge caps, or public route-solver eligibility without route-lab simulation evidence.

## Reviewed Shape

The reviewed manifest binds:

- Chain: Base `8453`.
- PoolManager: `0x498581ff718922c3f8e6a244956af099b2652b2b`.
- StateView: `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71`.
- Currency0: native ETH zero address `0x0000000000000000000000000000000000000000`.
- Currency1: ZORA `0x1111111111166b7fe7bd91427724b487980afc69`.
- Static fee: `3000`.
- Tick spacing: `60`.
- Hooks: zero address.
- Hook data: `0x`.

Zora factory provenance is not required for this lane. Instead, rows must carry `reviewedPoolEvidence` with `source: "reviewed-v4-manifest"`, `kind: "zero-hook-static-fee"`, `manifestVersion: 1`, the exact PoolKey, static fee, zero hook address, empty hook data, and `protocolFeeStatus: "zero"`.

## Required Gates

Pool-level quote API support is present only when these gates pass:

- Shape: PoolManager, StateView, PoolKey, currencies, static fee, tick spacing, hook address, and hook data match the reviewed manifest.
- State: `v4-cl-replay-v1` state is fresh, source-registry matched, and includes block hash, parent hash, active liquidity, bitmap summary, initialized tick summary, LP fee, and protocol fee.
- Quote: `/fame/pool-quotes` returns ZORA/ETH V4 `cl-quote-v1` rows from `uniswap-v4-state-view`.
- Parity: focused compact quote parity passes for ETH -> ZORA and ZORA -> ETH at route-relevant amounts.
- Source agreement: `society-bots` source registry id equals the `www` source registry id used by the quote adapter.
- Budget: provider read count stays within the configured activation threshold.

Route-solver eligibility is separate. Native ETH routes may select this compact row in live user swaps only after `../fls-www` route-lab `--quote-api --simulate` passes for the exact route artifacts and records selected pools, compact quote usage, unavailable count, fallback count, simulated output, and protected minimum.

## FLS Validation

Use the sibling `../fls-www` checkout for parity and route evidence:

```bash
BASE_RPC_URL=https://... \
FAME_POOL_API_URL=https://... \
FAME_POOL_STATE_SERVICE_TOKEN=... \
bun scripts/fame-swap-cl-replay-parity.ts \
  --pool uniswap-v4-zora-eth \
  --token-in 0x0000000000000000000000000000000000000000 \
  --token-out 0x1111111111166b7fe7bd91427724b487980afc69 \
  --amount 1000000000000000
```

Run the reverse direction as a separate parity target. For route evidence, run both native route artifacts:

```bash
BASE_RPC_URL=https://... \
FAME_POOL_API_URL=https://... \
FAME_POOL_STATE_SERVICE_TOKEN=... \
FAME_SWAP_SIMULATION_ACCOUNT=0x499e194d7a106AC1305ed4f96c6CEaAff650462D \
bun scripts/fame-swap-route-lab.ts \
  --quote-api \
  --simulate \
  --route solver-eth-zora-basedflick-fame \
  --pool uniswap-v4-zora-eth
```

```bash
BASE_RPC_URL=https://... \
FAME_POOL_API_URL=https://... \
FAME_POOL_STATE_SERVICE_TOKEN=... \
FAME_SWAP_SIMULATION_ACCOUNT=0x499e194d7a106AC1305ed4f96c6CEaAff650462D \
bun scripts/fame-swap-route-lab.ts \
  --quote-api \
  --simulate \
  --route solver-fame-basedflick-zora-eth \
  --pool uniswap-v4-zora-eth
```

The route-lab output must not be used to claim generic V4 enablement. It proves only the named route, selected pool set, quote API row attribution, and simulation result captured in that run.

## Current Release Claim

This implementation adds the reviewed manifest, producer quote API admission, and `www` consumer validation for pool-level compact quotes. It does not by itself flip public route-solver eligibility. Attach fresh live parity and quote-api simulation rows before moving this lane from pool-level support to route-selected support.
