# FAME V4 BASEDFLICK/ZORA Activation Evidence

This note defines the release evidence contract for the one-pool V4 compact quote lane.

## Scope

- Target pool: `uniswap-v4-basedflick-zora`.
- Quote lane: compact `cl-quote-v1` rows with explicit V4 identity.
- Not in scope: broad Uniswap V4 support, `uniswap-v4-usdc-eth`, `uniswap-v4-zora-eth`, stable-pool activation, or future Zora-protocol pools.

## Required Gates

The activation report treats the target as compact-quote-active only when every gate passes:

- Provenance: Zora factory evidence is `verified` and binds chain, coin, PoolKey, pool id, transaction or event source.
- Shape and hook permissions: PoolManager, StateView, PoolKey, currencies, static fee `30000`, tick spacing `200`, hook address, empty `hookData`, and decoded hook bits match the reviewed shape: `afterInitialize` and `afterSwap` only, no `beforeSwap`, no `beforeSwapReturnDelta`, and no `afterSwapReturnDelta`.
- State: `v4-cl-replay-v1` state is fresh, source-registry matched, and includes block hash, parent hash, active liquidity, bitmap summary, initialized tick summary, LP fee, and protocol fee.
- Quote: `/fame/pool-quotes` returns a target V4 `cl-quote-v1` row from `uniswap-v4-state-view`.
- Parity: focused compact quote parity passes for BASEDFLICK -> ZORA and ZORA -> BASEDFLICK representative exact-input amounts.
- Route simulation: `../fls-www` route lab proves the same requested route or selected pool leg and reports successful simulation. Missing simulation evidence blocks promotion.
- Source agreement: `society-bots` source registry id equals the `www` source registry id used by the quote adapter.
- Budget: provider read count stays within the configured activation threshold.

Any missing, stale, mismatched, or failed gate blocks activation and leaves `www` on live fallback or compact-row exclusion for this pool.

## Evidence Shape

`scripts/fame-pool-state-delta-replay-smoke.ts` accepts `v4ZoraActivation` input with:

- `status`: `pending`, `blocked`, or `active`.
- `provenanceStatus`, `shapeStatus`, `stateStatus`, `quoteStatus`, `parityStatus`, and `routeSimulationStatus`.
- `directionCoverage`, `sourceRegistryId`, `evidenceId`, `providerReadCount`, `fallbackCount`, and `unavailableReasons`.
- `deferredHardening`, currently expected to include hook source verification when source review has not been completed.

`sourceRegistryId` is the source-agreement status: it must equal the producer registry id. `providerReadCount` is the budget status: it must be present and less than or equal to the smoke threshold. Direction coverage must be exactly `BASEDFLICK->ZORA` and `ZORA->BASEDFLICK` for the v1 activation claim.

When `status` is `active`, every V4 gate must pass. The smoke report records gate details and validation errors rather than relying on hardcoded pool exclusion constants.

## Operational Logging

Lambda logs summarize V4 evidence without raw replay payloads:

- Pool-state API logs include `v4ClReplay` aggregate counts for returned, fresh, stale, bitmap words, initialized ticks, bitmap chunks, and tick chunks.
- Pool-quotes API logs include `selectedV4ZoraQuote` status and unavailable-reason counts for the target pool.
- Indexer logs include V4 replay counts, failures, provider read count, state hash, LP fee, protocol fee, and `selectedV4ZoraReplay`.
- Activation smoke evidence keeps incomplete state, stale blocks, provider-read budget, source-registry drift, missing simulation, parity evidence id, fallback counts, unavailable reasons, and maintenance repair or event-gap statuses visible as gate failures.

Logs intentionally omit `bitmapWords`, `initializedTicks`, RPC URLs, helper auth, signer material, and raw calldata-like payloads.

## FLS Validation

Use the sibling `../fls-www` checkout for promotion evidence:

```bash
BASE_RPC_URL=https://... \
FAME_POOL_API_URL=https://... \
FAME_POOL_STATE_SERVICE_TOKEN=... \
bun scripts/fame-swap-cl-replay-parity.ts \
  --pool uniswap-v4-basedflick-zora \
  --token-in 0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926 \
  --token-out 0x1111111111166b7fe7bd91427724b487980afc69 \
  --amount 1045794780078973192
```

Run the reverse direction as a separate parity target. For route evidence:

```bash
BASE_RPC_URL=https://... \
FAME_POOL_API_URL=https://... \
FAME_POOL_STATE_SERVICE_TOKEN=... \
FAME_SWAP_SIMULATION_ACCOUNT=0x... \
bun scripts/fame-swap-route-lab.ts \
  --quote-api \
  --simulate \
  --route solver-fame-basedflick-zora-usdc \
  --pool uniswap-v4-basedflick-zora \
  --token-in 0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926 \
  --token-out 0x1111111111166b7fe7bd91427724b487980afc69
```

The route-lab output must show `requestedRouteId` matching `routeArtifactId`, the selected candidate id, the selected V4 pool, quote API usage, source registry id, and route simulation status. If the selected candidate does not contain the requested target leg, route-lab fails instead of producing ambiguous release evidence.

This pass defines and validates the evidence contract. Attach the current parity and route-lab JSON rows from the next live/fork validation slice before changing production activation from `pending` to `active`.

## Deferred Hardening

Hook source or bytecode verification is intentionally deferred for this v1 lane. The activation still requires decoded hook bits, empty hook data, exact same-block compact-vs-live quote parity, and full route execution evidence before promotion.
