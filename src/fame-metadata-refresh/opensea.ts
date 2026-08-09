import type { Address } from "viem";
import type { MetadataDocument } from "./types.ts";

const baseUrl = "https://api.opensea.io/api/v2/chain/base/contract";
export const METADATA_REQUEST_TIMEOUT_MS = 4_000;

export class OpenSeaResponseError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

function retryAfterMs(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  return Math.ceil(Number(value) * 1000);
}

function requiredKey(key: string | undefined) {
  if (!key) throw new Error("OPENSEA_API_KEY is not configured");
  return key;
}

function metadataFrom(value: unknown): MetadataDocument {
  if (!value || typeof value !== "object") throw new Error("OpenSea metadata response is malformed");
  const nft = (value as { nft?: unknown }).nft;
  if (!nft || typeof nft !== "object") throw new Error("OpenSea metadata response has no NFT");
  const record = nft as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.description !== "string" || typeof record.image_url !== "string") {
    throw new Error("OpenSea metadata response is incomparable");
  }
  return { name: record.name, description: record.description, image: record.image_url };
}

export function metadataMatches(left: MetadataDocument, right: MetadataDocument) {
  return left.name === right.name && left.description === right.description && left.image === right.image;
}

export function isRetryableOpenSeaStatus(status: number) {
  return status === 429 || status >= 500;
}

export async function readOpenSeaMetadata({ apiKey, contract, tokenId, fetcher = fetch }: { apiKey?: string; contract: Address; tokenId: bigint; fetcher?: typeof fetch }): Promise<MetadataDocument> {
  const response = await fetcher(`${baseUrl}/${contract}/nfts/${tokenId.toString()}`, {
    headers: { "x-api-key": requiredKey(apiKey) },
    signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new OpenSeaResponseError(response.status, "OpenSea metadata read failed", retryAfterMs(response));
  return metadataFrom(await response.json());
}

export async function refreshOpenSeaMetadata({ apiKey, contract, tokenId, fetcher = fetch }: { apiKey?: string; contract: Address; tokenId: bigint; fetcher?: typeof fetch }): Promise<"refreshed" | "accepted_duplicate"> {
  const response = await fetcher(`${baseUrl}/${contract}/nfts/${tokenId.toString()}/refresh`, {
    method: "POST",
    headers: { "x-api-key": requiredKey(apiKey) },
    signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 200) return "refreshed";
  if (response.status === 409) return "accepted_duplicate";
  throw new OpenSeaResponseError(response.status, "OpenSea metadata refresh failed", retryAfterMs(response));
}
