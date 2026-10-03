import { boundedTransport, chainReader } from "./rpc.ts";
import { historyScope } from "./model.ts";
import { famePoolStateRegistry } from "../fame-swap-pool-state/registry/index.ts";
import { createPublicClient } from "viem";

const scope = historyScope(famePoolStateRegistry);
function fixture(respond: (body: Record<string, unknown>) => Response) {
  let reserves = 0;
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
    reserveRequest: async () => {
      reserves++;
    },
    fetcher,
  });
  return {
    rpc,
    requests,
    reserves: () => reserves,
    client: createPublicClient({ transport: rpc.transport }),
  };
}
const response = (body: Record<string, unknown>, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));

test("charges every request and sends only exact pool addresses", async () => {
  const f = fixture((body) => response(body, []));
  const chain = chainReader(scope, f.rpc.transport, 100);
  expect(await chain.logs(100, 110)).toEqual([]);
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
  expect(f.reserves()).toBe(1);
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
  expect(await chainReader(scope, f.rpc.transport, 100).logs(100, 101)).toEqual(
    [],
  );
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
});

test("per-run request limit prevents additional outbound calls", async () => {
  const f = fixture((body) => response(body, "0x2105"));
  for (let i = 0; i < 8; i++) await f.client.getChainId();
  await expect(f.client.getChainId()).rejects.toThrow();
  expect(f.requests).toHaveLength(8);
});

test("failed daily reservation prevents sending", async () => {
  let sent = false;
  const rpc = boundedTransport({
    url: "https://example.test",
    maxRequests: 1,
    maxResponseBytes: 100,
    deadline: Date.now() + 10000,
    reserveRequest: async () => {
      throw new Error("budget");
    },
    fetcher: async () => {
      sent = true;
      return new Response();
    },
  });
  await expect(
    createPublicClient({ transport: rpc.transport }).getChainId(),
  ).rejects.toThrow();
  expect(sent).toBe(false);
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
    reserveRequest: async () => {},
    fetcher: async (_input, init) =>
      response(JSON.parse(String(init?.body)), "0x2105"),
  });
  const client = createPublicClient({ transport: rpc.transport });
  await client.getChainId();
  await expect(client.getChainId()).rejects.toThrow();
  expect(rpc.metrics.requests).toBe(2);
});
