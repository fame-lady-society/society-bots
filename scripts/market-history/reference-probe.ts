/** Read-only source qualification. Never archives or publishes production state. */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { fameHistoryRegistry } from "../../src/fame-market-history/registry.ts";
import { historyScope } from "../../src/fame-market-history/model.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { valuationReader } from "../../src/fame-market-history/valuation-rpc.ts";
import {
  referenceReader,
  deriveReference,
} from "../../src/fame-market-history/reference-rpc.ts";
import {
  referencePolicy,
  REFERENCE_VERSION,
} from "../../src/fame-market-history/reference.ts";
import { referenceBoundary } from "../../src/fame-market-history/reference-collector.ts";
const ssm = new SSMClient({ region: "us-west-1", maxAttempts: 1 });
let stage = "credentials";
try {
  const result = await ssm.send(
    new GetParameterCommand({
      Name: "/society-bots/market-history/base-rpc",
      WithDecryption: true,
    }),
  );
  if (!result.Parameter?.Value) throw new Error("No RPC");
  const scope = historyScope(fameHistoryRegistry),
    policy = referencePolicy(scope);
  const rpc = boundedTransport({
    url: result.Parameter.Value,
    maxRequests: 40,
    maxResponseBytes: 256 * 1024,
    deadline: Date.now() + 90000,
  });
  stage = "chain-read";
  const chain = chainReader(scope, rpc.transport, 1),
    head = await chain.finalized();
  const timestamp = Math.floor(head.timestamp / 300) * 300 - 300;
  const boundary = await referenceBoundary(
    timestamp,
    await chain.header(head.number - 1000),
    head,
    (n) => chain.header(n),
  );
  stage = "reference-read";
  const before = rpc.metrics.requests;
  const results = await referenceReader(scope, rpc.transport)(boundary.block);
  stage = "derivation";
  const point = deriveReference(
    {
      version: REFERENCE_VERSION,
      scopeId: scope.id,
      policy,
      policyRevision: policy.revision,
      timestamp,
      ...boundary,
      results,
    },
    scope,
  );
  const referenceRequests = rpc.metrics.requests - before;
  stage = "comparison";
  const comparison = await valuationReader(
    scope,
    rpc.transport,
  )(boundary.block);
  const poolPrices = scope.pools.map((p) => {
    const state = comparison.pools[p.id],
      quote =
        p.token0 === "0xf307e242bfe1ec1ff01a4cef2fdaa81b10a52418"
          ? p.token1
          : p.token0;
    const fx = comparison.quotes[quote];
    return {
      poolId: p.id,
      fameEthX18:
        state && fx
          ? (
              (BigInt(state.quotePerFameX18) * BigInt(fx.ethX18)) /
              10n ** 18n
            ).toString()
          : null,
      balance0: state?.balance0,
      balance1: state?.balance1,
    };
  });
  console.log(
    JSON.stringify(
      {
        event: "reference-source-probe",
        timestamp,
        point,
        referenceRequests,
        subcalls: results.length,
        metrics: rpc.metrics,
        poolPrices,
      },
      null,
      2,
    ),
  );
} catch {
  console.error(JSON.stringify({ event: "reference-probe-failed", stage }));
  process.exitCode = 1;
} finally {
  ssm.destroy();
}
