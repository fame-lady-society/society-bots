import { collectorTelemetry } from "./observability.ts";

test("failed attempts retain usage metrics without a daily ledger or secret-bearing error", () => {
  const value = collectorTelemetry(
    {
      requests: 7,
      responseBytes: 1234,
      methods: { eth_getLogs: 5, eth_getBlockByNumber: 2 },
    },
    undefined,
    "rpc-failure",
  );
  expect(value).toMatchObject({
    RpcRequests: 7,
    RpcGetLogsRequests: 5,
    RpcHeaderRequests: 2,
    ResponseBytes: 1234,
    CollectionFailures: 1,
    CollectionProgressBlocks: 0,
    code: "rpc-failure",
  });
  expect(JSON.stringify(value._aws)).toContain("RpcRequests");
});

test("a yielded committed prefix reports progress and remaining lag", () => {
  expect(
    collectorTelemetry(
      { requests: 253, responseBytes: 100, methods: {} },
      {
        status: "archived",
        scopeId: "scope",
        fromBlock: 100,
        toBlock: 200,
        finalizedBlock: 599,
        coverageLagBlocks: 399,
        eventCount: 0,
        bytes: 30,
        yieldReason: "request-capacity",
      },
    ),
  ).toMatchObject({
    CollectionProgressBlocks: 101,
    CollectionYields: 1,
    CollectionFailures: 0,
    CoverageLagBlocks: 399,
  });
});
