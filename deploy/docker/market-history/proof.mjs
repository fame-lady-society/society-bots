import assert from "node:assert/strict";
import { handler, tokenMetadata } from "./index.mjs";

assert.equal(typeof handler, "function");
assert.equal(tokenMetadata.chainId, 8453);
assert.equal(Object.keys(tokenMetadata.poolTokens).length, 5);
await assert.rejects(
  handler({}, { getRemainingTimeInMillis: () => 120000 }),
  /Missing history storage configuration/,
);
await Promise.all([import("./e2e.mjs"), import("./reference-e2e.mjs")]);
