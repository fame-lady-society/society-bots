import { createPublicClient, custom, type Hex } from "viem";
import { base } from "viem/chains";
import type { ChainReader } from "./collector.ts";
import {
  CHAIN_ID,
  hash,
  integer,
  record,
  type Header,
  type RawLog,
  type Scope,
} from "./model.ts";

export class WorkLimit extends Error {}
export class RangeLimit extends Error {}
export interface RpcMetrics {
  requests: number;
  responseBytes: number;
  methods: Record<string, number>;
}

/** viem's installed HTTP transport cannot cap streamed response bytes. Keep this
 * small transport bounded; delegate chain formatting to viem, with retries off. */
export function boundedTransport({
  url,
  maxRequests,
  maxResponseBytes,
  maxTotalResponseBytes = 8 * 1024 * 1024,
  deadline,
  reserveRequest,
  fetcher = fetch,
  now = Date.now,
}: {
  url: string;
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalResponseBytes?: number;
  deadline: number;
  reserveRequest: () => Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:")
    throw new Error("History RPC requires HTTPS");
  integer(maxRequests, "max requests", 1);
  integer(maxResponseBytes, "response limit", 1);
  integer(maxTotalResponseBytes, "total response limit", 1);
  const metrics: RpcMetrics = { requests: 0, responseBytes: 0, methods: {} };
  return {
    metrics,
    transport: custom(
      {
        request: async ({ method, params }) => {
          if (metrics.requests >= maxRequests || now() >= deadline - 1000)
            throw new WorkLimit("RPC work allowance exhausted");
          // Charge every attempted call before sending. Lost reservations are conservative.
          await reserveRequest();
          if (now() >= deadline - 1000)
            throw new WorkLimit("RPC deadline reached");
          metrics.requests++;
          metrics.methods[method] = (metrics.methods[method] ?? 0) + 1;
          const id = metrics.requests;
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            Math.min(10_000, deadline - now()),
          );
          try {
            const response = await fetcher(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
              signal: controller.signal,
              redirect: "error",
            });
            if (response.status === 413) {
              await response.body?.cancel();
              throw new RangeLimit("RPC range response too large");
            }
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error(`RPC HTTP status ${response.status}`);
            }
            const reader = response.body?.getReader();
            if (!reader) throw new Error("RPC returned no body");
            const chunks: Uint8Array[] = [];
            let size = 0;
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              metrics.responseBytes += value.byteLength;
              if (metrics.responseBytes > maxTotalResponseBytes) {
                await reader.cancel();
                throw new WorkLimit("Total RPC response allowance exhausted");
              }
              if (size > maxResponseBytes) {
                await reader.cancel();
                throw new RangeLimit("RPC response byte limit exceeded");
              }
              chunks.push(value);
            }
            const body = record(
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
            );
            if (body.id !== id || body.jsonrpc !== "2.0")
              throw new Error("RPC response identity mismatch");
            if (body.error) {
              const error = record(body.error);
              if (error.code === -32005)
                throw new RangeLimit("RPC range limit");
              // Provider messages can include credentials/URLs. Never propagate them.
              throw new Error(`RPC rejected ${method}`);
            }
            if (!("result" in body)) throw new Error("RPC result missing");
            return body.result;
          } catch (error) {
            if (error instanceof RangeLimit || error instanceof WorkLimit)
              throw error;
            throw new Error(`History RPC ${method} failed`);
          } finally {
            clearTimeout(timeout);
          }
        },
      },
      { retryCount: 0 },
    ),
  };
}

function limitedRange(error: unknown): boolean {
  if (error instanceof RangeLimit) return true;
  return (
    error instanceof Error &&
    "cause" in error &&
    error.cause !== error &&
    limitedRange(error.cause)
  );
}

export function chainReader(
  scope: Scope,
  transport: ReturnType<typeof boundedTransport>["transport"],
  maxEvents: number,
  headerAllowance?: () => number,
): ChainReader {
  const client = createPublicClient({ chain: base, transport });
  const toHeader = (
    block: Awaited<ReturnType<typeof client.getBlock>>,
  ): Header => ({
    number: integer(Number(block.number), "header number"),
    hash: hash(block.hash),
    parentHash: hash(block.parentHash),
    timestamp: integer(Number(block.timestamp), "block timestamp"),
  });
  return {
    headerAllowance,
    finalized: async () => {
      if ((await client.getChainId()) !== CHAIN_ID)
        throw new Error("History RPC chain mismatch");
      return toHeader(
        await client.getBlock({
          blockTag: "finalized",
          includeTransactions: false,
        }),
      );
    },
    header: async (number) => {
      const header = toHeader(
        await client.getBlock({
          blockNumber: BigInt(number),
          includeTransactions: false,
        }),
      );
      if (header.number !== number)
        throw new Error("RPC header number mismatch");
      return header;
    },
    logs: async (from, to) => {
      const result: RawLog[] = [];
      const read = async (start: number, end: number): Promise<void> => {
        try {
          const logs = await client.getLogs({
            address: scope.pools.map((p) => p.address),
            fromBlock: BigInt(start),
            toBlock: BigInt(end),
          });
          if (logs.length + result.length > maxEvents)
            throw new WorkLimit("Range exceeds event allowance");
          for (const log of logs) {
            if (
              log.blockNumber === null ||
              log.transactionIndex === null ||
              log.logIndex === null
            )
              throw new Error("Pending log in finalized range");
            result.push({
              address: log.address,
              blockNumber: integer(Number(log.blockNumber), "log block"),
              blockHash: hash(log.blockHash),
              transactionHash: hash(log.transactionHash),
              transactionIndex: integer(
                log.transactionIndex,
                "transaction index",
              ),
              logIndex: integer(log.logIndex, "log index"),
              topics: log.topics.map(hash),
              data: log.data as Hex,
              removed: log.removed,
            });
          }
        } catch (error) {
          if (!limitedRange(error) || start === end) throw error;
          const middle = Math.floor((start + end) / 2);
          await read(start, middle);
          await read(middle + 1, end);
        }
      };
      await read(from, to);
      return result;
    },
  };
}
