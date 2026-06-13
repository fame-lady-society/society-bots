import { describe, expect, test } from "@jest/globals";
import type { Address } from "viem";
import { famePoolStateRegistry } from "./registry/index.ts";
import type {
  FamePoolStateRegistryEntry,
  FamePoolStateV4ZoraProvenanceEvidence,
} from "./types.ts";
import {
  FAME_V4_ZORA_APPROVED_PROVENANCE,
  FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
  FAME_V4_ZORA_ETH_QUOTE_LANE_POOL_ID,
  FAME_V4_ZORA_ETH_REVIEWED_POOL_SHAPE,
  FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
  UNISWAP_V4_DYNAMIC_FEE_FLAG,
  classifyV4ZoraQuoteLane,
  classifyV4ZoraReviewedPoolShape,
  decodeUniswapV4HookPermissions,
  fameV4ZoraQuoteLaneStatus,
} from "./v4-zora-manifests.ts";

const VERIFIED_PROVENANCE = {
  status: "verified",
  source: "zora-factory-event",
  chainId: 8453,
  factoryAddress: "0x0000000000000000000000000000000000000001",
  coinAddress: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.currency1,
  poolKey: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolKey,
  poolId: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolKey,
  transactionHash:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  eventName: "CoinCreatedV4",
} as const satisfies FamePoolStateV4ZoraProvenanceEvidence;

function registryEntry(id: string): FamePoolStateRegistryEntry {
  const pool = famePoolStateRegistry.pools.find((entry) => entry.id === id);
  if (!pool) throw new Error(`Missing registry entry ${id}.`);
  return pool;
}

describe("FAME V4 Zora quote lane manifest", () => {
  test("reviews the target PoolKey identity and passive hook shape", () => {
    const pool = registryEntry(FAME_V4_ZORA_QUOTE_LANE_POOL_ID);
    const classification = classifyV4ZoraQuoteLane(pool, VERIFIED_PROVENANCE);
    const permissions = decodeUniswapV4HookPermissions(
      FAME_V4_ZORA_REVIEWED_POOL_SHAPE.hooks,
    );

    expect(classification.status).toBe("target-eligible");
    expect(fameV4ZoraQuoteLaneStatus(pool, VERIFIED_PROVENANCE)).toBe(
      "target-eligible",
    );
    expect(permissions).toMatchObject({
      afterInitialize: true,
      afterSwap: true,
      beforeSwap: false,
      beforeSwapReturnDelta: false,
      afterSwapReturnDelta: false,
    });
    if (classification.status !== "target-eligible") {
      throw new Error("Expected target-eligible classification.");
    }
    expect(classification.manifest.reviewedPoolShape).toMatchObject({
      poolId: FAME_V4_ZORA_QUOTE_LANE_POOL_ID,
      poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
      stateViewAddress: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
      poolKey:
        "0x0fe6333346fcd0ffa4be3fda91f271bda52c6755f604b06483b709666d363628",
      currency0: "0x1111111111166b7fe7bd91427724b487980afc69",
      currency1: "0x15e012abf9d32cd67fc6cf480ea0e318e9ed5926",
      fee: 30000,
      tickSpacing: 200,
      hooks: "0xd61a675f8a0c67a73dc3b54fb7318b4d91409040",
      hookData: "0x",
    });
  });

  test("fails closed without Zora factory provenance evidence", () => {
    const pool = registryEntry(FAME_V4_ZORA_QUOTE_LANE_POOL_ID);

    expect(classifyV4ZoraQuoteLane(pool)).toMatchObject({
      status: "target-blocked",
      reason: "missing-provenance",
    });
    expect(
      classifyV4ZoraQuoteLane(pool, {
        status: "missing",
        reason: "unit test",
      }),
    ).toMatchObject({
      status: "target-blocked",
      reason: "missing-provenance",
    });
  });

  test("accepts the operator-approved BASEDFLICK/ZORA protocol provenance", () => {
    const pool = registryEntry(FAME_V4_ZORA_QUOTE_LANE_POOL_ID);

    expect(
      classifyV4ZoraQuoteLane(pool, FAME_V4_ZORA_APPROVED_PROVENANCE),
    ).toMatchObject({
      status: "target-eligible",
      provenance: {
        source: "zora-factory-event",
        factoryAddress: "0x777777751622c0d3258f214f9df38e35bf45baf3",
        coinAddress: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.currency1,
        poolKey: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolKey,
        poolId: FAME_V4_ZORA_REVIEWED_POOL_SHAPE.poolKey,
        eventName: "OperatorApprovedZoraProtocolPool",
      },
    });
  });

  test("accepts the no-hook ZORA/ETH reviewed pool without provenance", () => {
    const pool = registryEntry(FAME_V4_ZORA_ETH_QUOTE_LANE_POOL_ID);
    const classification = classifyV4ZoraQuoteLane(pool);
    const permissions = decodeUniswapV4HookPermissions(
      FAME_V4_ZORA_ETH_REVIEWED_POOL_SHAPE.hooks,
    );

    expect(classification.status).toBe("target-eligible");
    expect(fameV4ZoraQuoteLaneStatus(pool)).toBe("target-eligible");
    expect(permissions).toMatchObject({
      afterInitialize: false,
      afterSwap: false,
      beforeSwap: false,
      beforeSwapReturnDelta: false,
      afterSwapReturnDelta: false,
    });
    if (classification.status !== "target-eligible") {
      throw new Error("Expected ZORA/ETH target-eligible classification.");
    }
    expect(classification).not.toHaveProperty("provenance");
    expect(classification.manifest).toMatchObject({
      poolId: FAME_V4_ZORA_ETH_QUOTE_LANE_POOL_ID,
      provenanceRequired: false,
      reviewedPoolShape: {
        poolId: FAME_V4_ZORA_ETH_QUOTE_LANE_POOL_ID,
        poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
        stateViewAddress: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
        poolKey:
          "0xd694bd7285eeeee19d3d5da38f613859168c422d628def88a0c95dad12071f3a",
        currency0: "0x0000000000000000000000000000000000000000",
        currency1: "0x1111111111166b7fe7bd91427724b487980afc69",
        fee: 3000,
        tickSpacing: 60,
        hooks: "0x0000000000000000000000000000000000000000",
        hookData: "0x",
      },
    });
  });

  test("keeps non-target V4 pools outside the quote lane", () => {
    expect(
      classifyV4ZoraQuoteLane(
        registryEntry("uniswap-v4-usdc-eth"),
        VERIFIED_PROVENANCE,
      ),
    ).toMatchObject({
      status: "non-target-v4-unsupported",
        reason: "non-target-v4-pool",
      });
  });

  test("rejects dynamic or mismatched V4 fees", () => {
    expect(
      classifyV4ZoraReviewedPoolShape(
        {
          ...FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
          fee: UNISWAP_V4_DYNAMIC_FEE_FLAG,
        },
        VERIFIED_PROVENANCE,
      ),
    ).toMatchObject({
      status: "target-blocked",
      reason: "dynamic-fee",
    });
    expect(
      classifyV4ZoraReviewedPoolShape(
        {
          ...FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
          fee: 3000,
        },
        VERIFIED_PROVENANCE,
      ),
    ).toMatchObject({
      status: "target-blocked",
      reason: "fee-mismatch",
    });
  });

  test("rejects non-empty hookData and unsafe swap hook permissions", () => {
    expect(
      classifyV4ZoraReviewedPoolShape(
        {
          ...FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
          hookData: "0x1234",
        },
        VERIFIED_PROVENANCE,
      ),
    ).toMatchObject({
      status: "target-blocked",
      reason: "hook-data-mismatch",
    });
    expect(
      classifyV4ZoraReviewedPoolShape(
        {
          ...FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
          hooks: "0x00000000000000000000000000000000000010c0",
        },
        VERIFIED_PROVENANCE,
      ),
    ).toMatchObject({
      status: "target-blocked",
      reason: "unsafe-hook-permissions",
      unsafeHookPermissions: ["beforeSwap"],
    });
    expect(
      classifyV4ZoraReviewedPoolShape(
        {
          ...FAME_V4_ZORA_REVIEWED_POOL_SHAPE,
          hooks: "0x0000000000000000000000000000000000001044",
        },
        VERIFIED_PROVENANCE,
      ),
    ).toMatchObject({
      status: "target-blocked",
      reason: "unsafe-hook-permissions",
      unsafeHookPermissions: ["afterSwapReturnDelta"],
    });
  });

  test("rejects ZORA/ETH shape drift without requiring BASEDFLICK provenance", () => {
    expect(
      classifyV4ZoraReviewedPoolShape({
        ...FAME_V4_ZORA_ETH_REVIEWED_POOL_SHAPE,
        fee: UNISWAP_V4_DYNAMIC_FEE_FLAG,
      }),
    ).toMatchObject({
      status: "target-blocked",
      reason: "dynamic-fee",
    });
    expect(
      classifyV4ZoraReviewedPoolShape({
        ...FAME_V4_ZORA_ETH_REVIEWED_POOL_SHAPE,
        hooks: "0x0000000000000000000000000000000000000040",
      }),
    ).toMatchObject({
      status: "target-blocked",
      reason: "hook-address-mismatch",
    });
    expect(
      classifyV4ZoraReviewedPoolShape({
        ...FAME_V4_ZORA_ETH_REVIEWED_POOL_SHAPE,
        hookData: "0x1234",
      }),
    ).toMatchObject({
      status: "target-blocked",
      reason: "hook-data-mismatch",
    });
    expect(
      classifyV4ZoraReviewedPoolShape({
        ...FAME_V4_ZORA_ETH_REVIEWED_POOL_SHAPE,
        currency0: FAME_V4_ZORA_ETH_REVIEWED_POOL_SHAPE.currency1,
        currency1: FAME_V4_ZORA_ETH_REVIEWED_POOL_SHAPE.currency0,
      }),
    ).toMatchObject({
      status: "target-blocked",
      reason: "currency0-mismatch",
    });
  });

  test("accepts registry identity regardless of address casing", () => {
    const pool = registryEntry(FAME_V4_ZORA_QUOTE_LANE_POOL_ID);
    const mixedCasePool = {
      ...pool,
      router: "0x6FF5693B99212dA76aD316178A184aB56D299B43",
      poolKey:
        "0x0FE6333346FcD0ffA4bE3fDA91F271bDa52C6755f604B06483B709666D363628",
      token0: "0x1111111111166B7fe7bd91427724B487980AfC69",
      token1: "0x15E012abF9d32CD67FC6Cf480EA0E318E9Ed5926",
      stateViewAddress: "0xA3c0C9b65BAd0b08107AA264B0F3db444B867A71",
    } satisfies FamePoolStateRegistryEntry;

    expect(
      classifyV4ZoraQuoteLane(mixedCasePool, VERIFIED_PROVENANCE),
    ).toMatchObject({
      status: "target-eligible",
    });
  });

  test("rejects registry rows that drift from the reviewed target shape", () => {
    const pool = registryEntry(FAME_V4_ZORA_QUOTE_LANE_POOL_ID);

    expect(
      classifyV4ZoraQuoteLane(
        {
          ...pool,
          poolKey:
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        },
        VERIFIED_PROVENANCE,
      ),
    ).toMatchObject({
      status: "target-blocked",
      reason: "pool-key-mismatch",
    });
    expect(
      classifyV4ZoraQuoteLane(
        {
          ...pool,
          fee: {
            status: "available",
            feeBps: 83886.08,
            label: "dynamic",
            source: "pool-metadata",
          },
        },
        VERIFIED_PROVENANCE,
      ),
    ).toMatchObject({
      status: "target-blocked",
      reason: "dynamic-fee",
    });
  });

  test("rejects provenance that does not bind the BASEDFLICK coin and PoolKey", () => {
    expect(
      classifyV4ZoraReviewedPoolShape(FAME_V4_ZORA_REVIEWED_POOL_SHAPE, {
        ...VERIFIED_PROVENANCE,
        coinAddress: "0x1111111111166b7fe7bd91427724b487980afc69",
      }),
    ).toMatchObject({
      status: "target-blocked",
      reason: "provenance-coin-mismatch",
    });
    expect(
      classifyV4ZoraReviewedPoolShape(FAME_V4_ZORA_REVIEWED_POOL_SHAPE, {
        ...VERIFIED_PROVENANCE,
        poolKey:
          "0x0000000000000000000000000000000000000000000000000000000000000002",
      }),
    ).toMatchObject({
      status: "target-blocked",
      reason: "provenance-pool-key-mismatch",
    });
  });
});
