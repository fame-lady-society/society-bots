/** Defaults to read-only preparation. --apply <planId> explicitly authorizes AWS writes. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { historyScope, digest } from "../../src/fame-market-history/model.ts";
import {
  sampledPolicy,
  sampledMarketBucket,
} from "../../src/fame-market-history/sampled-market.ts";
import {
  deriveSampledObservation,
  type SampledEvidence,
} from "../../src/fame-market-history/sampled-rpc.ts";
import { awsSampled } from "../../src/fame-market-history/sampled-storage.ts";
import type { TokenMetadata } from "../../src/fame-market-history/decode.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
let stage = "validate-job";
try {
  const [directory, flag, approvedId, ...extra] = process.argv.slice(2);
  if (
    !directory ||
    extra.length ||
    (flag !== undefined &&
      (flag !== "--apply" || !/^[a-f0-9]{64}$/.test(approvedId ?? "")))
  )
    throw new Error("Expected directory [--apply planId]");
  const root = path.resolve(directory);
  const job = JSON.parse(await readFile(path.join(root, "job.json"), "utf8"));
  const scope = historyScope(famePoolStateRegistry),
    revision = sampledPolicy(scope).revision;
  const metadata = JSON.parse(
    await readFile(
      new URL(
        "../../src/fame-market-history/token-metadata.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as TokenMetadata;
  if (
    job.version !== "sampled-local-job-v1" ||
    job.scopeId !== scope.id ||
    job.policyRevision !== revision ||
    job.metadataRevision !== digest(JSON.stringify(metadata)) ||
    job.table !== process.env.FAME_HISTORY_TABLE ||
    job.bucket !== process.env.FAME_HISTORY_BUCKET ||
    !job.table ||
    !job.bucket ||
    !Number.isSafeInteger(job.from) ||
    job.from < 0 ||
    job.from % 300 ||
    job.to !== job.from + 86400
  )
    throw new Error("Local job does not match target or reviewed policy");
  stage = "read-live-state";
  const store = awsSampled({
    scope,
    metadata,
    table: job.table,
    bucket: job.bucket,
  });
  const live = await store.collected(),
    initial = await store.publication();
  if (!live || !initial)
    throw new Error("Live collection and publication must exist first");
  if (job.to < initial.startTimestamp && initial.pages.length < 288)
    throw new Error(
      "Local job does not reach published history; rebuild the bridge first",
    );
  // Prepare the entire fixed job before any write. Native amounts come from committed
  // production archives, never from the local serving pages or manually supplied counts.
  const prepared = new Map<
    number,
    { e: SampledEvidence; buckets: ReturnType<typeof sampledMarketBucket>[] }
  >();
  stage = "prepare-historical-buckets";
  for (let t = job.from; t < job.to; t += 300) {
    const bytes = await readFile(path.join(root, "observations", `${t}.json`));
    if (bytes.length > 65536) throw new Error("Oversized local observation");
    const e = JSON.parse(bytes.toString()) as SampledEvidence;
    if (e.timestamp !== t || e.policyRevision !== revision)
      throw new Error("Observation identity mismatch");
    const observation = deriveSampledObservation(scope, e),
      activity = await store.activity(e);
    if (!activity)
      throw new Error("Native archive has not reached import bucket");
    const buckets = (["ETH", "USDC"] as const).map((c) =>
      sampledMarketBucket(scope, c, t, observation, activity),
    );
    prepared.set(t, { e, buckets });
  }
  const planId = digest(
    JSON.stringify({
      job,
      artifacts: [...prepared.values()].map(({ e, buckets }) => ({
        evidence: digest(JSON.stringify(e)),
        buckets: buckets.map((b) => digest(JSON.stringify(b))),
      })),
    }),
  );
  if (approvedId && approvedId !== planId)
    throw new Error("Approved import plan changed; prepare again");
  let imported = 0,
    conflicts = 0;
  stage = "verify-approved-plan";
  if (flag === "--apply") {
    stage = "import-buckets";
    while (true) {
      const prior = await store.publication();
      if (!prior) throw new Error("Publication disappeared");
      const t = prior.startTimestamp - 300;
      if (prior.pages.length === 288 || t < job.from) break;
      if (t >= live.startTimestamp)
        throw new Error("Cannot import live-owned buckets");
      const entry = prepared.get(t);
      if (!entry) throw new Error("Import would leave a gap");
      try {
        await store.importPrevious(prior, entry.e, entry.buckets, planId);
        imported++;
      } catch (e) {
        // Re-read after a live publisher/other importer wins, including a lost successful response.
        const current = await store.publication();
        if (
          !current ||
          current.generation === prior.generation ||
          ++conflicts > 5
        )
          throw e;
      }
    }
  }
  const published = (await store.publication())!;
  console.log(
    JSON.stringify({
      event: "sampled-history-import",
      mode: flag ? "apply" : "prepare",
      planId,
      from: job.from,
      to: job.to,
      preparedBuckets: prepared.size,
      imported,
      conflicts,
      publishedBuckets: published.pages.length,
      publishedFrom: published.startTimestamp,
      publishedThrough: published.nextTimestamp,
      liveCollectionNext: (await store.collected())?.nextTimestamp,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "sampled-history-import-failed",
      stage,
      failureCode: failureCode(error),
    }),
  );
  process.exitCode = 1;
}
