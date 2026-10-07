import type { Header, Scope } from "./model.ts";
import { referenceBoundary } from "./reference-collector.ts";
import { deriveReference } from "./reference-rpc.ts";
import {
  referencePolicy,
  REFERENCE_VERSION,
  type ReferenceEvidence,
} from "./reference.ts";
import { failureCode } from "./failure.ts";

export interface ReferenceRefill {
  targetFrom: number;
  toTimestamp: number;
  nextTimestamp: number; // Earliest published bucket; move backward only after durable publication.
  policyRevision: string;
  upper: Header;
}
export interface ReferenceRefillStore {
  load(): Promise<ReferenceRefill>;
  commit(cursor: ReferenceRefill, evidence: ReferenceEvidence): Promise<void>;
}
/** Sequential, resumable and independent of the live collection/publication cursors. */
export async function refillReferences({
  scope,
  store,
  chain,
  sample,
  maxBuckets = 12,
  onBucket = () => {},
}: {
  scope: Scope;
  store: ReferenceRefillStore;
  chain: { header(n: number): Promise<Header> };
  sample(block: Header): Promise<ReferenceEvidence["results"]>;
  maxBuckets?: number;
  onBucket?: (e: ReferenceEvidence) => void;
}) {
  const policy = referencePolicy(scope);
  let cursor = await store.load();
  if (cursor.policyRevision !== policy.revision)
    throw Error("Reference refill policy mismatch");
  const cache = new Map<number, Header>();
  const header = async (n: number) => {
    let h = cache.get(n);
    if (!h) {
      h = await chain.header(n);
      cache.set(n, h);
    }
    return h;
  };
  const upper = await header(cursor.upper.number);
  if (upper.hash !== cursor.upper.hash)
    throw Error("Reference refill anchor changed");
  let published = 0,
    gaps = 0;
  while (cursor.nextTimestamp > cursor.targetFrom && published < maxBuckets) {
    const timestamp = cursor.nextTimestamp - 300;
    // Exponential bracketing avoids assuming Base's block interval and stays near the boundary.
    let step = 128,
      low: Header;
    do {
      low = await header(Math.max(1, cursor.upper.number - step));
      if (low.number === 1 && low.timestamp >= timestamp + 300)
        throw Error("Reference refill predates chain");
      step *= 2;
    } while (low.timestamp >= timestamp + 300);
    const boundary = await referenceBoundary(
      timestamp,
      low,
      cursor.upper,
      header,
    );
    let results: ReferenceEvidence["results"] | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        results = await sample(boundary.block);
        break;
      } catch (error) {
        // Unknown/integrity/work-limit failures stop with the checkpoint intact.
        if (failureCode(error) !== "rpc-failure" || attempt === 2) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * (attempt + 1)),
        );
      }
    }
    if (!results) throw Error("Reference sampler returned no results");
    const evidence: ReferenceEvidence = {
      version: REFERENCE_VERSION,
      scopeId: scope.id,
      policy,
      policyRevision: policy.revision,
      timestamp,
      ...boundary,
      results,
    };
    const point = deriveReference(evidence, scope);
    if (
      (await chain.header(boundary.after.number)).hash !== boundary.after.hash
    )
      throw Error("Reference refill boundary changed");
    await store.commit(cursor, evidence);
    cursor = { ...cursor, nextTimestamp: timestamp, upper: boundary.after };
    published++;
    if (
      point.values.fameUsd.status !== "available" ||
      point.values.fameEth.status !== "available"
    )
      gaps++;
    onBucket(evidence);
  }
  return {
    published,
    gaps,
    nextTimestamp: cursor.nextTimestamp,
    complete: cursor.nextTimestamp === cursor.targetFrom,
  };
}
