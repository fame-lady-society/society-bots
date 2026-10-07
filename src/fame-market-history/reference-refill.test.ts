import { refillReferences, type ReferenceRefill } from "./reference-refill.ts";
import { referenceFixture, referenceHeader } from "./reference-fixture.ts";
import { referencePolicy } from "./reference.ts";
import { deriveReference } from "./reference-rpc.ts";
import { scope, epoch } from "./worker-fixture.ts";
const initial = (): ReferenceRefill => ({
  targetFrom: epoch + 300,
  toTimestamp: epoch + 1200,
  nextTimestamp: epoch + 1200,
  policyRevision: referencePolicy(scope).revision,
  upper: referenceHeader(600),
});
function fixture() {
  let cursor = initial();
  const points: ReturnType<typeof deriveReference>[] = [];
  return {
    points,
    store: {
      load: async () => ({ ...cursor }),
      commit: async (
        c: ReferenceRefill,
        e: ReturnType<typeof referenceFixture>["evidence"],
      ) => {
        expect(c.nextTimestamp).toBe(cursor.nextTimestamp);
        points.push(deriveReference(e, scope));
        cursor = { ...cursor, nextTimestamp: e.timestamp, upper: e.after };
      },
    },
    chain: { header: async (n: number) => referenceHeader(n) },
    sample: async (block: ReturnType<typeof referenceHeader>) =>
      referenceFixture(block.timestamp - 298).evidence.results,
  };
}
test("backward batches resume independently, use real boundary state, and do not repeat", async () => {
  const f = fixture();
  expect(await refillReferences({ scope, ...f, maxBuckets: 1 })).toMatchObject({
    published: 1,
    nextTimestamp: epoch + 900,
    complete: false,
  });
  expect(await refillReferences({ scope, ...f })).toMatchObject({
    published: 2,
    nextTimestamp: epoch + 300,
    complete: true,
  });
  expect(await refillReferences({ scope, ...f })).toMatchObject({
    published: 0,
    complete: true,
  });
  expect(f.points).toHaveLength(3);
  for (const p of f.points) expect(p.values.fameUsd.status).toBe("available");
});
test("RPC failure retries then stops without turning an outage into a permanent gap", async () => {
  const f = fixture();
  let calls = 0;
  await expect(
    refillReferences({
      scope,
      ...f,
      maxBuckets: 1,
      sample: async () => {
        calls++;
        throw Error("History RPC unavailable");
      },
    }),
  ).rejects.toThrow("History RPC unavailable");
  expect(calls).toBe(3);
  expect(f.points).toHaveLength(0);
  expect((await f.store.load()).nextTimestamp).toBe(epoch + 1200);
});
test("unavailable historical contract results retain an explicit gap", async () => {
  const f = fixture();
  const out = await refillReferences({
    scope,
    ...f,
    maxBuckets: 1,
    sample: async () =>
      referenceFixture(epoch + 900, { reverts: [5, 11] }).evidence.results,
  });
  expect(out.gaps).toBe(1);
  expect(f.points[0].values.fameUsd).toMatchObject({
    value: null,
    status: "unavailable",
    reason: "source-unavailable",
  });
});
test.each(["RPC work allowance exhausted", "Malformed ABI response"])(
  "integrity/work failure stops without advancing: %s",
  async (message) => {
    const f = fixture();
    await expect(
      refillReferences({
        scope,
        ...f,
        sample: async () => {
          throw Error(message);
        },
      }),
    ).rejects.toThrow(message);
    expect((await f.store.load()).nextTimestamp).toBe(epoch + 1200);
    expect(f.points).toHaveLength(0);
  },
);
test("changed canonical anchor stops before publication", async () => {
  const f = fixture();
  await expect(
    refillReferences({
      scope,
      ...f,
      chain: {
        header: async (n) => ({
          ...referenceHeader(n),
          hash: `0x${"f".repeat(64)}`,
        }),
      },
    }),
  ).rejects.toThrow("anchor changed");
  expect(f.points).toHaveLength(0);
});
