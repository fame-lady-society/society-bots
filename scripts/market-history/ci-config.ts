/** Select the existing indexer's primary endpoint without printing secret JSON. */
export function historyRpcParameter(
  raw: string | undefined,
  name: string | undefined,
) {
  let urls: unknown;
  try {
    urls = JSON.parse(raw ?? "");
  } catch {
    throw new Error("Indexer RPC secret must be a JSON array");
  }
  if (!Array.isArray(urls) || urls.length === 0)
    throw new Error("Indexer RPC secret must be a nonempty array");
  for (const value of urls) {
    try {
      if (typeof value !== "string" || new URL(value).protocol !== "https:")
        throw new Error();
    } catch {
      throw new Error("Indexer RPC endpoints must be HTTPS URLs");
    }
  }
  if (name !== "/society-bots/market-history/base-rpc")
    throw new Error("Unexpected history RPC parameter path");
  return {
    Name: name,
    Type: "SecureString" as const,
    Value: urls[0] as string,
    Overwrite: true,
  };
}
