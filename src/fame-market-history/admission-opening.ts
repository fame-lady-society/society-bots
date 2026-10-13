/** Reuse only the last pre-admission observation for opening index weights. */
import { expansionPools } from "./scope-expansion.ts";
import { originsFor } from "./pool-lifecycle.ts";
import { digest, type Scope } from "./model.ts";
import {
  sampledCalls,
  sampledCallsAtBlock,
  deriveSampledObservation,
  type SampledEvidence,
} from "./sampled-rpc.ts";
import { sampledPolicy } from "./sampled-market.ts";
export function reusePreAdmissionSample(
  source: Scope,
  target: Scope,
  e: SampledEvidence,
): SampledEvidence {
  const added = expansionPools(source, target);
  const admissionOrigins = originsFor(target);
  if (
    added.pools.some(
      (p) =>
        !admissionOrigins[p.id] ||
        e.after.number >= admissionOrigins[p.id].block,
    )
  )
    throw new Error("Sample reuse crosses pool admission");
  deriveSampledObservation(source, e);
  const oldCalls = sampledCalls(source),
    active = sampledCallsAtBlock(target, e.block.number);
  const values = new Map(
    oldCalls.map((c, i) => [JSON.stringify(c), e.results[i]]),
  );
  if (active.some((c) => !values.has(JSON.stringify(c))))
    throw new Error("Missing retained sampled call");
  return {
    ...e,
    policyRevision: sampledPolicy(target).revision,
    sourceEvidence: {
      policyRevision: e.policyRevision,
      sha256: digest(JSON.stringify(e)),
    },
    results: sampledCalls(target).map(
      (c) =>
        values.get(JSON.stringify(c)) ?? { success: false, returnData: "0x" },
    ),
  };
}
