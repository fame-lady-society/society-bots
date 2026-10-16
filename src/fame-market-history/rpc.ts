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

import { WorkLimit, RangeLimit } from "./limits.ts";
export interface RpcMetrics {
  requests: number;
  responseBytes: number;
  methods: Record<string, number>;
  /** Fixed labels/numbers only; range diagnostics retain only validated block numbers. */
  timeoutRetries?: number;
  lastFailure?: {
    method: string;
    kind: "timeout" | "network" | "http" | "provider" | "invalid-response";
    durationMs: number;
    httpStatus?: number;
    rpcCode?: number;
    fromBlock?: number;
    toBlock?: number;
  };
}

function logRange(params: unknown): { fromBlock?: number; toBlock?: number } {
  const filter = Array.isArray(params) ? params[0] : null;
  const block = (value: unknown) => {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,14}$/.test(value))
      return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const fromBlock = block(filter?.fromBlock),
    toBlock = block(filter?.toBlock);
  return fromBlock !== null && toBlock !== null && fromBlock <= toBlock
    ? { fromBlock, toBlock }
    : {};
}

/** viem's installed HTTP transport cannot cap streamed response bytes. Keep this
 * small transport bounded; delegate chain formatting to viem, with retries off. */
export function boundedTransport({
  url,
  maxRequests,
  maxResponseBytes,
  maxTotalResponseBytes = 8 * 1024 * 1024,
  deadline,
  fetcher = fetch,
  now = Date.now,
  retryTimeout = false,
  getLogsTimeoutMs = 10000,
}: {
  url: string;
  maxRequests: number;
  maxResponseBytes: number;
  maxTotalResponseBytes?: number;
  deadline: number;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Candidate historical reads only: one retry, charged to the same limits. */
  retryTimeout?: boolean;
  /** Only the candidate worker selects the longer historical log timeout. */
  getLogsTimeoutMs?: 10000 | 20000;
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
    capacity: {
      remainingRequests: () => maxRequests - metrics.requests,
      // Leave room for range boundary headers and a final canonical recheck.
      // Scan work yields before consuming the entire invocation's resources.
      canScan: () =>
        maxRequests - metrics.requests > 3 &&
        now() < deadline - 45000 &&
        maxTotalResponseBytes - metrics.responseBytes >=
          maxResponseBytes + Math.min(1024 * 1024, maxTotalResponseBytes / 4),
    },
    transport: custom(
      {
        request: async ({ method, params }) => {
          const requestTimeoutMs =
            method === "eth_getLogs" ? getLogsTimeoutMs : 10000;
          for (let attempt = 0; ; attempt++) {
            if (metrics.requests >= maxRequests || now() >= deadline - 1000)
              throw new WorkLimit("RPC work allowance exhausted");
            metrics.requests++;
            metrics.methods[method] = (metrics.methods[method] ?? 0) + 1;
            const id = metrics.requests;
            // eth_getBlockByNumber(false) still includes every transaction hash.
            // Busy Base blocks can exceed the small contract-call response allowance.
            const responseLimit =
              method === "eth_getBlockByNumber" ||
              method === "eth_getBlockByHash"
                ? Math.max(maxResponseBytes, 4 * 1024 * 1024)
                : maxResponseBytes;
            const controller = new AbortController();
            const started = now();
            let kind: NonNullable<RpcMetrics["lastFailure"]>["kind"] =
              "network";
            let httpStatus: number | undefined;
            let rpcCode: number | undefined;
            const timeout = setTimeout(
              () => controller.abort(),
              Math.min(requestTimeoutMs, deadline - now()),
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
                kind = "http";
                httpStatus = response.status;
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
                if (size > responseLimit) {
                  await reader.cancel();
                  throw new RangeLimit("RPC response byte limit exceeded");
                }
                chunks.push(value);
              }
              kind = "invalid-response";
              const body = record(
                JSON.parse(Buffer.concat(chunks).toString("utf8")),
              );
              if (body.id !== id || body.jsonrpc !== "2.0")
                throw new Error("RPC response identity mismatch");
              if (body.error) {
                const error = record(body.error);
                if (error.code === -32005)
                  throw new RangeLimit("RPC range limit");
                kind = "provider";
                if (
                  typeof error.code === "number" &&
                  Number.isSafeInteger(error.code)
                )
                  rpcCode = error.code;
                // Provider messages can include credentials/URLs. Never propagate them.
                throw new Error(`RPC rejected ${method}`);
              }
              if (!("result" in body)) throw new Error("RPC result missing");
              return body.result;
            } catch (error) {
              if (error instanceof RangeLimit || error instanceof WorkLimit)
                throw error;
              const safeMethod = [
                "eth_call",
                "eth_chainId",
                "eth_getLogs",
                "eth_getBlockByNumber",
                "eth_getBlockByHash",
              ].includes(method)
                ? method
                : "other";
              metrics.lastFailure = {
                method: safeMethod,
                kind: controller.signal.aborted ? "timeout" : kind,
                durationMs: Math.max(0, now() - started),
                ...(httpStatus === undefined ? {} : { httpStatus }),
                ...(rpcCode === undefined ? {} : { rpcCode }),
                ...(method === "eth_getLogs" ? logRange(params) : {}),
              };
              if (
                retryTimeout &&
                attempt === 0 &&
                controller.signal.aborted &&
                metrics.requests < maxRequests &&
                now() + 250 + requestTimeoutMs + 1000 < deadline &&
                metrics.responseBytes < maxTotalResponseBytes
              ) {
                metrics.timeoutRetries = (metrics.timeoutRetries ?? 0) + 1;
                await new Promise((resolve) => setTimeout(resolve, 250));
                continue;
              }
              throw new Error(
                `History RPC ${safeMethod} failed (${metrics.lastFailure.kind})`,
              );
            } finally {
              clearTimeout(timeout);
            }
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
  capacity?: { remainingRequests(): number; canScan(): boolean },
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
    headerAllowance: capacity
      ? () => capacity.remainingRequests() - 1
      : undefined,
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
      let throughBlock = from - 1;
      let yieldReason: "request-capacity" | "event-capacity" | undefined;
      const read = async (start: number, end: number): Promise<boolean> => {
        if (capacity && !capacity.canScan()) {
          yieldReason = "request-capacity";
          return false;
        }
        let logs;
        try {
          logs = await client.getLogs({
            address: scope.pools.map((p) => p.address),
            fromBlock: BigInt(start),
            toBlock: BigInt(end),
          });
        } catch (error) {
          if (!limitedRange(error) || start === end) throw error;
          const middle = Math.floor((start + end) / 2);
          return (await read(start, middle)) && (await read(middle + 1, end));
        }
        const parsed = logs
          .map((log): RawLog => {
            if (
              log.blockNumber === null ||
              log.transactionIndex === null ||
              log.logIndex === null
            )
              throw new Error("Pending log in finalized range");
            const blockNumber = integer(Number(log.blockNumber), "log block");
            if (blockNumber < start || blockNumber > end)
              throw new Error("Provider returned logs outside requested range");
            return {
              address: log.address,
              blockNumber,
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
            };
          })
          .sort((a, b) => a.blockNumber - b.blockNumber);
        if (parsed.length + result.length > maxEvents) {
          // The response covers the full queried interval. Retain only whole
          // blocks before the first block that would exceed this job's capacity.
          const cutoff = parsed[maxEvents - result.length].blockNumber;
          if (cutoff === from)
            throw new WorkLimit(
              "Single block exceeds event capacity; operator intervention required",
            );
          result.push(...parsed.filter((log) => log.blockNumber < cutoff));
          throughBlock = cutoff - 1;
          yieldReason = "event-capacity";
          return false;
        }
        result.push(...parsed);
        throughBlock = end;
        return true;
      };
      await read(from, to);
      if (throughBlock < from)
        throw new WorkLimit(
          "Insufficient invocation capacity to verify any range",
        );
      return { logs: result, throughBlock, yieldReason };
    },
  };
}
