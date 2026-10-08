/** Start, exercise and close a loopback server; never leave a background service. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readLocalSampledMarket } from "../../src/fame-market-history/sampled-local-api.ts";
const directory = process.argv[2];
if (process.argv.length !== 3)
  throw new Error("Expected publication directory");
const manifest = JSON.parse(
  await readFile(path.join(directory, "publication.json"), "utf8"),
);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/fame/history")
      throw new Error("Invalid route");
    const currency = url.searchParams.get("currency");
    if (currency !== "ETH" && currency !== "USDC")
      throw new Error("Invalid currency");
    const data = await readLocalSampledMarket(
      directory,
      currency,
      Number(url.searchParams.get("from")),
      Number(url.searchParams.get("to")),
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end('{"error":"unavailable-sampled-range"}');
  }
});
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Missing server");
  for (const currency of ["ETH", "USDC"]) {
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/fame/history?currency=${currency}&from=${manifest.from}&to=${manifest.to}`,
    );
    const text = await response.text();
    const json = JSON.parse(text);
    if (response.status !== 200 || json.buckets.length !== 288)
      throw new Error("HTTP rehearsal failed");
    console.log(
      JSON.stringify({
        currency,
        status: response.status,
        buckets: json.buckets.length,
        bytes: Buffer.byteLength(text),
      }),
    );
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
}
