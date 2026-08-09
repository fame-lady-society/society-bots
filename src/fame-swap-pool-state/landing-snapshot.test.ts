import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  FAME_LANDING_QUOTE_DEFINITION_IDS,
  parseFameLandingAuthority,
  parseFameLandingSnapshot,
} from "./landing-snapshot.ts";
import { famePoolStateRegistry } from "./registry/index.ts";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

describe("FAME landing snapshot contract", () => {
  test("accepts the generated authority and capability-honest golden snapshot", () => {
    const authority = parseFameLandingAuthority(
      fixture("fame-landing-defi-authority-v1.json"),
      famePoolStateRegistry,
    );
    const snapshot = parseFameLandingSnapshot(
      fixture("fame-landing-defi-snapshot-v1.json"),
      authority,
    );

    expect(authority.quoteDefinitions.map(({ id }) => id)).toEqual(
      FAME_LANDING_QUOTE_DEFINITION_IDS,
    );
    expect(snapshot.provenance.safeBlockNumber).toBe(45_884_844);
    expect(Object.values(snapshot.fields.quotes)).toHaveLength(6);
    expect(snapshot.fields.quotes.defiBuyUsdc).toEqual({
      status: "unavailable",
      reason: "captured-state-missing",
    });
  });

  test("rejects values and invented routes outside the capability matrix", () => {
    const authority = parseFameLandingAuthority(
      fixture("fame-landing-defi-authority-v1.json"),
      famePoolStateRegistry,
    );
    const disabledValue = structuredClone(
      fixture("fame-landing-defi-snapshot-v1.json"),
    ) as Record<string, unknown>;
    const disabledFields = disabledValue.fields as Record<string, unknown>;
    const disabledQuotes = disabledFields.quotes as Record<string, unknown>;
    disabledQuotes.defiBuyUsdc = {
      status: "available",
      value: {
        amount: "1",
        quoteDefinitionId: "defi-buy-usdc-v1",
        routeId: "invented-usdc-route",
      },
    };
    expect(() => parseFameLandingSnapshot(disabledValue, authority)).toThrow(
      /capability requires captured-state-missing/u,
    );

    const inventedRoute = structuredClone(
      fixture("fame-landing-defi-snapshot-v1.json"),
    ) as Record<string, unknown>;
    const inventedFields = inventedRoute.fields as Record<string, unknown>;
    const inventedQuotes = inventedFields.quotes as Record<string, unknown>;
    const ethBuy = inventedQuotes.defiBuyEth as Record<string, unknown>;
    const ethBuyValue = ethBuy.value as Record<string, unknown>;
    ethBuyValue.routeId = "invented-eth-route";
    expect(() => parseFameLandingSnapshot(inventedRoute, authority)).toThrow(
      /route id is not in the enabled capability matrix/u,
    );
  });

  test("rejects connector pools as direct FAME liquidity", () => {
    const raw = fixture("fame-landing-defi-authority-v1.json") as Record<
      string,
      unknown
    >;
    const directLiquidityPoolIds = raw.directLiquidityPoolIds as string[];
    raw.directLiquidityPoolIds = [
      ...directLiquidityPoolIds,
      "aerodrome-v2-usdc-weth",
    ];

    expect(() => parseFameLandingAuthority(raw, famePoolStateRegistry)).toThrow(
      /direct FAME pool/u,
    );
  });

  test("rejects source and evaluator capability mismatches", () => {
    const sourceMismatch = structuredClone(
      fixture("fame-landing-defi-authority-v1.json"),
    ) as Record<string, unknown>;
    sourceMismatch.sourceRegistryId = "wrong-registry";
    expect(() =>
      parseFameLandingAuthority(sourceMismatch, famePoolStateRegistry),
    ).toThrow(/source registry/u);

    const capabilityMismatch = structuredClone(
      fixture("fame-landing-defi-authority-v1.json"),
    ) as Record<string, unknown>;
    const capabilities = capabilityMismatch.capabilities as Array<
      Record<string, unknown>
    >;
    const usdc = capabilities.find(
      ({ quoteDefinitionId }) => quoteDefinitionId === "defi-buy-usdc-v1",
    );
    if (!usdc) throw new Error("Missing USDC capability fixture.");
    usdc.status = "enabled";
    delete usdc.reason;
    usdc.evaluator = "constant-product-captured-reserves-v1";
    usdc.routeTemplates = [
      {
        id: "invalid-connector-template",
        allocations: [
          { poolId: "aerodrome-v2-usdc-weth", allocationBps: 10_000 },
        ],
      },
    ];
    expect(() =>
      parseFameLandingAuthority(capabilityMismatch, famePoolStateRegistry),
    ).toThrow(/captured-state evaluator/u);
  });

  test("rejects malformed decimals and duplicate counter assets", () => {
    const authority = parseFameLandingAuthority(
      fixture("fame-landing-defi-authority-v1.json"),
      famePoolStateRegistry,
    );
    const malformed = structuredClone(
      fixture("fame-landing-defi-snapshot-v1.json"),
    ) as Record<string, unknown>;
    const fields = malformed.fields as Record<string, unknown>;
    const liquidity = fields.liquidity as Record<string, unknown>;
    const value = liquidity.value as Record<string, unknown>;
    value.fameAmount = "01";
    expect(() => parseFameLandingSnapshot(malformed, authority)).toThrow(
      /canonical decimal/u,
    );

    const duplicate = structuredClone(
      fixture("fame-landing-defi-snapshot-v1.json"),
    ) as Record<string, unknown>;
    const duplicateFields = duplicate.fields as Record<string, unknown>;
    const duplicateLiquidity = duplicateFields.liquidity as Record<
      string,
      unknown
    >;
    const duplicateValue = duplicateLiquidity.value as Record<string, unknown>;
    const counterAssets = duplicateValue.counterAssets as unknown[];
    duplicateValue.counterAssets = [...counterAssets, counterAssets[0]];
    expect(() => parseFameLandingSnapshot(duplicate, authority)).toThrow(
      /duplicate counter asset/u,
    );
  });
});
