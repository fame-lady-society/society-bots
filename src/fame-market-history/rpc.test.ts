import { boundedTransport, chainReader } from "./rpc.ts";
import { historyScope } from "./model.ts";
import { fameHistoryRegistry } from "./registry.ts";
import { createPublicClient } from "viem";
import { jest } from "@jest/globals";

const scope = historyScope(fameHistoryRegistry);
function fixture(respond: (body: Record<string, unknown>) => Response) {
  const requests: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return respond(body);
  };
  const rpc = boundedTransport({
    url: "https://example.test/private-key",
    maxRequests: 8,
    maxResponseBytes: 1024,
    deadline: Date.now() + 60000,
    fetcher,
  });
  return {
    rpc,
    requests,
    client: createPublicClient({ transport: rpc.transport }),
  };
}
const response = (body: Record<string, unknown>, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));

test("counts every request and sends only exact pool addresses", async () => {
  const f = fixture((body) => response(body, []));
  const chain = chainReader(scope, f.rpc.transport, 100);
  expect(await chain.logs(100, 110)).toMatchObject({
    logs: [],
    throughBlock: 110,
  });
  expect(f.requests[0]).toMatchObject({
    method: "eth_getLogs",
    params: [
      {
        address: scope.pools.map((p) => p.address),
        fromBlock: "0x64",
        toBlock: "0x6e",
      },
    ],
  });
  expect(f.rpc.metrics.methods.eth_getLogs).toBe(1);
});

test("range limits split without turning errors into empty results", async () => {
  const f = fixture((body) => {
    const [filter] = body.params as [{ fromBlock: string; toBlock: string }];
    return filter.fromBlock !== filter.toBlock
      ? new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32005, message: "range limit" },
          }),
        )
      : response(body, []);
  });
  expect(
    await chainReader(scope, f.rpc.transport, 100).logs(100, 101),
  ).toMatchObject({ logs: [], throughBlock: 101 });
  expect(f.requests).toHaveLength(3);
});

test("provider failures do not retry invisibly or expose credentials", async () => {
  const f = fixture(() => {
    throw new Error("https://example.test/private-key");
  });
  try {
    await f.client.getChainId();
    throw new Error("expected failure");
  } catch (error) {
    expect(String(error)).not.toContain("private-key");
  }
  expect(f.requests).toHaveLength(1);
  expect(f.rpc.metrics.lastFailure).toMatchObject({
    method: "eth_chainId",
    kind: "network",
  });
  expect(JSON.stringify(f.rpc.metrics)).not.toContain("private-key");
});

test.each([401, 429, 503])(
  "records HTTP %i without response text",
  async (status) => {
    const f = fixture(() => new Response("private-key", { status }));
    await expect(f.client.getChainId()).rejects.toThrow("http");
    expect(f.rpc.metrics.lastFailure).toMatchObject({
      kind: "http",
      httpStatus: status,
    });
    expect(JSON.stringify(f.rpc.metrics)).not.toContain("private-key");
    expect(f.requests).toHaveLength(1);
  },
);

test("records only numeric provider codes, including through viem wrapping", async () => {
  const f = fixture(
    (body) =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: "private-key", data: "private-key" },
        }),
      ),
  );
  await expect(f.client.getChainId()).rejects.toThrow("provider");
  expect(f.rpc.metrics.lastFailure).toMatchObject({
    kind: "provider",
    rpcCode: -32000,
  });
  expect(JSON.stringify(f.rpc.metrics)).not.toContain("private-key");
});

test("malformed response is distinct from provider and network errors", async () => {
  const f = fixture(() => new Response("private-key"));
  await expect(f.client.getChainId()).rejects.toThrow("invalid-response");
  expect(f.rpc.metrics.lastFailure?.kind).toBe("invalid-response");
});

test("timeout is recorded without propagating fetch errors", async () => {
  jest.useFakeTimers();
  try {
    const rpc = boundedTransport({
      url: "https://example.test/private-key",
      maxRequests: 2,
      maxResponseBytes: 1024,
      deadline: Date.now() + 60000,
      fetcher: async (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("private-key")),
          ),
        ),
    });
    const failure = expect(
      createPublicClient({ transport: rpc.transport }).getChainId(),
    ).rejects.toThrow("timeout");
    await jest.advanceTimersByTimeAsync(10000);
    await failure;
    expect(rpc.metrics.lastFailure).toMatchObject({
      kind: "timeout",
      durationMs: 10000,
    });
    expect(JSON.stringify(rpc.metrics)).not.toContain("private-key");
  } finally {
    jest.useRealTimers();
  }
});

test("per-run request limit prevents additional outbound calls", async () => {
  const f = fixture((body) => response(body, "0x2105"));
  for (let i = 0; i < 8; i++) await f.client.getChainId();
  await expect(f.client.getChainId()).rejects.toThrow();
  expect(f.requests).toHaveLength(8);
});

test("response byte limit stops oversized streams", async () => {
  const f = fixture(() => new Response("x".repeat(2048)));
  await expect(f.client.getChainId()).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
});

test("wrong chain fails before finalized reads", async () => {
  const f = fixture((body) => response(body, "0x1"));
  await expect(
    chainReader(scope, f.rpc.transport, 100).finalized(),
  ).rejects.toThrow("chain mismatch");
  expect(f.requests).toHaveLength(1);
});

test("total response allowance also bounds many individually small responses", async () => {
  const rpc = boundedTransport({
    url: "https://example.test",
    maxRequests: 10,
    maxResponseBytes: 1024,
    maxTotalResponseBytes: 80,
    deadline: Date.now() + 10000,
    fetcher: async (_input, init) =>
      response(JSON.parse(String(init?.body)), "0x2105"),
  });
  const client = createPublicClient({ transport: rpc.transport });
  await client.getChainId();
  await expect(client.getChainId()).rejects.toThrow();
  expect(rpc.metrics.requests).toBe(2);
});

test("busy block hash lists have a bounded header allowance independent of call/log limits", async () => {
  const make = (size: number, total = 8 * 1024 * 1024) => {
    const rpc = boundedTransport({
      url: "https://example.test/private-key",
      maxRequests: 4,
      maxResponseBytes: 256 * 1024,
      maxTotalResponseBytes: total,
      deadline: Date.now() + 60000,
      fetcher: async (_input, init) =>
        response(JSON.parse(String(init?.body)), "x".repeat(size)),
    });
    return createPublicClient({ transport: rpc.transport });
  };
  for (const method of [
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
  ] as const) {
    const client = make(326359);
    expect(
      await client.request({ method, params: ["0x1", false] } as never),
    ).toHaveLength(326359);
    await expect(
      make(4 * 1024 * 1024).request({
        method,
        params: ["0x1", false],
      } as never),
    ).rejects.toThrow();
  }
  for (const method of ["eth_getLogs", "eth_call"]) {
    await expect(
      make(326359).request({ method, params: [] } as never),
    ).rejects.toThrow();
  }
  // Raising a per-header cap never bypasses the cumulative invocation allowance.
  await expect(
    make(326359, 300000).request({
      method: "eth_getBlockByNumber",
      params: ["0x1", false],
    }),
  ).rejects.toThrow();
});
