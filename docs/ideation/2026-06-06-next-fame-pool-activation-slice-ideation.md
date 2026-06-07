---
date: 2026-06-06
topic: next-fame-pool-activation-slice
focus: rank remaining FAME pool classes for indexed/compact quote support after BASEDFLICK/ZORA V4 live quote API, parity, and route-lab simulation passed
mode: repo-grounded
---

# Ideation: Next FAME Pool Activation Slice

## Grounding Context

### Codebase Context

`society-bots` owns the producer side of FAME indexed pool state and compact quote rows. `fls-www`, the local checkout of `fame-lady-society/www`, owns the pool universe, route authority, public quote behavior, and route-lab proof surface. This artifact treats `../fls-www` as read-only grounding.

The current producer registry has 21 pools:

- 7 reserve / constant-product compact quote active rows: Uniswap V2, volatile Solidly / Equalizer, and Aerodrome V2.
- 2 CL compact quote active rows: `slipstream-usdc-weth-100` and `slipstream-basedflick-fame`.
- 6 represented CL head-only rows: `slipstream-usdc-frxusd`, `slipstream-zora-usdc`, `slipstream-zora-weth`, `uniswap-v3-usdc-weth-30bps`, `uniswap-v3-usdc-weth-5bps`, `uniswap-v3-zora-usdc`, and `uniswap-v3-zora-weth`.
- 1 stable tracked-only row: `scale-equalizer-usdc-frxusd`.
- 1 native-wrap tracked-only row.
- 3 represented V4 rows still non-general: `uniswap-v4-basedflick-zora`, `uniswap-v4-usdc-eth`, and `uniswap-v4-zora-eth`.

The `fls-www` upstream pool universe has 26 pools. The producer-unrepresented or blocked set is `slipstream-spx-weth`, `slipstream-msusd-usdc-a`, `slipstream-weth-mseth`, `slipstream2-msusd-mseth`, `slipstream2-msusd-usdc-c`, and blocked `slipstream-usdc-weth-migrating-50`.

Route artifacts show the strongest current route impact:

- `slipstream-basedflick-fame` and `uniswap-v4-basedflick-zora` appear in five route artifacts.
- `uniswap-v3-zora-usdc` appears in two route artifacts, including `solver-fame-basedflick-zora-usdc`.
- `uniswap-v3-zora-weth` appears in one route artifact.
- `uniswap-v4-zora-eth` appears in two route artifacts, including the native ETH route pair `solver-eth-zora-basedflick-fame` and `solver-fame-basedflick-zora-eth`.
- `scale-equalizer-usdc-frxusd` and `slipstream-usdc-frxusd` appear together in one frxUSD split / merge route.
- The producer-unrepresented Slipstream2 pools do not appear in the current selected route artifact list.

Current live evidence carried forward from the request:

- `society-bots` has deployed V4 delta maintenance for the approved `uniswap-v4-basedflick-zora` lane.
- `fls-www` commit `ef5d3f7` fixed the route-lab simulation deadline bug.
- Live dev evidence for `solver-fame-basedflick-zora-usdc` now passes: quote API uses compact rows for `slipstream-basedflick-fame` and `uniswap-v4-basedflick-zora`, with 0 unavailable and 0 fallback.
- `route-lab --quote-api --simulate` with account `0x499e194d7a106AC1305ed4f96c6CEaAff650462D` passes with output 5 and protected minimum 4.
- `BASEDFLICK/ZORA` V4 remains narrow: the approved Zora protocol pool only, not broad V4 enablement.

### Pool-Level Quote API vs Route Solver Selection

These are separate gates:

- **Pool-level quote API can return quotes:** `/fame/pool-quotes` returns a fresh, source-registry-matched, direction-matched compact row for a pool, amount, and block context. This is necessary evidence, but it is not public route authority by itself.
- **Route solver may select this in live user swaps:** `fls-www` must mark the pool or class route-eligible, selected route-lab evidence must show the row is used without unexplained fallback, and route simulation must prove the protected executable route. This is especially important for pool classes that can quote correctly but are not currently selected, not executable, or only useful as alternatives.

### Past Learnings

Prior FLS solution notes frame indexed pool state as an optimization layer, not the source of truth. Helper reachability is not proof of indexed quoting; selected quote attribution is the proof. Normal public quote flow should use compact rows and live fallback, while raw replay state stays in route-lab, parity, and debug tooling.

### External Context

- Uniswap V3 offchain pool modeling needs slot0, active liquidity, initialized tick data, and tick bitmap reads for accurate replay. Source: https://developers.uniswap.org/docs/sdks/v3/guides/pool-data
- Uniswap V4 hooks can customize pool, swap, and fee behavior, so V4 lanes must keep hook and dynamic-fee checks explicit. Source: https://developers.uniswap.org/contracts/v4/concepts/hooks
- Aerodrome Slipstream is concentrated liquidity with tick spacing and fee behavior that should stay protocol-family explicit rather than silently inheriting every V3 assumption. Source: https://github.com/aerodrome-finance/docs/blob/main/content/liquidity.mdx

## Topic Axes

- Quote API readiness vs route solver eligibility
- Route impact and selected-path relevance
- Protocol-family math and reducer semantics
- Operational evidence and parity gates
- Class unlock leverage

## Ranked Ideas

### 1. Uniswap V3 ZORA Connector Compact Quote Lane

**Description:** Promote `uniswap-v3-zora-usdc` as the next compact CL candidate, with `uniswap-v3-zora-weth` as the paired follow-up once the V3 manifest and parity harness are proven. This targets the remaining live connector leg in the now-passing `solver-fame-basedflick-zora-usdc` family, rather than choosing a pool class only because it is easy.

**Axis:** Route impact and selected-path relevance

**Basis:** `direct:` `fls-www` route artifacts include `uniswap-v3-zora-usdc` in two route artifacts and `uniswap-v3-zora-weth` in one. The carried-forward live route uses `slipstream-basedflick-fame`, `uniswap-v4-basedflick-zora`, and `uniswap-v3-zora-usdc`; the first two now have compact quote evidence, leaving the V3 ZORA connector as the obvious remaining live leg. `external:` Uniswap V3 pool-data docs confirm exact offchain replay requires full tick and bitmap state, not only head state.

**Rationale:** This has the best direct user-swap payoff. It turns the recent BASEDFLICK/ZORA success from "two compact legs plus one live connector" toward a mostly compact route family, while keeping route selection in `fls-www`.

**Pool-level quote claim:** `/fame/pool-quotes` can return V3 `cl-quote-v1` rows for reviewed ZORA connector directions after V3 state capture and exact quote parity pass.

**Route-solver claim:** The public solver should use these rows only for route artifacts that remain selected and route-simulated, starting with `solver-fame-basedflick-zora-usdc`.

**Validation evidence needed:**

- V3 protocol-family manifest covering pool address, factory, fee, tick spacing, token orientation, events, initialized tick reads, state hash, and source registry id.
- Same-block parity against the live Uniswap V3 quoter for representative ZORA -> USDC and USDC -> ZORA amounts.
- Quote API smoke with 0 unexplained unavailable rows and 0 fallback for the targeted route amount.
- Route-lab `--quote-api --simulate` for the targeted route, with selected V3 connector source reported as compact quote.
- Delta replay smoke or equivalent activation report proving source agreement, bounded provider reads, and route-solver non-promotion for unrelated V3 pools.

**Downsides:** This is a new protocol-family reducer, not a simple Slipstream allowlist entry. It will need V3-specific event/source review and must avoid silently collapsing V3 and Slipstream semantics.

**Confidence:** 91%

**Complexity:** Medium-High

**Status:** Unexplored

### 2. Stable frxUSD Corridor Validation

**Description:** Treat `scale-equalizer-usdc-frxusd` as the first stable-curve quote slice, paired with the existing frxUSD route that also uses `slipstream-usdc-frxusd` and `scale-equalizer-frxusd-fame`. The goal is not "all stable pools." It is a narrow stable math validation lane that proves the stable reserve curve can emit compact quote rows without pretending stable is volatile constant-product math.

**Axis:** Protocol-family math and reducer semantics

**Basis:** `direct:` `scale-equalizer-usdc-frxusd` is represented as `tracked-only` with `unsupportedReason: stable-pool`, and the route artifact `solver-usdc-split-frxusd-merge-fame` uses `scale-equalizer-usdc-frxusd`, `slipstream-usdc-frxusd`, and active reserve `scale-equalizer-frxusd-fame`. `direct:` route-lab docs say Solidly stable output quotes exist, but market-impact state output remains unavailable until a stable-curve transition price source is validated.

**Rationale:** Stable is the cleanest "reserve-adjacent" unlock. It expands compact quote support without CL tick replay, but it still has real math risk because stable curves are not constant product.

**Pool-level quote claim:** `/fame/pool-quotes` can return stable quote rows for `scale-equalizer-usdc-frxusd` after exact parity with the live pool/router output and validated decimal handling.

**Route-solver claim:** The solver should not select the frxUSD split / merge route from indexed stable evidence unless route-lab shows it remains selected and route simulation passes.

**Validation evidence needed:**

- Stable-curve math review against the exact deployed Solidly/Equalizer pool behavior.
- Same-block parity for USDC -> frxUSD and frxUSD -> USDC representative amounts.
- Decimal and fee fixture coverage; stable output must not reuse volatile post-swap price calculations.
- Route-lab proof for `solver-usdc-split-frxusd-merge-fame`, separating stable compact evidence from the paired `slipstream-usdc-frxusd` live or compact evidence.

**Downsides:** Route impact is narrower than the ZORA connector lane. It also opens a new quote row kind or quote model branch, which can be more dangerous than it looks if treated as "just reserves."

**Confidence:** 84%

**Complexity:** Medium

**Status:** Unexplored

### 3. Slipstream V1 Head-Only Tranche

**Description:** Promote a small Slipstream v1 tranche from head-only into replay candidates: `slipstream-usdc-frxusd`, then `slipstream-zora-usdc` / `slipstream-zora-weth` if route-lab evidence shows they compete with the V3 ZORA connectors. This reuses the closest existing reducer family while still demanding per-pool parity and route evidence.

**Axis:** Class unlock leverage

**Basis:** `direct:` `slipstream-usdc-weth-100` and `slipstream-basedflick-fame` already use the Slipstream replay and compact `cl-quote-v1` shape. `slipstream-usdc-frxusd`, `slipstream-zora-usdc`, and `slipstream-zora-weth` are present in the producer registry as CL head-only Slipstream pools. `direct:` current route artifacts include `slipstream-usdc-frxusd` in one route, while the ZORA Slipstream pools are represented but not selected in the current artifact set.

**Rationale:** This is the lowest-friction CL class extension because the protocol family is already proven. It is a good second or parallel slice if the team wants more pool-level compact coverage with controlled math risk.

**Pool-level quote claim:** Quote API can return Slipstream compact rows for the tranche once each pool has trusted replay state and same-block parity.

**Route-solver claim:** FLS should keep these rows route-ineligible until route-lab shows the specific pool is selected or materially improves a candidate route.

**Validation evidence needed:**

- Per-pool Slipstream replay candidate rows with trusted maintenance, cursor compatibility, source registry agreement, and state hash compatibility.
- Same-block parity against live Slipstream quoter in both directions for each pool.
- Route-lab comparison against existing V3 ZORA connector and frxUSD route alternatives.
- Provider-read and tick density budget checks so adding multiple Slipstream pools does not blow up the Lambda path.

**Downsides:** It may produce technically correct pool-level quotes that public route solving rarely uses. That is useful only if the activation ledger keeps pool-level support separate from solver eligibility.

**Confidence:** 86%

**Complexity:** Medium

**Status:** Unexplored

### 4. Route-Impact Activation Heatmap Before Broadening CL

**Description:** Add a report that ranks all non-active pools by selected route count, live fallback count, compact quote request count, route-lab selection frequency, and missing execution/manifest reason. Use it as the decision gate before promoting any multi-pool CL tranche.

**Axis:** Operational evidence and parity gates

**Basis:** `direct:` current route artifact counts are uneven: the ZORA connector route has direct evidence, the frxUSD route is single-route, and producer-unrepresented Slipstream2 pools are not selected in the current artifact list. `direct:` FLS route-lab already emits selected pools, quote API diagnostics, protocol coverage, and edge matrix rows.

**Rationale:** This turns "what next?" into a measured activation queue. It reduces the risk of spending a full reducer slice on a pool that can quote but will not be selected.

**Pool-level quote claim:** None by itself; this is a prioritization and evidence artifact.

**Route-solver claim:** None by itself; it determines which pool-level quote work deserves route-solver promotion effort.

**Validation evidence needed:**

- Route-lab output or saved JSON rows for quote API mode across the FAME corpus.
- Counts for selected routes, considered/rejected edges, fallback reasons, unavailable reasons, and simulation status.
- A report row for every `cl-head-only`, `tracked-only`, `unsupported`, `producer-unrepresented`, and blocked pool.

**Downsides:** It is not a pool activation. If the team already agrees to do the V3 ZORA connector next, this report should be lightweight and not delay the slice.

**Confidence:** 88%

**Complexity:** Low-Medium

**Status:** Unexplored

### 5. Slipstream2 Gauge Caps Representation First, Compact Quotes Later

**Description:** Move Slipstream2 / Gauge Caps support forward only as representation, manifest, and head-state readiness first. Add or regenerate producer rows for `slipstream2-msusd-mseth` and `slipstream2-msusd-usdc-c`, keep them non-compact-quote-active, and prove router/quote readiness in FLS before replay support.

**Axis:** Protocol-family math and reducer semantics

**Basis:** `direct:` `fls-www` route-lab docs say Slipstream2 is enabled for the Base Gauge Caps deployment and unknown Slipstream2 deployments fail closed. `direct:` the current activation ledger marks both Slipstream2 pools producer-unrepresented and says they cannot inherit Slipstream replay support.

**Rationale:** This preserves forward momentum on the class without smuggling Slipstream v1 assumptions into Gauge Caps. It also gives future route-lab rows a concrete producer status instead of "missing."

**Pool-level quote claim:** Head-state only at first; no compact quote claim until Slipstream2 factory, fee, event, quoter, tick, and router assumptions are reviewed.

**Route-solver claim:** Route solver may use live Slipstream2 only under existing FLS readiness; indexed compact rows should remain unavailable.

**Validation evidence needed:**

- Reviewed Gauge Caps manifest: factory, pool address, router target, quoter behavior, tick spacing, fee source, event topics, and active liquidity read.
- Producer registry rows generated from FLS, not hand-curated.
- Route-lab edge matrix rows showing whether these pools are selected, considered, disabled, or missing.
- Explicit non-promotion evidence in the activation report.

**Downsides:** It does not reduce live quote reads immediately. Compact quote support should wait until route impact and protocol assumptions justify the reducer cost.

**Confidence:** 80%

**Complexity:** Medium

**Status:** Unexplored

### 6. Additional V4 Only As Another Single-Pool Pilot

**Description:** Keep additional V4 work narrow, but do not lose the `uniswap-v4-zora-eth` opportunity under the BASEDFLICK/ZORA exclusion. `uniswap-v4-zora-eth` should be treated as a plausible near-term single-pool pilot because it appears in two route artifacts and the checked-in route metadata shows a simpler no-hook V4 shape: native ETH / ZORA currencies, static 0.30% fee, tick spacing 60, zero hook address, and empty hook data.

**Axis:** Operational evidence and parity gates

**Basis:** `direct:` the V4 evidence doc excludes `uniswap-v4-zora-eth` only from the BASEDFLICK/ZORA first V4 lane; that exclusion is not a finding that ZORA/ETH is unsafe. `direct:` route artifacts include `uniswap-v4-zora-eth` in two native ETH route artifacts. `direct:` `fls-www` live adapter coverage already exercises the ZORA/ETH V4 pool key, direction, zero hook address, and empty hook data. `external:` V4 hooks can customize swap and fee behavior, so this still needs a named reviewed-pool gate rather than broad V4 enablement.

**Rationale:** This keeps the successful V4 work from turning into accidental broad enablement while acknowledging that zero-hook ZORA/ETH is a materially different risk shape from BASEDFLICK/ZORA. If the next slice prioritizes native ETH route compacting instead of the BASEDFLICK/ZORA-USDC connector, this is the V4 pool to scope.

**Pool-level quote claim:** Only for a named reviewed V4 pool after pool identity, zero-hook/static-fee shape, state, quote parity, and source-registry gates pass.

**Route-solver claim:** Route solver can select the compact V4 row only after `--quote-api --simulate` proves the route with no unexplained fallback.

**Validation evidence needed:**

- Reviewed pool identity and zero-hook shape, separate from BASEDFLICK/ZORA; the BASEDFLICK/ZORA Zora-coin provenance gate should not be inherited automatically.
- Hook permission and dynamic-fee classification.
- Same-block compact-vs-live quote parity both directions.
- Route simulation with protected minimum.
- Explicit non-promotion for all other V4 rows.

**Downsides:** It is lower-risk than hooked V4 but still opens the V4 widening path. The reviewed-pool manifest should remain named and row-scoped so `uniswap-v4-usdc-eth` or future V4 pools do not inherit support by shape similarity alone.

**Confidence:** 76%

**Complexity:** High

**Status:** Unexplored

### 7. Reserve Constant-Product as Regression Gate, Not Headline Activation

**Description:** Keep reserve / constant-product pools as the always-on regression baseline for every new activation slice. Do not spend the next pool-activation headline on reserves unless route-lab or production telemetry shows a specific reserve row is failing execution or quote attribution.

**Axis:** Quote API readiness vs route solver eligibility

**Basis:** `direct:` the registry already marks seven reserve rows as `reserve-compact-quote-active`, with `constant-product-quote-v1` fixture coverage and source-registry/freshness gates. `direct:` route-lab and indexed quote docs emphasize fallback and selected quote attribution, not helper reachability.

**Rationale:** Reserves are active or close enough to active that their best role is to guard the next slice. They should catch regressions while V3, stable, or Slipstream candidate work moves forward.

**Pool-level quote claim:** Existing reserve compact quote rows should remain green for both directions and route-relevant amount bands.

**Route-solver claim:** Solver use should stay allowed only when row metadata, source registry, freshness, amount, and route execution readiness match.

**Validation evidence needed:**

- Quote API regression showing reserve rows still return compact quotes while the new class is being tested.
- Fallback matrix for stale, missing, malformed, source mismatch, and zero-output reserve cases.
- Route-lab proof that mixed compact/live routes do not claim fully indexed context unless every selected leg is indexed.

**Downsides:** Not a new pool class. Treating this as the main next slice would avoid the real remaining frontier.

**Confidence:** 93%

**Complexity:** Low

**Status:** Explored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Broad V4 enablement | Scope overrun. Passing `uniswap-v4-basedflick-zora` proves one reviewed pool, not the V4 class. |
| 2 | Promote all Uniswap V3 pools at once | Too broad for the next slice. Start with route-relevant ZORA connector evidence, then widen after the V3 manifest is proven. |
| 3 | Immediate Slipstream2 compact quote support | Ungrounded for this slice. Current Slipstream2 pools are producer-unrepresented and not selected in current route artifacts. |
| 4 | Stable pool support via volatile constant-product math | Incorrect math boundary. Stable needs stable-curve parity, decimal handling, and its own quote model branch. |
| 5 | Producer-unrepresented pools directly to compact quotes | Skips registry and activation ledger gates. Represent them first or keep them explicitly non-promoted. |
| 6 | Unblock migrating Slipstream USDC/WETH first | The pool is explicitly blocked because migration factory and tick-spacing assumptions need review; not a strong next compact quote slice. |
| 7 | Shared generic CL reducer package before the next pool | Too much abstraction before another concrete pool proves which differences matter. |
| 8 | Quote API success equals public solver selection | Rejected as a category error. Pool-level rows and route-solver eligibility must remain separate. |
| 9 | Route simulation can replace parity | Too weak. Simulation proves executable route behavior; parity proves compact quote correctness for a pool/direction/amount. |
| 10 | Hardcoded non-promotion exclusions | Violates the current report-driven smoke direction. Non-promotion should come from activation report data. |

## Risks And Validation Evidence Needed

- **False route confidence:** A pool can quote correctly but not be selected or executable. Mitigation: every survivor has separate pool-level and route-solver claims.
- **Protocol-family bleed:** Slipstream, Slipstream2, Uniswap V3, and V4 all share CL ideas but not identical identity, event, fee, hook, or router semantics. Mitigation: protocol-family manifests before compact promotion.
- **Stable math error:** The stable pool is tempting because it is reserve-like, but it is not volatile constant product. Mitigation: exact stable-curve parity against deployed pool behavior.
- **Operational read budget:** Adding tick replay pools can increase provider reads and DynamoDB chunk work. Mitigation: provider-read threshold, tick density metrics, and route-bounded activation bundles.
- **Production activation drift:** Local code may show a row as pending or unsupported while live dev has quote evidence. Mitigation: activation artifacts must record the exact source registry id, evidence id, route-lab output, parity output, and deployment context before flipping route-solver eligibility.

## Recommended Next Brainstorm Topic

Brainstorm the **Uniswap V3 ZORA connector compact quote lane**.

Seed question: "What exactly must land for `uniswap-v3-zora-usdc` to become a pool-level compact quote source, and what extra gates allow `solver-fame-basedflick-zora-usdc` to use it in live user swaps?"

The brainstorm should explicitly define:

- V3 manifest shape and state capsule requirements.
- Exact same-block parity cases and amount bands.
- Quote API row shape, evidence id, and unavailable reasons.
- Route-lab `--quote-api --simulate` proof for the selected route.
- Activation ledger status transitions that distinguish pool-level quoteability from route-solver eligibility.
