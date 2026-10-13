/** Read-only launch-bucket qualification; no archive or publication writes. */
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { fullScope } from "../../src/fame-market-history/full-scope.ts";
import { originsFor } from "../../src/fame-market-history/pool-lifecycle.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { referenceBoundary } from "../../src/fame-market-history/reference-collector.ts";
import {
  sampledReader,
  deriveSampledObservation,
} from "../../src/fame-market-history/sampled-rpc.ts";
import { sampledMarketBucket } from "../../src/fame-market-history/sampled-market.ts";
const ssm = new SSMClient({ region: "us-west-1", maxAttempts: 1 });
try {
  const secret = await ssm.send(
    new GetParameterCommand({
      Name: "/society-bots/market-history/base-rpc",
      WithDecryption: true,
    }),
  );
  if (!secret.Parameter?.Value) throw new Error("Missing candidate RPC");
  const scope = fullScope(),
    origins = originsFor(scope);
  const rpc = boundedTransport({
    url: secret.Parameter.Value,
    maxRequests: 150,
    maxResponseBytes: 1024 * 1024,
    deadline: Date.now() + 180000,
  });
  const chain = chainReader(scope, rpc.transport, 1),
    sample = sampledReader(scope, rpc.transport);
  const proof = [];
  for (const id of [
    "scale-equalizer-weth-fame",
    "scale-equalizer-scale-fame",
    "slipstream-basedflick-fame",
    "scale-equalizer-frxusd-fame",
  ]) {
    const o = origins[id],
      t = Math.floor(o.timestamp / 300) * 300;
    const boundary = await referenceBoundary(
      t,
      await chain.header(o.block - 160),
      await chain.header(o.block + 160),
      chain.header,
    );
    const e = await sample(t, boundary.block, boundary.after),
      observation = deriveSampledObservation(scope, e);
    const prices = Object.fromEntries(
      (["ETH", "USDC"] as const).map((c) => [
        c,
        sampledMarketBucket(scope, c, t, observation, []).series.find(
          (p) => p.poolId === id,
        )?.price,
      ]),
    );
    proof.push({
      id,
      creationBlock: o.block,
      bucket: t,
      sampleBlock: boundary.block.number,
      prices,
      rates: observation.rates,
    });
  }
  console.log(
    JSON.stringify({ proof, metrics: rpc.metrics, awsWrites: 0 }, null, 2),
  );
} finally {
  ssm.destroy();
}
