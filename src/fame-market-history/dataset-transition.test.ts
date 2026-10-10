import { dataset, decodeDataset } from "./dataset.ts";
import {
  validateExpansion,
  validateHandoff,
  type ExpansionJob,
  type HandoffProof,
} from "./dataset-transition.ts";
import { digest, historyScope } from "./model.ts";
import { scope, metadata, epoch } from "./worker-fixture.ts";
import { sampledPolicy } from "./sampled-market.ts";
import { sampledHeader } from "./sampled-fixture.ts";
import type { SampledPublication } from "./sampled-live.ts";
const source = historyScope({
  ...scope.registry,
  pools: scope.registry.pools.filter(
    (p) => p.id !== "uniswap-v3-weth-fame-30bps",
  ),
});
export const transitionFixture = () => {
  const job: ExpansionJob = {
    version: "fame-scope-expansion-v1",
    tableArn: "arn:aws:dynamodb:us-west-1:590183914614:table/history",
    bucket: "history-archive",
    source: dataset(source, metadata),
    target: dataset(scope, metadata),
    startBlock: 100,
    sampleStart: epoch,
    anchor: sampledHeader(100),
  };
  const publication = (revision: string, count = 288): SampledPublication => {
    const body = {
      version: "fame-sampled-publication-v1" as const,
      policyRevision: revision,
      startTimestamp: epoch,
      nextTimestamp: epoch + count * 300,
      pages: Array.from({ length: count }, (_, i) => ({
        timestamp: epoch + i * 300,
        ETH: "a".repeat(64),
        USDC: "b".repeat(64),
      })),
    };
    return { ...body, generation: digest(JSON.stringify(body)) };
  };
  const proof: HandoffProof = {
    sourceCursor: {
      startBlock: 100,
      nextBlock: 500,
      previousHash: sampledHeader(499).hash,
    },
    targetCursor: {
      startBlock: 100,
      nextBlock: 500,
      previousHash: sampledHeader(499).hash,
    },
    sourcePublication: publication(sampledPolicy(source).revision),
    targetPublication: publication(sampledPolicy(scope).revision),
    sampledNext: epoch + 288 * 300,
    aggregatedNext: 500,
  };
  return { job, proof, publication };
};
test("dataset definitions validate immutable identity and metadata", () => {
  const { job } = transitionFixture();
  expect(decodeDataset(job.source).scope.pools).toHaveLength(5);
  expect(decodeDataset(job.target).scope.pools).toHaveLength(6);
  expect(() => decodeDataset({ ...job.target, scopeId: source.id })).toThrow(
    "scope mismatch",
  );
  expect(() =>
    decodeDataset({ ...job.target, definition: job.target.definition + " " }),
  ).toThrow("corrupt");
  expect(() => decodeDataset({})).toThrow("prepare");
});
test("expansion requires immutable resources and an anchor before sample end", () => {
  const { job } = transitionFixture();
  expect(validateExpansion(job).added.pools).toHaveLength(1);
  expect(() => validateExpansion({ ...job, sampleStart: epoch + 1 })).toThrow(
    "sampling boundary",
  );
  expect(() => validateExpansion({ ...job, tableArn: "wrong" })).toThrow(
    "resource identity",
  );
});
test("handoff requires full publication, complete raw catch-up and aggregation catch-up", () => {
  const { job, proof, publication } = transitionFixture();
  expect(() => validateHandoff(job, proof)).not.toThrow();
  expect(() =>
    validateHandoff(job, {
      ...proof,
      targetCursor: { ...proof.targetCursor, nextBlock: 499 },
    }),
  ).toThrow("exactly catch");
  expect(() =>
    validateHandoff(job, {
      ...proof,
      targetCursor: {
        ...proof.targetCursor,
        previousHash: sampledHeader(1).hash,
      },
    }),
  ).toThrow("exactly catch");
  expect(() => validateHandoff(job, { ...proof, aggregatedNext: 499 })).toThrow(
    "aggregation",
  );
  expect(() => validateHandoff(job, { ...proof, sampledNext: epoch })).toThrow(
    "full day",
  );
  expect(() =>
    validateHandoff(job, {
      ...proof,
      targetPublication: publication(sampledPolicy(scope).revision, 287),
    }),
  ).toThrow("full day");
});
