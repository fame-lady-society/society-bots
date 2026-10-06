import { gunzipSync } from "node:zlib";
import { boundedTransport, chainReader } from "./rpc.ts";
import { collect } from "./collector.ts";
import { scope } from "./worker-fixture.ts";
import type { Cursor, Manifest } from "./model.ts";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const q = (n: number) => `0x${n.toString(16)}`;

test.each(["restricted-provider", "dense-events", "oversized-response"])(
  "%s advances on repeated bounded invocations without skipping or duplicating",
  async (scenario) => {
    let cursor: Cursor = {
      startBlock: 100,
      nextBlock: 100,
      previousHash: null,
    };
    const manifests: Manifest[] = [],
      identities: string[] = [];
    const attempts: number[] = [];
    let hint: { nextBlock: number; maxBlocks: number } | undefined;
    let yields = 0;
    const logs =
      scenario !== "restricted-provider"
        ? Array.from(
            { length: scenario === "dense-events" ? 6000 : 5000 },
            (_, i) => {
              const block =
                100 + Math.floor(i / (scenario === "dense-events" ? 12 : 10));
              return {
                address: scope.pools[0].address,
                blockNumber: q(block),
                blockHash: h(block),
                transactionHash: h(10000 + i),
                transactionIndex: "0x0",
                logIndex: q(i % 12),
                topics:
                  scenario === "oversized-response" ? [h(1), h(2), h(3)] : [],
                data:
                  scenario === "oversized-response"
                    ? `0x${"ab".repeat(160)}`
                    : "0x",
                removed: false,
              };
            },
          )
        : [];
    for (let attempt = 0; cursor.nextBlock <= 599 && attempt < 10; attempt++) {
      const previous = cursor.nextBlock;
      const rpc = boundedTransport({
        url: "https://synthetic.invalid",
        maxRequests: 256,
        maxResponseBytes: 4 * 1024 * 1024,
        deadline: Date.now() + 240000,
        fetcher: async (_url, init) => {
          const request = JSON.parse(String(init?.body));
          let result;
          if (request.method === "eth_chainId") result = "0x2105";
          else if (request.method === "eth_getBlockByNumber") {
            const n =
              request.params[0] === "finalized"
                ? 599
                : Number(request.params[0]);
            result = {
              number: q(n),
              hash: h(n),
              parentHash: h(n - 1),
              timestamp: q(1800000000 + n * 2),
              transactions: [],
            };
          } else {
            const filter = request.params[0],
              from = Number(filter.fromBlock),
              to = Number(filter.toBlock);
            if (scenario === "restricted-provider" && to - from + 1 > 4)
              return new Response(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  error: { code: -32005 },
                }),
              );
            result = logs.filter(
              (l) =>
                Number(l.blockNumber) >= from && Number(l.blockNumber) <= to,
            );
          }
          const bytes = Buffer.from(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
          );
          let offset = 0;
          return new Response(
            new ReadableStream({
              pull(controller) {
                if (offset === bytes.length) return controller.close();
                controller.enqueue(bytes.subarray(offset, offset + 65536));
                offset = Math.min(bytes.length, offset + 65536);
              },
            }),
          );
        },
      });
      const result = await collect({
        scope,
        startBlock: 100,
        maxBlocks: 500,
        maxEvents: 5000,
        chain: chainReader(scope, rpc.transport, 5000, rpc.capacity),
        store: {
          cursor: async () => ({
            ...cursor,
            ...(hint?.nextBlock === cursor.nextBlock
              ? { maxBlocks: hint.maxBlocks }
              : {}),
          }),
          reduceRange: async (_, nextBlock, maxBlocks) => {
            hint = { nextBlock, maxBlocks };
          },
          upload: async (_, bytes) => {
            for (const line of gunzipSync(bytes)
              .toString()
              .trim()
              .split("\n")
              .slice(1)) {
              const event = JSON.parse(line);
              identities.push(`${event.blockHash}:${event.logIndex}`);
            }
          },
          commit: async (m) => {
            manifests.push(m);
            cursor = {
              ...cursor,
              nextBlock: m.toBlock + 1,
              previousHash: m.lastHash,
            };
          },
        },
      });
      if (result.status === "yielded") {
        yields++;
        expect(result.yieldReason).toBe("range-capacity");
        expect(result.toBlock).toBe(previous - 1);
        expect(result.coverageLagBlocks).toBe(600 - previous);
        expect(cursor.nextBlock).toBe(previous);
        expect(manifests).toHaveLength(0);
        expect(identities).toHaveLength(0);
        expect(hint).toEqual({ nextBlock: 100, maxBlocks: 250 });
      } else {
        expect(result.status).toBe("archived");
        expect(cursor.nextBlock).toBeGreaterThan(previous);
      }
      attempts.push(rpc.metrics.requests);
      expect(rpc.metrics.requests).toBeLessThanOrEqual(256);
    }
    expect(cursor.nextBlock).toBe(600);
    expect(yields).toBe(scenario === "oversized-response" ? 1 : 0);
    expect(attempts.length).toBeGreaterThan(1);
    expect(manifests[0].fromBlock).toBe(100);
    for (let i = 1; i < manifests.length; i++)
      expect(manifests[i].fromBlock).toBe(manifests[i - 1].toBlock + 1);
    expect(identities).toHaveLength(logs.length);
    expect(new Set(identities).size).toBe(logs.length);
  },
);
