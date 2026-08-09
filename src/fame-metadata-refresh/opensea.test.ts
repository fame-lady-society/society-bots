import { metadataMatches, OpenSeaResponseError, readOpenSeaMetadata, refreshOpenSeaMetadata } from "./opensea.ts";

const contract = "0xBB5ED04dD7B207592429eb8d599d103CCad646c4" as const;

describe("OpenSea metadata client", () => {
  it("compares documented cached metadata fields and skips matching data", async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify({ nft: { name: "FAME #1", description: "society", image_url: "https://image" } }), { status: 200 }));
    const metadata = await readOpenSeaMetadata({ apiKey: "test-key", contract, tokenId: 1n, fetcher });
    expect(metadataMatches(metadata, { name: "FAME #1", description: "society", image: "https://image" })).toBe(true);
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({ "x-api-key": "test-key" });
  });

  it("accepts both a new refresh and an already queued refresh", async () => {
    await expect(refreshOpenSeaMetadata({ apiKey: "test-key", contract, tokenId: 1n, fetcher: async () => new Response(null, { status: 200 }) })).resolves.toBe("refreshed");
    await expect(refreshOpenSeaMetadata({ apiKey: "test-key", contract, tokenId: 1n, fetcher: async () => new Response(null, { status: 409 }) })).resolves.toBe("accepted_duplicate");
  });

  it("fails closed on malformed cache data and reports response classes without the API key", async () => {
    await expect(readOpenSeaMetadata({ apiKey: "test-key", contract, tokenId: 1n, fetcher: async () => new Response(JSON.stringify({ nft: {} }), { status: 200 }) })).rejects.toThrow("incomparable");
    await expect(refreshOpenSeaMetadata({ apiKey: "test-key", contract, tokenId: 1n, fetcher: async () => new Response(null, { status: 401 }) })).rejects.toEqual(expect.objectContaining<Partial<OpenSeaResponseError>>({ status: 401 }));
  });
});
