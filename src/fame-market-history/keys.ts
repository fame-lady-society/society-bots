/** Data-only keys shared by publishers and the read-only API. */
export const rangeKey = (block: number) =>
  `range:${String(block).padStart(16, "0")}`;
export const progressKey = (scopeId: string) => ({
  pk: `scope:${scopeId}`,
  sk: "aggregation",
});
export const activeScopeKey = { pk: "history:8453", sk: "active-scope" };
export const candleKey = (
  scopeId: string,
  poolId: string,
  timestamp: number,
) => ({
  pk: `candles:${scopeId}:${poolId}:300`,
  sk: String(timestamp).padStart(16, "0"),
});
export const marketKey = (scopeId: string, timestamp: number) => ({
  pk: `market:${scopeId}:300`,
  sk: String(timestamp).padStart(16, "0"),
});

export const sampledKey = (revision: string, sk: string) => ({
  pk: `sampled:${revision}`,
  sk,
});
export const sampledPageKey = (
  revision: string,
  currency: string,
  timestamp: number,
  sha: string,
) => ({
  pk: `sampled-page:${revision}:${currency}`,
  sk: `${timestamp}:${sha}`,
});
