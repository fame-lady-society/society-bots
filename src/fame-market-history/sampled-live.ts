import type { Header, Scope } from "./model.ts";
import { digest } from "./model.ts";
import { referenceBoundary } from "./reference-collector.ts";
import {
  deriveSampledObservation,
  type SampledEvidence,
} from "./sampled-rpc.ts";
import {
  sampledPolicy,
  sampledMarketBucket,
  type PoolActivity,
} from "./sampled-market.ts";
export interface SampledCursor {
  startTimestamp: number;
  nextTimestamp: number;
  anchor: Header;
  policyRevision: string;
}
export type SampledBucket = ReturnType<typeof sampledMarketBucket>;
export interface SampledPageRef {
  timestamp: number;
  ETH: string;
  USDC: string;
}
export interface SampledPublication {
  version: "fame-sampled-publication-v1";
  policyRevision: string;
  generation: string;
  startTimestamp: number;
  nextTimestamp: number;
  pages: SampledPageRef[];
}
/** DynamoDB map serialization order is not part of the generation identity. */
export function validateSampledPublication(
  p: SampledPublication,
  revision: string,
): SampledPublication {
  if (
    p.version !== "fame-sampled-publication-v1" ||
    p.policyRevision !== revision ||
    !Array.isArray(p.pages) ||
    p.pages.length < 1 ||
    p.pages.length > 288 ||
    !Number.isSafeInteger(p.startTimestamp) ||
    p.startTimestamp < 0 ||
    p.startTimestamp % 300 ||
    p.pages.some(
      (r, i) =>
        r.timestamp !== p.startTimestamp + i * 300 ||
        !/^[a-f0-9]{64}$/.test(r.ETH) ||
        !/^[a-f0-9]{64}$/.test(r.USDC),
    ) ||
    p.nextTimestamp !== p.startTimestamp + p.pages.length * 300
  )
    throw new Error("Invalid sampled publication");
  const body = {
    version: p.version,
    policyRevision: p.policyRevision,
    startTimestamp: p.startTimestamp,
    nextTimestamp: p.nextTimestamp,
    pages: p.pages.map((r) => ({
      timestamp: r.timestamp,
      ETH: r.ETH,
      USDC: r.USDC,
    })),
  };
  if (digest(JSON.stringify(body)) !== p.generation)
    throw new Error("Corrupt sampled publication");
  return { ...body, generation: p.generation };
}
export interface SampledStore {
  cursor(initial: SampledCursor): Promise<SampledCursor>;
  collected(): Promise<SampledCursor | null>;
  commit(cursor: SampledCursor, evidence: SampledEvidence): Promise<void>;
  read(timestamp: number): Promise<SampledEvidence>;
  previous(timestamp: number): Promise<SampledEvidence | null>;
  publication(): Promise<SampledPublication | null>;
  activity(evidence: SampledEvidence): Promise<PoolActivity[] | null>;
  publish(
    previous: SampledPublication | null,
    evidence: SampledEvidence,
    buckets: SampledBucket[],
  ): Promise<void>;
}
export function nextSampledPublication(
  previous: SampledPublication | null,
  e: SampledEvidence,
  buckets: SampledBucket[],
): SampledPublication {
  if (
    buckets.length !== 2 ||
    buckets[0].currency !== "ETH" ||
    buckets[1].currency !== "USDC" ||
    buckets.some(
      (b) =>
        b.timestamp !== e.timestamp || b.policyRevision !== e.policyRevision,
    )
  )
    throw new Error("Invalid sampled publication inputs");
  if (
    previous &&
    (previous.nextTimestamp !== e.timestamp ||
      previous.policyRevision !== e.policyRevision)
  )
    throw new Error("Sampled publication would skip a bucket");
  const ref = {
    timestamp: e.timestamp,
    ETH: digest(JSON.stringify(buckets[0])),
    USDC: digest(JSON.stringify(buckets[1])),
  };
  const pages = [...(previous?.pages ?? []), ref].slice(-288);
  const body = {
    version: "fame-sampled-publication-v1" as const,
    policyRevision: e.policyRevision,
    startTimestamp: pages[0].timestamp,
    nextTimestamp: e.timestamp + 300,
    pages,
  };
  return { ...body, generation: digest(JSON.stringify(body)) };
}
/** Extend the visible window backwards without advancing the live publisher. */
export function prependSampledPublication(
  previous: SampledPublication,
  evidence: SampledEvidence,
  buckets: SampledBucket[],
): SampledPublication {
  previous = validateSampledPublication(previous, evidence.policyRevision);
  if (
    previous.pages.length >= 288 ||
    evidence.timestamp !== previous.startTimestamp - 300
  )
    throw new Error(
      "Historical import must immediately precede a non-full window",
    );
  const first = nextSampledPublication(null, evidence, buckets);
  const body = {
    version: previous.version,
    policyRevision: previous.policyRevision,
    startTimestamp: evidence.timestamp,
    nextTimestamp: previous.nextTimestamp,
    pages: [...first.pages, ...previous.pages],
  };
  return { ...body, generation: digest(JSON.stringify(body)) };
}
export async function collectSampled(
  scope: Scope,
  store: Pick<SampledStore, "cursor" | "commit">,
  chain: { finalized(): Promise<Header>; header(n: number): Promise<Header> },
  sample: (t: number, b: Header, a: Header) => Promise<SampledEvidence>,
  canContinue = () => true,
  maxBuckets = 4,
) {
  const head = await chain.finalized(),
    revision = sampledPolicy(scope).revision;
  const start = Math.ceil(head.timestamp / 300) * 300;
  let cursor = await store.cursor({
    startTimestamp: start,
    nextTimestamp: start,
    anchor: head,
    policyRevision: revision,
  });
  if (cursor.policyRevision !== revision || head.number < cursor.anchor.number)
    throw new Error("Sampled cursor/head mismatch");
  if ((await chain.header(cursor.anchor.number)).hash !== cursor.anchor.hash)
    throw new Error("Sampled anchor hash changed");
  const cache = new Map<number, Header>([
    [head.number, head],
    [cursor.anchor.number, cursor.anchor],
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
    cursor.nextTimestamp + 300 <= head.timestamp &&
    collected < maxBuckets &&
    canContinue()
  ) {
    const { block, after } = await referenceBoundary(
      cursor.nextTimestamp,
      cursor.anchor,
      head,
      header,
    );
    const evidence = await sample(cursor.nextTimestamp, block, after);
    const o = deriveSampledObservation(scope, evidence);
    sampledMarketBucket(scope, "ETH", cursor.nextTimestamp, o, []); // Boundary + revision validation before commit.
    if ((await chain.header(after.number)).hash !== after.hash)
      throw new Error("Sampled boundary hash changed");
    await store.commit(cursor, evidence);
    cursor = {
      ...cursor,
      nextTimestamp: cursor.nextTimestamp + 300,
      anchor: block,
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
/** Only completed native event ranges enter immutable publication. RPC is never used. */
export async function publishSampled(
  scope: Scope,
  store: SampledStore,
  canContinue = () => true,
  maxBuckets = 4,
) {
  const collected = await store.collected();
  if (!collected) return { published: 0 };
  let prior = await store.publication(),
    next = prior?.nextTimestamp ?? collected.startTimestamp,
    published = 0;
  if (next > collected.nextTimestamp)
    throw new Error("Sampled publication exceeds collection");
  while (
    next < collected.nextTimestamp &&
    published < maxBuckets &&
    canContinue()
  ) {
    const e = await store.read(next),
      activity = await store.activity(e);
    if (!activity)
      return {
        published,
        nextTimestamp: next,
        waitingFor: "execution-archive",
      };
    const priorEvidence = await store.previous(next);
    const opening = priorEvidence
      ? deriveSampledObservation(scope, priorEvidence)
      : null;
    const o = deriveSampledObservation(scope, e),
      buckets = (["ETH", "USDC"] as const).map((c) =>
        sampledMarketBucket(scope, c, next, o, activity, opening),
      );
    await store.publish(prior, e, buckets);
    prior = nextSampledPublication(prior, e, buckets);
    next += 300;
    published++;
  }
  return {
    published,
    nextTimestamp: next,
    lagBuckets: (collected.nextTimestamp - next) / 300,
  };
}
