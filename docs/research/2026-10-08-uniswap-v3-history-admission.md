# Uniswap V3 FAME/WETH history admission

Pool: `0xeed3eff5775865229dcd0d7e0f6e89c611841202` on Base.
Registry ID: `uniswap-v3-weth-fame-30bps`. Token0 is canonical WETH
`0x4200000000000000000000000000000000000006`; token1 is FAME
`0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418`. Fee 3000 (0.30%), tick spacing 60.

## Evidence

Authenticated Blockscout Pro read on 2026-10-08, all four pages of
[the launch transaction](https://base.blockscout.com/tx/0x4bf357967b670f85ee4929953045b9e2071fb7f5d85cda08d536ae6e8e2fabc5).
V2 and V3 were created in the same block and transaction: block 17,019,741,
2024-07-13 00:00:29 UTC. V3 factory
`0x33128a8fc17869897dce68ed026d694621f6fdfd` emitted PoolCreated at log 194;
the pool emitted Initialize at 195 and Mint at 199 and 209.

The two positions contained 99,999,999.999999999999999991 and
166,399,999.999999999999994558 FAME, zero WETH. Initial tick 173460 was above
both position ranges: [173340, 173400) and [-887220, 173340). Do not describe
these balances as active liquidity at the initialized price.

Real launch bytes and the verified deployed event ABI are retained in
`src/fame-market-history/fixtures/uniswap-v3-{launch,events}.json`.
The added token-order metadata is grounded in the immutable V3 factory identity,
not a newly performed read at the metadata file's older snapshot block. Existing
WETH/FAME decimals are reused. Blockscout historical eth_call confirmed zero active liquidity and tick 173460
at the launch block. A read at block 52,337,006 returned positive active liquidity.
These checks do not verify the production archival provider or every intervening
bucket; exact large integers come from retained event bytes, not JSON numbers.

## Implementation and cost

The history registry composes the existing www-derived registry with
`src/fame-market-history/additional-pools.json`. The swap/landing authority set
remains unchanged. The compiled registry makes the sixth pool available; production resolves the
active definition, while admission scripts use the expanded registry; the three Lambda bundles include the additions.
`tracked-only` and `concentrated-liquidity` describe swap-quote capability, not
exclusion from market history: history captures all direct-pool address logs.
This does not enable a new executable swap route or a liquidity tick indexer.

History now decodes signed V3 swaps, Initialize, Mint/Burn, Collect and all four
fee/admin event layouts from the deployed ABI. Only swaps and principal Mint/Burn
become activity rows; fee collection, flash loans and administration are not
additional buy/sell/add/remove rows. Unknown events remain explicit.

The existing sampler already understands V3 slot0. The pool adds six subcalls to
the shared boundary Multicall: token order, slot0, active liquidity and two custody
balances. It reuses ETH identity and the existing WETH/USDC route. No new token
decimal reads, connector pool, oracle, tick scan or per-swap conversion read.
Actual RPC bytes/provider units and log density still require measurement.

Zero active liquidity keeps the sampled price unavailable under the current
policy even if inventory is positive. The first-day rehearsal must preserve that
state rather than fabricate an executable price or claim a complete blend.

## Rollout boundary

**Not deployed.** The sixth address changes raw scope identity and sampled
policy revision. Archives, checkpoints and publications stay under their original
identities. Production entrypoints now resolve an explicit active dataset rather
than selecting the compiled registry automatically.

Follow [the six-pool rollout runbook](2026-10-08-six-pool-rollout.md): prepare the
immutable job, register/stage a separate expanded dataset, deploy through the
operator, finish catch-up and verification, then explicitly activate it. CI
preflight rejects deployment before the active dataset definition is registered.
The old five-pool view remains selected until the conditional handoff succeeds.
The July 2024 genesis exercise remains separate from this recent-window rollout.

Tests cover launch bytes, both same-transaction liquidity rows, both swap
directions/orientations, principal vs fee events, spot prices, V3 slot0 sampling,
shared routes, six-pool totals and changed scope/revision identities.

## Validation receipt

- 442 history, pool-state/landing and operator-script tests passed (42 suites).
- Four CDK tests passed, including real collector/reader bundle imports.
- Application TypeScript check passed.
- Authenticated Blockscout creation logs, deployed ABI and selected historical
  contract reads succeeded. Production RPC, expanded publication, and frontend
  acceptance are not established by these checks.
