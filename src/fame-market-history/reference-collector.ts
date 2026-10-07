import type { Header, Scope } from "./model.ts";
import {
  referencePolicy,
  REFERENCE_VERSION,
  type ReferenceEvidence,
  type ReferenceProgress,
} from "./reference.ts";
export interface ReferenceCursor extends ReferenceProgress {
  anchor: Header;
}
export interface ReferenceCollectionStore {
  cursor(initial: ReferenceCursor): Promise<ReferenceCursor>;
  commit(cursor: ReferenceCursor, evidence: ReferenceEvidence): Promise<void>;
}
/** Header search is cached by the caller across buckets; the successor proves closure. */
export async function referenceBoundary(
  timestamp: number,
  low: Header,
  high: Header,
  header: (n: number) => Promise<Header>,
) {
  const end = timestamp + 300;
  if (low.timestamp >= end || high.timestamp < end || low.number >= high.number)
    throw new Error("Reference search not bracketed");
  while (high.number - low.number > 1) {
    const number = Math.floor((low.number + high.number) / 2);
    const mid = await header(number);
    if (
      mid.number !== number ||
      mid.timestamp <= low.timestamp ||
      mid.timestamp >= high.timestamp
    )
      throw new Error("Nonmonotonic reference headers");
    if (mid.timestamp < end) low = mid;
    else high = mid;
  }
  if (high.parentHash !== low.hash)
    throw new Error("Reference canonical boundary changed");
  return { block: low, after: high };
}
export async function collectReferences({
  scope,
  store,
  chain,
  sample,
  maxBuckets = 4,
  canContinue = () => true,
}: {
  scope: Scope;
  store: ReferenceCollectionStore;
  chain: { finalized(): Promise<Header>; header(n: number): Promise<Header> };
  sample(block: Header): Promise<ReferenceEvidence["results"]>;
  maxBuckets?: number;
  canContinue?: () => boolean;
}) {
  const policy = referencePolicy(scope),
    head = await chain.finalized();
  const startTimestamp = Math.ceil(head.timestamp / 300) * 300;
  let cursor = await store.cursor({
    startTimestamp,
    nextTimestamp: startTimestamp,
    policyRevision: policy.revision,
    anchor: head,
  });
  if (cursor.policyRevision !== policy.revision)
    throw new Error("Reference policy changed; explicit rebuild required");
  if (head.number < cursor.anchor.number)
    throw new Error("Finalized reference head regressed");
  const anchor = await chain.header(cursor.anchor.number);
  if (anchor.hash !== cursor.anchor.hash)
    throw new Error("Reference anchor changed");
  const cache = new Map<number, Header>([
    [anchor.number, anchor],
    [head.number, head],
  ]);
  const header = async (n: number) => {
    let h = cache.get(n);
    if (!h) {
      h = await chain.header(n);
      cache.set(n, h);
    }
    return h;
  };
  let collected = 0;
  while (
    collected < maxBuckets &&
    cursor.nextTimestamp + 300 <= head.timestamp &&
    canContinue()
  ) {
    const boundary = await referenceBoundary(
      cursor.nextTimestamp,
      cursor.anchor,
      head,
      header,
    );
    const evidence: ReferenceEvidence = {
      version: REFERENCE_VERSION,
      scopeId: scope.id,
      policy,
      policyRevision: policy.revision,
      timestamp: cursor.nextTimestamp,
      ...boundary,
      results: await sample(boundary.block),
    };
    if (
      (await chain.header(boundary.after.number)).hash !== boundary.after.hash
    )
      throw new Error("Reference boundary changed after sampling");
    await store.commit(cursor, evidence);
    cursor = {
      ...cursor,
      nextTimestamp: cursor.nextTimestamp + 300,
      anchor: boundary.block,
    };
    collected++;
  }
  return {
    collected,
    nextTimestamp: cursor.nextTimestamp,
    lagBuckets: Math.max(
      0,
      Math.floor((head.timestamp - cursor.nextTimestamp) / 300),
    ),
  };
}
