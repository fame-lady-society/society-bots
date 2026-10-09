import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handler } from "./index.mjs";
const json = (name) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const tokenMetadata = json("./token-metadata.json");
const pools = [
  ...json("./base-v1-pools.json").pools,
  ...json("./additional-pools.json"),
].filter((p) =>
  [p.token0.toLowerCase(), p.token1.toLowerCase()].includes(
    "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418",
  ),
);

assert.equal(typeof handler, "function");
assert.equal(tokenMetadata.chainId, 8453);
assert.deepEqual(
  Object.keys(tokenMetadata.poolTokens).sort(),
  pools.map((p) => p.id).sort(),
);
await assert.rejects(
  handler({}, { getRemainingTimeInMillis: () => 120000 }),
  /Missing history storage configuration/,
);
await Promise.all([import("./e2e.mjs"), import("./reference-e2e.mjs")]);
