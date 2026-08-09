import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import {
  FAME_LANDING_QUOTE_DEFINITION_IDS,
  parseFameLandingAuthority,
  parseFameLandingSnapshot,
} from "./landing-snapshot.ts";
import { famePoolStateRegistry } from "./registry/index.ts";
import type { FamePoolStateRegistryFile } from "./types.ts";

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
      status: "available",
      value: {
        amount: "250000000",
        quoteDefinitionId: "defi-buy-usdc-v1",
        routeId:
          "solver-single_path-aerodrome-v2-usdc-weth--scale-equalizer-weth-fame",
      },
    });
  });

  test("rejects values and invented routes outside the capability matrix", () => {
    const authority = parseFameLandingAuthority(
      fixture("fame-landing-defi-authority-v1.json"),
      famePoolStateRegistry,
    );
    const wrongRoute = structuredClone(
      fixture("fame-landing-defi-snapshot-v1.json"),
    ) as Record<string, unknown>;
    const wrongRouteFields = wrongRoute.fields as Record<string, unknown>;
    const wrongRouteQuotes = wrongRouteFields.quotes as Record<string, unknown>;
    const usdcBuy = wrongRouteQuotes.defiBuyUsdc as Record<string, unknown>;
    const usdcBuyValue = usdcBuy.value as Record<string, unknown>;
    usdcBuyValue.routeId = "invented-usdc-route";
    expect(() => parseFameLandingSnapshot(wrongRoute, authority)).toThrow(
      /route id is not in the enabled capability matrix/u,
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

  test("rejects malformed fixed runtime route templates", () => {
    const mutations: Array<{
      name: string;
      mutate(template: Record<string, unknown>): void;
    }> = [
      {
        name: "noncanonical id",
        mutate(template) {
          template.id = "invented-runtime-route";
        },
      },
      {
        name: "duplicate legs",
        mutate(template) {
          template.legs = ["aerodrome-v2-usdc-weth", "aerodrome-v2-usdc-weth"];
        },
      },
      {
        name: "disconnected order",
        mutate(template) {
          template.legs = [
            "scale-equalizer-weth-fame",
            "aerodrome-v2-usdc-weth",
          ];
          template.id =
            "solver-single_path-scale-equalizer-weth-fame--aerodrome-v2-usdc-weth";
        },
      },
      {
        name: "stable connector",
        mutate(template) {
          template.legs = [
            "scale-equalizer-usdc-frxusd",
            "scale-equalizer-weth-fame",
          ];
          template.id =
            "solver-single_path-scale-equalizer-usdc-frxusd--scale-equalizer-weth-fame";
        },
      },
    ];

    for (const { name, mutate } of mutations) {
      const raw = structuredClone(
        fixture("fame-landing-defi-authority-v1.json"),
      ) as Record<string, unknown>;
      const capabilities = raw.capabilities as Array<Record<string, unknown>>;
      const capability = capabilities.find(
        ({ quoteDefinitionId }) => quoteDefinitionId === "defi-buy-usdc-v1",
      );
      const template = (
        capability?.routeTemplates as Array<Record<string, unknown>>
      )?.[0];
      if (!template) throw new Error(`Missing ${name} route fixture.`);
      mutate(template);
      expect(() =>
        parseFameLandingAuthority(raw, famePoolStateRegistry),
      ).toThrow(/runtime route|runtime evaluator|fixed route topology/u);
    }
  });

  test("requires exactly one tracked-only runtime pool per fixed route", () => {
    const registry = structuredClone(
      famePoolStateRegistry,
    ) as FamePoolStateRegistryFile;
    const index = registry.pools.findIndex(
      ({ id }) => id === "scale-equalizer-weth-fame",
    );
    const direct = registry.pools[index];
    if (!direct) throw new Error("Missing direct WETH/FAME fixture.");
    registry.pools[index] = {
      ...direct,
      capability: "tracked-only",
      stateSurface: null,
      quoteModel: null,
    };

    expect(() =>
      parseFameLandingAuthority(
        fixture("fame-landing-defi-authority-v1.json"),
        registry,
      ),
    ).toThrow(/exactly one runtime pool/u);
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
