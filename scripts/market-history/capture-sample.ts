import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, parseAbi } from "viem";
import { famePoolStateRegistry } from "../../src/fame-swap-pool-state/registry/index.ts";
import { collect } from "../../src/fame-market-history/collector.ts";
import {
  historyScope,
  digest,
  integer,
} from "../../src/fame-market-history/model.ts";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import { awsArchive } from "../../src/fame-market-history/storage.ts";
import { configuration } from "../../src/fame-market-history/runtime.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";

// Explicit local evidence capture. AWS adapter is used ONLY for observations.
// No S3 writes, DynamoDB writes, SSM writes, notifications, or scheduled services.
try {
  if (process.argv.length !== 3)
    throw new Error("Expected new output directory");
  const output = path.resolve(process.argv[2]);
  const config = configuration(process.env, true);
  const scope = historyScope(famePoolStateRegistry);
  const rpc = boundedTransport({
    url: config.rpcUrl,
    maxRequests: config.maxRequests,
    maxResponseBytes: config.maxResponseBytes,
    deadline: Date.now() + 60000,
  });
  const chain = chainReader(
    scope,
    rpc.transport,
    config.maxEvents,
    rpc.capacity,
  );
  await mkdir(output, { recursive: false });
  const result = await collect({
    chain,
    scope,
    startBlock: config.startBlock,
    maxBlocks: config.maxBlocks,
    maxEvents: config.maxEvents,
    store: {
      reduceRange: async (_, __, maxBlocks) => {
        throw new Error(
          `Local sample exceeds invocation capacity; retry with FAME_HISTORY_MAX_BLOCKS=${maxBlocks}`,
        );
      },
      cursor: async (_, startBlock) => ({
        startBlock,
        nextBlock: startBlock,
        previousHash: null,
      }),
      observations: awsArchive(config).observations,
      upload: async (_, bytes, sha256) => {
        const file = path.join(output, "raw.jsonl.gz");
        await writeFile(file, bytes, { flag: "wx" });
        if (digest(await readFile(file)) !== sha256)
          throw new Error("Local archive verification failed");
      },
      commit: async (manifest) => {
        await writeFile(
          path.join(output, "manifest.json"),
          JSON.stringify(manifest, null, 2),
          { flag: "wx" },
        );
      },
    },
  });
  if (result.status !== "archived")
    throw new Error("No finalized range captured");
  const client = createPublicClient({ transport: rpc.transport });
  const abi = parseAbi([
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function decimals() view returns (uint8)",
  ]);
  const decimals: Record<string, number> = {},
    poolTokens: Record<string, { token0: string; token1: string }> = {};
  const blockNumber = BigInt(config.startBlock);
  const anchor = await chain.header(config.startBlock);
  for (const pool of scope.pools) {
    const token0 = (
      await client.readContract({
        address: pool.address,
        abi,
        functionName: "token0",
        blockNumber,
      })
    ).toLowerCase();
    const token1 = (
      await client.readContract({
        address: pool.address,
        abi,
        functionName: "token1",
        blockNumber,
      })
    ).toLowerCase();
    if (token0 !== pool.token0 || token1 !== pool.token1)
      throw new Error("Registry token mismatch");
    poolTokens[pool.id] = { token0, token1 };
    for (const token of [pool.token0, pool.token1])
      if (decimals[token] === undefined)
        decimals[token] = integer(
          await client.readContract({
            address: token,
            abi,
            functionName: "decimals",
            blockNumber,
          }),
          "decimals",
        );
  }
  if ((await chain.header(config.startBlock)).hash !== anchor.hash)
    throw new Error("Metadata anchor changed");
  await writeFile(
    path.join(output, "tokens.json"),
    JSON.stringify(
      {
        chainId: 8453,
        blockNumber: config.startBlock,
        blockHash: anchor.hash,
        decimals,
        poolTokens,
        decoderReview: "provisional",
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      {
        event: "local-history-sample",
        ...result,
        metrics: rpc.metrics,
        output,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "local-history-sample-failed",
      code: failureCode(error),
    }),
  );
  process.exitCode = 1;
}
