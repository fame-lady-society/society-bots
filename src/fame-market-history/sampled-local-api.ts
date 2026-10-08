import { readFile } from "node:fs/promises";
import path from "node:path";
import { digest, integer } from "./model.ts";
import type { sampledMarketBucket, Currency } from "./sampled-market.ts";
type Bucket = ReturnType<typeof sampledMarketBucket>;
/** Rehearsal reader: pins one immutable local manifest, verifies pages, never calls RPC. */
export async function readLocalSampledMarket(
  directory: string,
  currency: Currency,
  from: number,
  to: number,
) {
  if (currency !== "ETH" && currency !== "USDC")
    throw new Error("Unsupported currency");
  integer(from, "from");
  integer(to, "to");
  if (from % 300 || to % 300 || to <= from || to - from > 86400)
    throw new Error("Invalid sampled range");
  const manifestBytes = await readFile(
    path.join(directory, "publication.json"),
  );
  const manifest = JSON.parse(manifestBytes.toString());
  if (
    manifest.version !== "sampled-local-publication-v1" ||
    from < manifest.from ||
    to > manifest.to ||
    !Array.isArray(manifest.pages) ||
    manifest.pages.length > 48
  )
    throw new Error("Unavailable sampled publication");
  const buckets: Bucket[] = [];
  for (const page of manifest.pages) {
    if (
      typeof page.key !== "string" ||
      !/^(ETH|USDC)-[0-9]+\.json$/.test(page.key)
    )
      throw new Error("Invalid page identity");
    if (!page.key.startsWith(`${currency}-`)) continue;
    const bytes = await readFile(path.join(directory, "pages", page.key));
    if (
      bytes.length > 300 * 1024 ||
      bytes.length !== page.bytes ||
      digest(bytes) !== page.sha256
    )
      throw new Error("Corrupt sampled page");
    const data = JSON.parse(bytes.toString());
    if (
      data.currency !== currency ||
      data.sourceRevision !== manifest.sourceRevision ||
      data.version !== "fame-market-page-v1" ||
      !Array.isArray(data.buckets) ||
      data.buckets.length > 12
    )
      throw new Error("Invalid sampled page");
    for (const bucket of data.buckets) {
      if (
        bucket.currency !== currency ||
        bucket.version !== "fame-market-api-v2" ||
        bucket.policyRevision !== manifest.policyRevision
      )
        throw new Error("Mismatched sampled bucket");
      if (bucket.timestamp >= from && bucket.timestamp < to)
        buckets.push(bucket);
    }
  }
  buckets.sort((a, b) => a.timestamp - b.timestamp);
  if (
    buckets.length !== (to - from) / 300 ||
    buckets.some((b, i) => b.timestamp !== from + i * 300)
  )
    throw new Error("Missing or duplicate sampled buckets");
  const response = {
    version: "fame-market-api-v2",
    currency,
    from,
    to,
    resolution: 300,
    publicationId: digest(manifestBytes),
    buckets,
  };
  if (Buffer.byteLength(JSON.stringify(response)) > 2 * 1024 * 1024)
    throw new Error("Sampled response exceeds cap");
  return response;
}
