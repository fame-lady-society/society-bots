/** Read-only RPC verification; all evidence stays in the supplied local directory. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, parseAbi, type Abi, type Hex } from "viem";
import { base } from "viem/chains";
import {
  boundedTransport,
  chainReader,
} from "../../src/fame-market-history/rpc.ts";
import {
  isolatedRegistry,
  isolatedOrigins,
  isolatedPoolScope,
  isolatedMetadata,
  prepareIsolatedBackfill,
} from "../../src/fame-market-history/isolated-backfill.ts";
import {
  sampledReader,
  deriveSampledObservation,
} from "../../src/fame-market-history/sampled-rpc.ts";
import {
  sampledPolicy,
  conversionFor,
  decimal,
} from "../../src/fame-market-history/sampled-market.ts";
import { referenceBoundary } from "../../src/fame-market-history/reference-collector.ts";
import { collect } from "../../src/fame-market-history/collector.ts";
import { readArchive } from "../../src/fame-market-history/archive.ts";
import { decode } from "../../src/fame-market-history/decode.ts";
import { activityEvent } from "../../src/fame-market-history/activity-events.ts";
import { immutableFile } from "../../src/fame-market-history/local-artifacts.ts";
import { failureCode } from "../../src/fame-market-history/failure.ts";
const directory = process.argv[2];
if (
  !directory ||
  process.argv.length !== 3 ||
  !process.env.FAME_HISTORY_RPC_URL
)
  throw new Error("Expected local directory and RPC configuration");
const rpc = boundedTransport({
  url: process.env.FAME_HISTORY_RPC_URL,
  maxRequests: 2000,
  maxResponseBytes: 8 * 1024 * 1024,
  maxTotalResponseBytes: 32 * 1024 * 1024,
  deadline: Date.now() + 180000,
});
try {
  await mkdir(directory, { recursive: true });
  const client = createPublicClient({ chain: base, transport: rpc.transport });
  assert.equal(await client.getChainId(), 8453);
  const pinned = await client.getBlock({ blockTag: "finalized" });
  const origins = isolatedOrigins();
  const abi: Abi = parseAbi([
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function factory() view returns (address)",
    "function stable() view returns (bool)",
    "function tickSpacing() view returns (int24)",
  ]);
  const receipts = [];
  for (const id of ["aerodrome-cbbtc-fame", "aerodrome-spx-fame"]) {
    const scope = isolatedPoolScope(id),
      policy = sampledPolicy(scope),
      chain = chainReader(scope, rpc.transport, 20000, rpc.capacity);
    const origin = origins.find((o) => o.id === id)!;
    const launch = await chain.header(origin.creationBlock);
    assert.equal(launch.timestamp, Date.parse(origin.creationTimestamp) / 1000);
    const identities = [];
    for (const source of policy.sources) {
      const o = origins.find((o) => o.id === source.id)!;
      assert(
        o && o.creationBlock <= origin.creationBlock,
        `Route not deployed: ${source.id}`,
      );
      const receipt = await client.getTransactionReceipt({
        hash: o.creationTransaction as Hex,
      });
      assert.equal(receipt.status, "success");
      assert.equal(Number(receipt.blockNumber), o.creationBlock);
      assert.equal(
        await client.getCode({
          address: source.poolAddress!,
          blockNumber: BigInt(o.creationBlock - 1),
        }),
        undefined,
      );
      assert(
        await client.getCode({
          address: source.poolAddress!,
          blockNumber: BigInt(o.creationBlock),
        }),
      );
      const values: Record<string, unknown> = {};
      for (const name of [
        "token0",
        "token1",
        ...(source.factoryAddress ? ["factory"] : []),
        source.venueFamily === "AerodromeV2" ? "stable" : "tickSpacing",
      ]) {
        values[name] = await client.readContract({
          address: source.poolAddress!,
          abi,
          functionName: name,
          blockNumber: BigInt(origin.creationBlock),
        });
      }
      assert.equal(String(values.token0).toLowerCase(), source.token0);
      assert.equal(String(values.token1).toLowerCase(), source.token1);
      if (source.factoryAddress)
        assert.equal(
          String(values.factory).toLowerCase(),
          source.factoryAddress,
        );
      if (source.venueFamily === "AerodromeV2")
        assert.equal(values.stable, false);
      else assert.equal(values.tickSpacing, source.tickSpacing);
      identities.push({
        id: source.id,
        creationBlock: o.creationBlock,
        creationTransaction: o.creationTransaction,
        values,
      });
    }
    const before = await chain.header(origin.creationBlock - 1),
      end = await chain.header(origin.creationBlock + 43200);
    const samples = [];
    for (const timestamp of [
      Math.floor(launch.timestamp / 300) * 300,
      Math.floor(end.timestamp / 300) * 300 - 300,
      Math.floor(Number(pinned.timestamp) / 300) * 300 - 300,
    ]) {
      const ceiling =
        timestamp < end.timestamp
          ? end
          : await chain.header(Number(pinned.number));
      const boundary = await referenceBoundary(
        timestamp,
        before,
        ceiling,
        chain.header,
      );
      const evidence = await sampledReader(scope, rpc.transport)(
        timestamp,
        boundary.block,
        boundary.after,
      );
      await immutableFile(
        path.join(directory, `${id}-${timestamp}.json`),
        Buffer.from(JSON.stringify(evidence)),
      );
      const observation = deriveSampledObservation(scope, evidence);
      const conversion = Object.fromEntries(
        (["ETH", "USDC"] as const).map((c) => {
          const rate = conversionFor(policy, scope.pools[0], c, observation);
          assert(rate, `${id}: missing ${c} at ${timestamp}`);
          return [c, decimal(rate)];
        }),
      );
      samples.push({
        timestamp,
        block: boundary.block,
        conversion,
        rate: observation.rates[id],
        decimals: observation.decimals,
      });
    }
    let bytes: Uint8Array | undefined;
    const events: Record<string, number> = {};
    let actions = 0;
    const result = await collect({
      scope,
      chain,
      startBlock: origin.creationBlock,
      endBlock: origin.creationBlock + 1999,
      maxBlocks: 2000,
      maxEvents: 20000,
      store: {
        cursor: async () => ({
          startBlock: origin.creationBlock,
          nextBlock: origin.creationBlock,
          previousHash: null,
        }),
        reduceRange: async () => {
          throw new Error("Probe range must shrink");
        },
        upload: async (_, b, sha) => {
          bytes = b;
          await immutableFile(path.join(directory, `${sha}.gz`), b);
        },
        commit: async (m) => {
          const batch = readArchive(m, bytes!);
          const metadata = isolatedMetadata(launch.number, launch.hash);
          for (const log of batch.events) {
            const e = decode(log, scope.pools[0], metadata);
            events[e.eventName ?? "unknown"] =
              (events[e.eventName ?? "unknown"] ?? 0) + 1;
            if (activityEvent(e, scope.pools[0])) actions++;
          }
          await immutableFile(
            path.join(directory, `${id}-manifest.json`),
            Buffer.from(JSON.stringify(m)),
          );
        },
      },
    });
    assert.equal(result.status, "archived");
    assert.equal(events.unknown ?? 0, 0);
    assert(actions > 0);
    receipts.push({ id, origin, identities, samples, events, actions });
  }
  const plan = prepareIsolatedBackfill(
    1720828800,
    Math.floor(Number(pinned.timestamp) / 300) * 300,
  );
  await immutableFile(
    path.join(directory, "plan.json"),
    Buffer.from(JSON.stringify(plan)),
  );
  const receipt = {
    verifiedAt: new Date().toISOString(),
    pinnedBlock: Number(pinned.number),
    receipts,
    metrics: rpc.metrics,
    productionWrites: 0,
  };
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
} catch (e) {
  console.error(
    JSON.stringify({
      error: failureCode(e),
      message: e instanceof assert.AssertionError ? e.message : undefined,
      frames:
        e instanceof Error
          ? e.stack
              ?.split("\n")
              .slice(1)
              .filter((l) => l.includes("/society-bots/"))
              .slice(0, 4)
          : undefined,
      metrics: rpc.metrics,
    }),
  );
  process.exitCode = 1;
}
