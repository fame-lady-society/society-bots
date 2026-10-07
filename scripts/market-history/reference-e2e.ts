import assert from "node:assert/strict";
import { referenceFixture } from "../../src/fame-market-history/reference-fixture.ts";
import { referenceParquet } from "../../src/fame-market-history/reference-worker.ts";
import { deriveReference } from "../../src/fame-market-history/reference-rpc.ts";

const fixture = referenceFixture();
const point = deriveReference(fixture.evidence, fixture.scope);
assert.equal(point.values.fameUsd.value, "0.004000000000000000");
const bytes = await referenceParquet(fixture.evidence, fixture.scope);
assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), "PAR1");
console.log(
  JSON.stringify({
    event: "reference-parquet-runtime-verified",
    bytes: bytes.length,
  }),
);
