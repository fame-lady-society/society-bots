import { describe, expect, test } from "@jest/globals";
import {
  buildFameDeltaReplaySmokeReport,
  type FameDeltaReplaySmokeInput,
} from "./fame-pool-state-delta-replay-smoke.ts";

const SELECTED_POOL_ID = "slipstream-basedflick-fame";
const LIVE_DEPENDENCY_POOL_ID = "uniswap-v4-basedflick-zora";
const BASELINE_CL_POOL_ID = "slipstream-usdc-weth-100";

type ActivationReport = NonNullable<
  FameDeltaReplaySmokeInput["activationReport"]
>;
type ActivationRow = ActivationReport["upstreamPools"][number];

const ACTIVATION_ROWS: ActivationRow[] = [
  activeReserve("aerodrome-v2-usdc-weth"),
  activeReserve("scale-equalizer-frxusd-fame"),
  activeReserve("scale-equalizer-scale-fame"),
  row("scale-equalizer-usdc-frxusd", "tracked-only", "present", "none"),
  activeReserve("scale-equalizer-usdc-scale"),
  activeReserve("scale-equalizer-weth-fame"),
  {
    ...row(
      SELECTED_POOL_ID,
      "cl-compact-quote-active",
      "present",
      "cl-compact-quote",
    ),
    selectedCandidate: true,
    liveRouteDependencies: [LIVE_DEPENDENCY_POOL_ID],
  },
  unrepresented("slipstream-msusd-usdc-a"),
  unrepresented("slipstream-spx-weth"),
  row("slipstream-usdc-frxusd", "cl-head-only", "present", "none"),
  row(
    BASELINE_CL_POOL_ID,
    "cl-compact-quote-active",
    "present",
    "cl-compact-quote",
  ),
  row(
    "slipstream-usdc-weth-migrating-50",
    "blocked",
    "producer-unrepresented",
    "none",
  ),
  unrepresented("slipstream-weth-mseth"),
  row("slipstream-zora-usdc", "cl-head-only", "present", "none"),
  row("slipstream-zora-weth", "cl-head-only", "present", "none"),
  unrepresented("slipstream2-msusd-mseth"),
  unrepresented("slipstream2-msusd-usdc-c"),
  activeReserve("uniswap-v2-fame-direct"),
  activeReserve("uniswap-v2-usdc-weth"),
  row("uniswap-v3-usdc-weth-30bps", "cl-head-only", "present", "none"),
  row("uniswap-v3-usdc-weth-5bps", "cl-head-only", "present", "none"),
  row("uniswap-v3-zora-usdc", "cl-head-only", "present", "none"),
  row("uniswap-v3-zora-weth", "cl-head-only", "present", "none"),
  {
    ...row(LIVE_DEPENDENCY_POOL_ID, "unsupported", "present", "none"),
    liveRouteDependency: true,
  },
  row("uniswap-v4-usdc-eth", "unsupported", "present", "none"),
  row("uniswap-v4-zora-eth", "unsupported", "present", "none"),
];

function row(
  poolId: string,
  activationStatus: ActivationRow["activationStatus"],
  producerRegistryPresence: NonNullable<
    ActivationRow["producerRegistryPresence"]
  >,
  consumerQuoteCapability: NonNullable<
    ActivationRow["consumerQuoteCapability"]
  >,
): ActivationRow {
  return {
    poolId,
    activationStatus,
    producerRegistryPresence,
    consumerQuoteCapability,
    producerRegistryEntry:
      producerRegistryPresence === "present" ? { activationStatus } : null,
  };
}

function activeReserve(poolId: string): ActivationRow {
  return row(
    poolId,
    "reserve-compact-quote-active",
    "present",
    "reserve-compact-quote",
  );
}

function unrepresented(poolId: string): ActivationRow {
  return row(
    poolId,
    "producer-unrepresented",
    "producer-unrepresented",
    "none",
  );
}

function statusCounts(
  rows: readonly ActivationRow[],
): NonNullable<ActivationReport["statusCounts"]> {
  return rows.reduce<NonNullable<ActivationReport["statusCounts"]>>(
    (counts, activation) => ({
      ...counts,
      [activation.activationStatus]:
        (counts[activation.activationStatus] ?? 0) + 1,
    }),
    {
      "reserve-compact-quote-active": 0,
      "cl-compact-quote-active": 0,
      "cl-replay-candidate": 0,
      "cl-head-only": 0,
      "tracked-only": 0,
      blocked: 0,
      unsupported: 0,
      "producer-unrepresented": 0,
    },
  );
}

function activationReport(
  rows: readonly ActivationRow[] = ACTIVATION_ROWS,
): ActivationReport {
  return {
    status: "generated-reviewed-activation",
    selectedCandidatePoolId: SELECTED_POOL_ID,
    liveRouteDependencyPoolId: LIVE_DEPENDENCY_POOL_ID,
    upstreamPoolCount: rows.length,
    upstreamPools: rows,
    statusCounts: statusCounts(rows),
  };
}

function mutableRouteLabRows(input: FameDeltaReplaySmokeInput) {
  if (!Array.isArray(input.routeLab)) {
    throw new Error("Expected routeLab rows array.");
  }
  return input.routeLab;
}

function trustedActivationInput(
  overrides: Partial<FameDeltaReplaySmokeInput> = {},
): FameDeltaReplaySmokeInput {
  return {
    indexer: {
      sourceRegistryId: "pool-state-registry-v4:unit",
      observedThroughBlock: 123,
      clReplaySnapshots: 0,
      clReplayMetrics: [
        {
          poolId: SELECTED_POOL_ID,
          bitmapWordCount: 2,
          initializedTickCount: 3,
          bitmapChunkCount: 1,
          tickChunkCount: 1,
          providerReadCount: 75,
          durationMs: 42,
          stateHash:
            "0x1111111111111111111111111111111111111111111111111111111111111111",
        },
      ],
      clReplayMaintenanceMetrics: [
        {
          poolId: SELECTED_POOL_ID,
          status: "trusted",
          reason: null,
          fromBlock: 120,
          toBlock: 123,
          scannedLogCount: 2,
          appliedEventCount: 2,
          candidateWritten: true,
          stateHash:
            "0x2222222222222222222222222222222222222222222222222222222222222222",
        },
      ],
    },
    quoteResponse: {
      sourceRegistryId: "pool-state-registry-v4:unit",
      currentBlock: 123,
      producerMaxFreshnessBlocks: 120,
      effectiveMaxFreshnessBlocks: 120,
      quotes: [
        {
          status: "quoted",
          quoteKind: "cl-quote-v1",
          poolId: SELECTED_POOL_ID,
          chainId: 8453,
          poolAddress: "0xbd7e5bb5a6251f6dde2cf56afa50ed0c8b4c2cdb",
          token0: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
          token1: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
          tokenIn: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
          tokenOut: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
          venueFamily: "Slipstream",
          tickSpacing: 2000,
          amountIn: "1000",
          amountOut: "990",
          sqrtPriceX96: "1000000000000000000000000000",
          sqrtPriceX96After: "999000000000000000000000000",
          tick: 1,
          liquidity: "1000000",
          fee: "10000",
          feeSource: "pool-fee",
          observedThroughBlock: 123,
          blockHash:
            "0x3333333333333333333333333333333333333333333333333333333333333333",
          parentHash:
            "0x4444444444444444444444444444444444444444444444444444444444444444",
          snapshotId: "candidate-123",
          stateHash:
            "0x2222222222222222222222222222222222222222222222222222222222222222",
          source: "slipstream-pool-state",
          sourceRegistryId: "pool-state-registry-v4:unit",
          maxFreshnessBlocks: 120,
        },
        {
          status: "unavailable",
          requested: {
            poolId: LIVE_DEPENDENCY_POOL_ID,
            tokenIn: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
            tokenOut: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
            amountIn: "1000",
          },
          reason: "unsupported-pool",
          poolId: LIVE_DEPENDENCY_POOL_ID,
        },
      ],
    },
    routeLab: [
      {
        id: "basedflick-zora-smoke",
        mode: "indexed",
        status: "ready",
        requestedRouteId: "solver-fame-basedflick-zora-weth",
        routeArtifactId: "solver-fame-basedflick-zora-weth",
        selectedPools: [SELECTED_POOL_ID, LIVE_DEPENDENCY_POOL_ID],
        selectedQuoteSources: [
          {
            poolId: SELECTED_POOL_ID,
            source: "raw-replay-indexed",
            tokenIn: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
            tokenOut: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
            amountIn: "1000",
          },
          { poolId: LIVE_DEPENDENCY_POOL_ID, source: "live" },
        ],
        selectedActivation: {
          selectedPoolId: SELECTED_POOL_ID,
          liveDependencyPoolId: LIVE_DEPENDENCY_POOL_ID,
          selectedPoolSource: "raw-replay-indexed",
          liveDependencySource: "live",
          outcome: "raw_replay_with_live_dependency",
        },
        indexedPoolState: {
          sourceRegistryId: "pool-state-registry-v4:unit",
          currentBlock: 123,
          effectiveMaxFreshnessBlocks: 120,
        },
      },
    ],
    activationReport: activationReport(),
    ...overrides,
  };
}

describe("FAME delta replay smoke report", () => {
  test("summarizes maintenance, provider pressure, and quote fallback evidence", () => {
    const report = buildFameDeltaReplaySmokeReport({
      indexer: {
        sourceRegistryId: "pool-state-registry-v4:unit",
        observedThroughBlock: 123,
        clReplaySnapshots: 1,
        clReplayMetrics: [
          {
            poolId: "slipstream-usdc-weth-100",
            bitmapWordCount: 2,
            initializedTickCount: 3,
            bitmapChunkCount: 1,
            tickChunkCount: 1,
            providerReadCount: 75,
            durationMs: 42,
            stateHash:
              "0x1111111111111111111111111111111111111111111111111111111111111111",
          },
        ],
        clReplayMaintenanceMetrics: [
          {
            poolId: "slipstream-usdc-weth-100",
            status: "warming",
            reason:
              'raw response body {"authorization":"Bearer unit-secret"} https://rpc.example',
            fromBlock: 120,
            toBlock: 123,
            scannedLogCount: 2,
            appliedEventCount: 2,
            candidateWritten: true,
            stateHash:
              "0x2222222222222222222222222222222222222222222222222222222222222222",
          },
        ],
      },
      quoteResponse: {
        sourceRegistryId: "pool-state-registry-v4:unit",
        currentBlock: 123,
        producerMaxFreshnessBlocks: 120,
        effectiveMaxFreshnessBlocks: 120,
        quotes: [
          {
            status: "unavailable",
            requested: {
              poolId: "slipstream-usdc-weth-100",
              tokenIn: "0x0000000000000000000000000000000000000001",
              tokenOut: "0x0000000000000000000000000000000000000002",
              amountIn: "1000",
            },
            reason: "producer-untrusted",
            poolId: "slipstream-usdc-weth-100",
          },
        ],
      },
    });

    expect(report).toEqual(
      expect.objectContaining({
        sourceRegistryId: "pool-state-registry-v4:unit",
        observedThroughBlock: 123,
        replaySnapshotCount: 1,
        providerReadCount: 75,
        maintenance: [
          {
            poolId: "slipstream-usdc-weth-100",
            status: "warming",
            reason: "redacted-reason",
            fromBlock: 120,
            toBlock: 123,
            scannedLogCount: 2,
            appliedEventCount: 2,
            candidateWritten: true,
            stateHash:
              "0x2222222222222222222222222222222222222222222222222222222222222222",
          },
        ],
        quote: {
          quoted: 0,
          unavailable: 1,
          unavailableReasons: {
            "producer-untrusted": 1,
          },
          quotedByKind: {},
          quotedByPoolId: {},
          unavailableByPoolId: {
            "slipstream-usdc-weth-100": 1,
          },
        },
        activationEvidence: expect.objectContaining({
          status: "blocked",
          validationErrors: expect.arrayContaining([
            "Missing activation report baseline validation.",
            "Route lab did not prove selected indexed leg with live V4 dependency.",
          ]),
        }),
      }),
    );
    expect(JSON.stringify(report)).not.toContain("https://");
    expect(JSON.stringify(report)).not.toContain("Bearer");
    expect(JSON.stringify(report)).not.toContain("unit-secret");
    expect(JSON.stringify(report)).not.toContain("rpc.example");
    expect(JSON.stringify(report)).not.toContain("eth_getLogs");
  });

  test("builds a reviewable activation evidence bundle for the selected route lane", () => {
    const report = buildFameDeltaReplaySmokeReport(trustedActivationInput());

    expect(report.activationEvidence.status).toBe("ready");
    expect(report.activationEvidence.validationErrors).toEqual([]);
    expect(report.activationEvidence.selectedCandidate).toMatchObject({
      poolId: SELECTED_POOL_ID,
      reviewedActivationStatus: "cl-compact-quote-active",
      producerRegistryActivationStatus: "cl-compact-quote-active",
      consumerQuoteCapability: "cl-compact-quote",
      maintenanceStatus: "trusted",
      candidateWritten: true,
      providerReadCount: 75,
      compactQuoteUsedCount: 1,
    });
    expect(report.activationEvidence.routeDependency).toMatchObject({
      routeLabRowId: "basedflick-zora-smoke",
      requestedRouteId: "solver-fame-basedflick-zora-weth",
      routeArtifactId: "solver-fame-basedflick-zora-weth",
      selectedPoolSource: "raw-replay-indexed",
      liveDependencySource: "live",
      selectedPoolQuote: {
        tokenIn: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
        tokenOut: "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
        amountIn: "1000",
      },
      outcome: "raw_replay_with_live_dependency",
      selectedRoutePresent: true,
    });
    expect(report.activationEvidence.baseline).toEqual({
      baselineCompactClPoolIds: ["slipstream-usdc-weth-100"],
      compactClPoolIdsWithSelected: [
        SELECTED_POOL_ID,
        "slipstream-usdc-weth-100",
      ],
      additionalCompactClPoolIds: [SELECTED_POOL_ID],
      exactlyOneAdditionalPoolClaim: true,
    });
    expect(report.activationEvidence.nonPromotion).toMatchObject({
      blockedPoolIds: ["slipstream-usdc-weth-migrating-50"],
      producerUnrepresentedPoolIds: [
        "slipstream-msusd-usdc-a",
        "slipstream-spx-weth",
        "slipstream-weth-mseth",
        "slipstream2-msusd-mseth",
        "slipstream2-msusd-usdc-c",
      ],
      trackedOnlyPoolIds: ["scale-equalizer-usdc-frxusd"],
      unsupportedPoolIds: [
        LIVE_DEPENDENCY_POOL_ID,
        "uniswap-v4-usdc-eth",
        "uniswap-v4-zora-eth",
      ],
    });
    expect(
      report.activationEvidence.operatorGates.every((gate) => gate.passed),
    ).toBe(true);
  });

  test("derives non-promotion groups from the activation report without named pool gates", () => {
    const mutableRows = ACTIVATION_ROWS.map((entry) => {
      if (
        entry.poolId === "scale-equalizer-usdc-frxusd" ||
        entry.poolId === "slipstream2-msusd-mseth" ||
        entry.poolId === "slipstream2-msusd-usdc-c" ||
        entry.poolId === LIVE_DEPENDENCY_POOL_ID ||
        entry.poolId === "uniswap-v4-usdc-eth" ||
        entry.poolId === "uniswap-v4-zora-eth"
      ) {
        return {
          ...row(entry.poolId, "cl-head-only", "present", "none"),
          ...(entry.poolId === LIVE_DEPENDENCY_POOL_ID
            ? { liveRouteDependency: true }
            : {}),
        };
      }
      if (entry.poolId === "slipstream-usdc-weth-migrating-50") {
        return unrepresented(entry.poolId);
      }
      return entry;
    });

    const report = buildFameDeltaReplaySmokeReport(
      trustedActivationInput({
        activationReport: activationReport(mutableRows),
      }),
    );

    expect(report.activationEvidence.status).toBe("ready");
    expect(report.activationEvidence.validationErrors).toEqual([]);
    expect(report.activationEvidence.nonPromotion.trackedOnlyPoolIds).toEqual(
      [],
    );
    expect(report.activationEvidence.nonPromotion.unsupportedPoolIds).toEqual(
      [],
    );
    expect(report.activationEvidence.nonPromotion.blockedPoolIds).toEqual([]);
    expect(
      report.activationEvidence.nonPromotion.producerUnrepresentedPoolIds,
    ).toEqual(
      expect.arrayContaining(["slipstream-usdc-weth-migrating-50"]),
    );
    expect(report.activationEvidence.nonPromotion.clHeadOnlyPoolIds).toEqual(
      expect.arrayContaining([
        "scale-equalizer-usdc-frxusd",
        "slipstream2-msusd-mseth",
        "slipstream2-msusd-usdc-c",
        LIVE_DEPENDENCY_POOL_ID,
        "uniswap-v4-usdc-eth",
        "uniswap-v4-zora-eth",
      ]),
    );
  });

  test("fails activation evidence when route lab no longer selects the V4-dependent lane", () => {
    const report = buildFameDeltaReplaySmokeReport(
      trustedActivationInput({
        routeLab: [
          {
            id: "other-route",
            mode: "indexed",
            status: "ready",
            selectedPools: ["uniswap-v2-fame-direct"],
            selectedQuoteSources: [
              { poolId: "uniswap-v2-fame-direct", source: "indexed" },
            ],
            selectedActivation: null,
          },
        ],
      }),
    );

    expect(report.activationEvidence.status).toBe("blocked");
    expect(report.activationEvidence.validationErrors).toContain(
      "Route lab did not prove selected indexed leg with live V4 dependency.",
    );
    expect(report.activationEvidence.selectedCandidate).toMatchObject({
      poolId: SELECTED_POOL_ID,
      maintenanceStatus: "trusted",
      candidateWritten: true,
    });
  });

  test("fails activation evidence when provider reads exceed the configured gate", () => {
    const report = buildFameDeltaReplaySmokeReport(
      trustedActivationInput({ providerReadThreshold: 10 }),
    );

    expect(report.activationEvidence.status).toBe("blocked");
    expect(report.activationEvidence.validationErrors).toContain(
      "Provider reads 75 exceed threshold 10.",
    );
    expect(
      report.activationEvidence.operatorGates.find(
        (gate) => gate.name === "provider_reads_within_threshold",
      ),
    ).toMatchObject({ passed: false, detail: "75 <= 10" });
  });

  test("fails activation evidence when selected provider reads are missing", () => {
    const input = trustedActivationInput();
    input.indexer.clReplayMetrics = [];

    const report = buildFameDeltaReplaySmokeReport(input);

    expect(report.activationEvidence.status).toBe("blocked");
    expect(report.activationEvidence.validationErrors).toContain(
      `Missing provider-read metric for ${SELECTED_POOL_ID}.`,
    );
  });

  test("fails activation evidence when another CL pool is compact active", () => {
    const input = trustedActivationInput();
    input.activationReport = activationReport([
      ...ACTIVATION_ROWS.filter(
        (entry) => entry.poolId !== "uniswap-v3-usdc-weth-5bps",
      ),
      row(
        "uniswap-v3-usdc-weth-5bps",
        "cl-compact-quote-active",
        "present",
        "cl-compact-quote",
      ),
    ]);

    const report = buildFameDeltaReplaySmokeReport(input);

    expect(report.activationEvidence.status).toBe("blocked");
    expect(report.activationEvidence.validationErrors).toContain(
      "Baseline validation must show exactly one additional compact CL pool claim.",
    );
  });

  test("requires compact quote evidence to match the selected leg amount", () => {
    const input = trustedActivationInput();
    const quoted = input.quoteResponse?.quotes[0];
    if (quoted?.status === "quoted") {
      quoted.amountIn = "999";
    }

    const report = buildFameDeltaReplaySmokeReport(input);

    expect(report.activationEvidence.status).toBe("blocked");
    expect(report.activationEvidence.validationErrors).toContain(
      `Quote API did not return a matching compact quote for ${SELECTED_POOL_ID}.`,
    );
  });

  test("fails activation evidence for incomplete or duplicate activation reports", () => {
    const missing = trustedActivationInput({
      activationReport: activationReport(ACTIVATION_ROWS.slice(0, -1)),
    });
    missing.activationReport!.upstreamPoolCount = 26;
    const duplicate = trustedActivationInput({
      activationReport: activationReport([
        ...ACTIVATION_ROWS,
        ACTIVATION_ROWS[0]!,
      ]),
    });

    const missingReport = buildFameDeltaReplaySmokeReport(missing);
    const duplicateReport = buildFameDeltaReplaySmokeReport(duplicate);

    expect(missingReport.activationEvidence.status).toBe("blocked");
    expect(missingReport.activationEvidence.validationErrors).toContain(
      "Activation report row count 25 does not match upstreamPoolCount 26.",
    );
    expect(duplicateReport.activationEvidence.status).toBe("blocked");
    expect(duplicateReport.activationEvidence.validationErrors).toContain(
      "Duplicate activation report row for aerodrome-v2-usdc-weth.",
    );
  });

  test("blocks activation evidence when activation report swaps in an unknown pool", () => {
    const swappedRows = ACTIVATION_ROWS.map((entry) =>
      entry.poolId === "aerodrome-v2-usdc-weth"
        ? { ...entry, poolId: "unit-fake-pool" }
        : entry,
    );
    const report = buildFameDeltaReplaySmokeReport(
      trustedActivationInput({
        activationReport: activationReport(swappedRows),
      }),
    );

    expect(report.activationEvidence.status).toBe("blocked");
    expect(report.activationEvidence.validationErrors).toContain(
      "Activation report pool universe mismatch: missing aerodrome-v2-usdc-weth; extra unit-fake-pool.",
    );
  });

  test("blocks activation evidence for unknown activation report statuses", () => {
    const input = trustedActivationInput({
      activationReport: {
        ...activationReport(),
        upstreamPools: [
          {
            ...ACTIVATION_ROWS[0]!,
            activationStatus:
              "surprise-status" as ActivationRow["activationStatus"],
          },
        ],
      },
    });

    const report = buildFameDeltaReplaySmokeReport(input);

    expect(report.activationEvidence.status).toBe("blocked");
    expect(report.activationEvidence.validationErrors).toContain(
      "Activation report row for aerodrome-v2-usdc-weth has unknown activation status surprise-status.",
    );
  });

  test("fails activation evidence when route identity is missing or mismatched", () => {
    for (const routeFields of [
      { routeArtifactId: null },
      { routeArtifactId: "solver-fame-other-route" },
    ]) {
      const input = trustedActivationInput();
      const routeLab = mutableRouteLabRows(input);
      routeLab[0] = {
        ...routeLab[0]!,
        ...routeFields,
      };

      const report = buildFameDeltaReplaySmokeReport(input);

      expect(report.activationEvidence.status).toBe("blocked");
      expect(report.activationEvidence.validationErrors).toEqual(
        expect.arrayContaining([
          routeFields.routeArtifactId === null
            ? "Route lab evidence must include a route artifact id."
            : "Route lab requested route must match selected route artifact.",
        ]),
      );
    }
  });

  test("fails activation evidence when the live V4 dependency is not live", () => {
    const input = trustedActivationInput();
    const routeLab = mutableRouteLabRows(input);
    routeLab[0] = {
      ...routeLab[0]!,
      selectedQuoteSources: [
        routeLab[0]!.selectedQuoteSources[0]!,
        { poolId: LIVE_DEPENDENCY_POOL_ID, source: "snapshot" },
      ],
      selectedActivation: {
        selectedPoolId: SELECTED_POOL_ID,
        liveDependencyPoolId: LIVE_DEPENDENCY_POOL_ID,
        selectedPoolSource: "raw-replay-indexed",
        liveDependencySource: "snapshot",
        outcome: "raw_replay_with_live_dependency",
      },
    };

    const report = buildFameDeltaReplaySmokeReport(input);

    expect(report.activationEvidence.status).toBe("blocked");
    expect(report.activationEvidence.validationErrors).toContain(
      "Route lab did not prove selected indexed leg with live V4 dependency.",
    );
  });

  test.each<["tokenIn" | "tokenOut" | "poolId" | "quoteKind", string]>([
    ["tokenIn", "0x0000000000000000000000000000000000000001"],
    ["tokenOut", "0x0000000000000000000000000000000000000002"],
    ["poolId", BASELINE_CL_POOL_ID],
    ["quoteKind", "constant-product-quote-v1"],
  ])(
    "requires compact quote evidence to match selected leg %s",
    (field, value) => {
      const input = trustedActivationInput();
      const quoted = input.quoteResponse?.quotes[0];
      if (quoted?.status === "quoted") {
        Object.assign(quoted, { [field]: value });
      }

      const report = buildFameDeltaReplaySmokeReport(input);

      expect(report.activationEvidence.status).toBe("blocked");
      expect(report.activationEvidence.validationErrors).toContain(
        `Quote API did not return a matching compact quote for ${SELECTED_POOL_ID}.`,
      );
    },
  );
});
