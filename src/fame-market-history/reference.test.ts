import { jest } from "@jest/globals";
import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  type Hex,
} from "viem";
import { deriveReference, referenceReader } from "./reference-rpc.ts";
import { referenceFixture, referenceHeader } from "./reference-fixture.ts";
import {
  referencePolicy,
  referenceProgress,
  publicReference,
  type ReferenceEvidence,
} from "./reference.ts";
import {
  referenceBoundary,
  collectReferences,
  type ReferenceCursor,
} from "./reference-collector.ts";
import { referenceParquet, publishReferences } from "./reference-worker.ts";
import { readReferences, referenceAt } from "./reference-api.ts";
import { scope, epoch } from "./worker-fixture.ts";
import type { ReferenceStore } from "./reference-storage.ts";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

test("on-chain reference reprices without a single execution and never assumes USDC equals USD", () => {
  const a = referenceFixture(),
    b = referenceFixture(epoch + 600, {
      oraclePrice: 2100n * 10n ** 8n,
      sqrtPrice: 2n ** 95n,
    });
  const x = deriveReference(a.evidence, a.scope),
    y = deriveReference(b.evidence, b.scope);
  expect(x.values.fameEth.value).toBe("0.000002000000000000");
  expect(x.values.ethUsd.value).toBe("2000.000000000000000000");
  expect(x.values.fameUsd.value).toBe("0.004000000000000000");
  expect(x.values.ethUsdc.value).toBe("1000000000000.000000000000000000");
  expect(y.values.fameEth).toEqual(x.values.fameEth);
  expect(y.values.fameUsd.value).toBe("0.004200000000000000");
  expect(y.values.ethUsdc.value).toBe("250000000000.000000000000000000");
});
test("both pool orientations preserve units and source identity", () => {
  for (const reverse of [false, true]) {
    const f = referenceFixture(epoch + 300, { reverse });
    const p = deriveReference(f.evidence, f.scope);
    expect(p.values.fameEth.value).toBe("0.000002000000000000");
    expect(p.values.ethUsdc.value).toBe("1000000000000.000000000000000000");
  }
});
test("stale oracle preserves FAME/ETH and USDC; failed FAME preserves ETH", () => {
  const f = referenceFixture(epoch + 300, { oracleAge: 1900 });
  const p = deriveReference(f.evidence, f.scope);
  expect(p.values.ethUsd.reason).toBe("stale-source");
  expect(p.values.fameUsd.value).toBeNull();
  expect(p.values.fameUsdc.status).toBe("available");
  const g = referenceFixture(epoch + 300, { reverts: [5] });
  const q = deriveReference(g.evidence, g.scope);
  expect(q.values.fameEth.value).toBeNull();
  expect(q.values.ethUsd.status).toBe("available");
  expect(q.values.ethUsdc.status).toBe("available");
});
test("archive source/policy mismatch and malformed successful ABI results fail", () => {
  const f = referenceFixture();
  expect(() =>
    deriveReference({ ...f.evidence, policyRevision: "a".repeat(64) }, f.scope),
  ).toThrow();
  f.evidence.results[0] = { success: true, returnData: "0x" };
  expect(() => deriveReference(f.evidence, f.scope)).toThrow();
});
test("one pinned Multicall contains 12 unique reads; outer RPC failure propagates", async () => {
  const f = referenceFixture();
  let requests = 0;
  const read = referenceReader(
    f.scope,
    custom(
      {
        request: async ({ method, params }) => {
          requests++;
          expect(method).toBe("eth_call");
          const [tx, tag] = params as [{ data: Hex }, string];
          expect(tag).toBe("0x" + f.evidence.block.number.toString(16));
          const call = decodeFunctionData({
            abi: multicall3Abi,
            data: tx.data,
          });
          expect(call.functionName).toBe("aggregate3");
          const calls = (
            call.args as readonly [
              readonly { target: string; callData: string }[],
            ]
          )[0];
          expect(calls).toHaveLength(12);
          expect(new Set(calls.map((c) => c.target + c.callData)).size).toBe(
            12,
          );
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: [f.evidence.results] as never,
          });
        },
      },
      { retryCount: 0 },
    ),
  );
  expect(await read(f.evidence.block)).toEqual(f.evidence.results);
  expect(requests).toBe(1);
  await expect(
    referenceReader(
      f.scope,
      custom(
        {
          request: async () => {
            throw new Error("transport");
          },
        },
        { retryCount: 0 },
      ),
    )(f.evidence.block),
  ).rejects.toThrow();
});
test("boundary search selects predecessor, not the block on the boundary", async () => {
  const calls: number[] = [];
  const result = await referenceBoundary(
    epoch + 300,
    referenceHeader(1),
    referenceHeader(600),
    async (n) => {
      calls.push(n);
      return referenceHeader(n);
    },
  );
  expect(result.block.number).toBe(299);
  expect(result.after.number).toBe(300);
  expect(calls.length).toBeLessThan(12);
});
test("nonmonotonic headers or changed boundary hashes fail", async () => {
  await expect(
    referenceBoundary(
      epoch + 300,
      referenceHeader(1),
      referenceHeader(600),
      async (n) => ({ ...referenceHeader(n), timestamp: epoch }),
    ),
  ).rejects.toThrow();
});
test("one day collects all 288 boundaries and resume after lost commit response skips nothing", async () => {
  const revision = referencePolicy(scope).revision;
  let cursor: ReferenceCursor = {
    startTimestamp: epoch + 300,
    nextTimestamp: epoch + 300,
    policyRevision: revision,
    anchor: referenceHeader(1),
  };
  const evidence: ReferenceEvidence[] = [];
  let loseResponse = true;
  const store = {
    cursor: async () => cursor,
    commit: async (c: ReferenceCursor, e: ReferenceEvidence) => {
      expect(c.nextTimestamp).toBe(cursor.nextTimestamp);
      evidence.push(e);
      cursor = { ...cursor, nextTimestamp: e.timestamp + 300, anchor: e.block };
      if (loseResponse) {
        loseResponse = false;
        throw new Error("lost response");
      }
    },
  };
  const chain = {
    header: async (n: number) => referenceHeader(n),
    finalized: async () => referenceHeader(43350),
  };
  const sample = async (block: ReturnType<typeof referenceHeader>) =>
    referenceFixture(Math.floor(block.timestamp / 300) * 300).evidence.results;
  await expect(
    collectReferences({ scope, store, chain, sample, maxBuckets: 288 }),
  ).rejects.toThrow("lost response");
  await collectReferences({ scope, store, chain, sample, maxBuckets: 288 });
  expect(evidence).toHaveLength(288);
  expect(new Set(evidence.map((e) => e.timestamp)).size).toBe(288);
  expect(cursor.nextTimestamp).toBe(epoch + 300 + 86400);
});
test("failed sample leaves progress retryable and open bucket is not sampled", async () => {
  const revision = referencePolicy(scope).revision;
  const cursor = {
    startTimestamp: epoch + 300,
    nextTimestamp: epoch + 300,
    policyRevision: revision,
    anchor: referenceHeader(1),
  };
  const commit = jest.fn<() => Promise<void>>();
  const store = { cursor: async () => cursor, commit };
  await expect(
    collectReferences({
      scope,
      store,
      chain: {
        header: async (n) => referenceHeader(n),
        finalized: async () => referenceHeader(400),
      },
      sample: async () => {
        throw new Error("RPC");
      },
    }),
  ).rejects.toThrow("RPC");
  expect(commit).not.toHaveBeenCalled();
  expect(
    await collectReferences({
      scope,
      store,
      chain: {
        header: async (n) => referenceHeader(n),
        finalized: async () => referenceHeader(299),
      },
      sample: async () => {
        throw new Error("must not run");
      },
    }),
  ).toMatchObject({ collected: 0 });
});
test("real Parquet rebuild retains exact reference evidence", async () => {
  const f = referenceFixture();
  expect((await referenceParquet(f.evidence, f.scope)).length).toBeGreaterThan(
    100,
  );
});
test("publication resumes from durable checkpoint after lost response", async () => {
  const f = referenceFixture(),
    start = f.evidence.timestamp,
    policyRevision = f.evidence.policyRevision;
  let next = start,
    lost = true;
  const store = {
    progress: async (stage: string) => ({
      startTimestamp: start,
      nextTimestamp: stage === "collected" ? start + 300 : next,
      policyRevision,
    }),
    read: async () => f.evidence,
    upload: async () => {},
    publish: async () => {
      next += 300;
      if (lost) {
        lost = false;
        throw new Error("lost");
      }
    },
  } as unknown as ReferenceStore;
  await expect(publishReferences(f.scope, store)).rejects.toThrow("lost");
  expect(await publishReferences(f.scope, store)).toMatchObject({
    published: 0,
  });
});
test("reference reader distinguishes absent history and pending work, strips artifact fields", async () => {
  const f = referenceFixture(),
    p = deriveReference(f.evidence, f.scope),
    t = f.evidence.timestamp;
  const progress = {
    startTimestamp: t,
    nextTimestamp: t + 300,
    policyRevision: p.policyRevision!,
  };
  const db = {
    send: async () => ({
      Items: [
        {
          pk: `reference-prices:${scope.id}`,
          sk: String(t).padStart(16, "0"),
          timestamp: t,
          ...p,
          artifact: "secret",
        },
      ],
    }),
  } as unknown as DynamoDBDocumentClient;
  const rows = await readReferences(
    db,
    "table",
    scope.id,
    progress,
    t,
    t + 600,
    AbortSignal.timeout(1000),
  );
  expect(referenceAt(t, progress, rows)).toEqual(p);
  expect(JSON.stringify([...rows.values()])).not.toContain("secret");
  expect(referenceAt(t - 300, progress, rows).values.fameUsd.reason).toBe(
    "before-reference-start",
  );
  expect(referenceAt(t + 300, progress, rows).values.fameUsd.reason).toBe(
    "not-yet-published",
  );
  await expect(
    readReferences(
      {
        send: async () => ({ Items: [] }),
      } as unknown as DynamoDBDocumentClient,
      "table",
      scope.id,
      progress,
      t,
      t + 300,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow("coverage gap");
  expect(() =>
    referenceProgress(
      { ...progress, nextTimestamp: t + 1 },
      progress.policyRevision,
    ),
  ).toThrow();
  expect(() =>
    publicReference({ ...p, sampledBlockHash: "bad" }, p.policyRevision!),
  ).toThrow();
});

test("empty or invalid pool state makes only its dependent prices unavailable", () => {
  const fame = referenceFixture(epoch + 300, { fameReserve: 0n });
  const p = deriveReference(fame.evidence, fame.scope);
  expect(p.values.fameEth.value).toBeNull();
  expect(p.values.ethUsd.status).toBe("available");
  for (const options of [{ activeLiquidity: 0n }, { sqrtPrice: 1n }]) {
    const f = referenceFixture(epoch + 300, options);
    const q = deriveReference(f.evidence, f.scope);
    expect(q.values.ethUsdc.value).toBeNull();
    expect(q.values.fameUsdc.value).toBeNull();
    expect(q.values.fameUsd.status).toBe("available");
  }
});
test("a proven chain gap cannot turn an old block into a fresh reference", () => {
  const f = referenceFixture();
  f.evidence.block.timestamp -= 2000;
  const p = deriveReference(f.evidence, f.scope);
  expect(
    Object.values(p.values).every(
      (v) => v.value === null && v.reason === "stale-source",
    ),
  ).toBe(true);
});

test("activation records the next full bucket and does not fill the partial one", async () => {
  const head = referenceHeader(151); // Two seconds into a bucket.
  const expected = Math.ceil(head.timestamp / 300) * 300;
  const cursor = jest.fn(async (initial: ReferenceCursor) => initial);
  const commit = jest.fn<() => Promise<void>>();
  const sample = jest.fn<() => Promise<ReferenceEvidence["results"]>>();
  const result = await collectReferences({
    scope,
    store: { cursor, commit },
    chain: { finalized: async () => head, header: async () => head },
    sample,
  });
  expect(cursor.mock.calls[0][0]).toMatchObject({
    startTimestamp: expected,
    nextTimestamp: expected,
    anchor: head,
  });
  expect(result.collected).toBe(0);
  expect(sample).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});
