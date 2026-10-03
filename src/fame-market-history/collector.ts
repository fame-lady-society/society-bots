import { gzipSync } from "node:zlib";
import {
  digest,
  SCHEMA,
  validateLogs,
  integer,
  type ArchiveBatch,
  type Cursor,
  type Header,
  type Manifest,
  type RawLog,
  type Scope,
  type LiquidityObservation,
} from "./model.ts";

export interface ChainReader {
  finalized(): Promise<Header>;
  header(number: number): Promise<Header>;
  logs(from: number, to: number): Promise<RawLog[]>;
  headerAllowance?(): number;
}
export interface ArchiveStore {
  cursor(scopeId: string, startBlock: number): Promise<Cursor>;
  upload(key: string, bytes: Uint8Array, sha256: string): Promise<void>;
  commit(manifest: Manifest, expected: Cursor): Promise<void>;
  observations?(scope: Scope): Promise<LiquidityObservation[]>;
}
export interface CollectResult {
  status: "archived" | "dry-run" | "caught-up";
  scopeId: string;
  fromBlock: number;
  toBlock: number;
  eventCount: number;
  bytes: number;
  finalizedBlock: number;
  coverageLagBlocks: number;
}

export async function collect({
  chain,
  store,
  scope,
  startBlock,
  maxBlocks,
  maxEvents,
  dryRun = false,
}: {
  chain: ChainReader;
  store: ArchiveStore;
  scope: Scope;
  startBlock: number;
  maxBlocks: number;
  maxEvents: number;
  dryRun?: boolean;
}): Promise<CollectResult> {
  integer(startBlock, "start block", 1);
  integer(maxBlocks, "max blocks", 1);
  integer(maxEvents, "max events", 1);
  const cursor = await store.cursor(scope.id, startBlock);
  if (cursor.startBlock !== startBlock)
    throw new Error(
      "Start block changed; use explicit recovery, not a cursor reset",
    );
  const finalized = await chain.finalized();
  if (cursor.previousHash) {
    if (finalized.number < cursor.nextBlock - 1)
      throw new Error("Finalized head regressed behind committed coverage");
    if (
      finalized.number === cursor.nextBlock - 1 &&
      finalized.hash !== cursor.previousHash
    )
      throw new Error(
        "Committed boundary hash changed; history repair required",
      );
  }
  const fromBlock = cursor.nextBlock;
  let toBlock = Math.min(finalized.number, fromBlock + maxBlocks - 1);
  const result = {
    scopeId: scope.id,
    fromBlock,
    toBlock,
    eventCount: 0,
    bytes: 0,
    finalizedBlock: finalized.number,
    coverageLagBlocks: Math.max(0, finalized.number - (cursor.nextBlock - 1)),
  };
  if (fromBlock > finalized.number) return { ...result, status: "caught-up" };
  const previous = await chain.header(fromBlock - 1);
  if (cursor.previousHash && cursor.previousHash !== previous.hash)
    throw new Error("Committed boundary hash changed; history repair required");
  let logs = await chain.logs(fromBlock, toBlock);
  if (logs.length > maxEvents)
    throw new Error("Event limit exceeded; reduce block range before retrying");
  let blocks = [
    ...new Set([
      fromBlock,
      toBlock,
      ...logs.map((log) => integer(log.blockNumber, "log block")),
    ]),
  ].sort((a, b) => a - b);
  if (blocks.some((block) => block < fromBlock || block > toBlock))
    throw new Error("Provider returned logs outside requested range");
  const headerAllowance = chain.headerAllowance?.() ?? blocks.length;
  if (headerAllowance < 2)
    throw new Error("Insufficient request allowance to verify range headers");
  if (blocks.length > headerAllowance) {
    // Commit the fully read prefix rather than repeatedly timing out on a busy range.
    toBlock = blocks[headerAllowance - 1];
    logs = logs.filter((log) => log.blockNumber <= toBlock);
    blocks = blocks.slice(0, headerAllowance);
  }
  const headers = new Map<number, Header>();
  for (const block of blocks)
    headers.set(
      block,
      block === finalized.number ? finalized : await chain.header(block),
    );
  const first = headers.get(fromBlock)!;
  const last = headers.get(toBlock)!;
  if (first.parentHash !== previous.hash)
    throw new Error("Range parent hash mismatch");
  for (let index = 1; index < blocks.length; index++) {
    const prior = headers.get(blocks[index - 1])!;
    const current = headers.get(blocks[index])!;
    if (
      current.timestamp < prior.timestamp ||
      (current.number === prior.number + 1 && current.parentHash !== prior.hash)
    ) {
      throw new Error("Inconsistent range headers");
    }
  }
  const events = validateLogs(logs, scope, fromBlock, toBlock, headers);
  // Re-read the boundary immediately before publication. Do not mix changing chains.
  if ((await chain.header(toBlock)).hash !== last.hash)
    throw new Error("Range changed during collection");
  const observations = (await store.observations?.(scope)) ?? [];
  const batch: ArchiveBatch = {
    schema: SCHEMA,
    scope,
    fromBlock,
    toBlock,
    headers: [...headers.values()],
    events,
    observations,
  };
  const { events: _, ...metadata } = batch;
  const bytes = gzipSync(
    [
      JSON.stringify({ kind: "range", ...metadata }),
      ...events.map((event) => JSON.stringify({ kind: "event", ...event })),
    ].join("\n") + "\n",
  );
  const sha256 = digest(bytes);
  const key = `raw/${SCHEMA}/chain=8453/scope=${scope.id}/${fromBlock}-${toBlock}/${sha256}.jsonl.gz`;
  const manifest: Manifest = {
    schema: SCHEMA,
    scopeId: scope.id,
    fromBlock,
    toBlock,
    firstHash: first.hash,
    lastHash: last.hash,
    previousHash: previous.hash,
    eventCount: events.length,
    key,
    sha256,
    bytes: bytes.length,
    eventIdentityDigest: digest(
      events.map((e) => `${e.blockHash}:${e.logIndex}`).join("\n"),
    ),
  };
  if (!dryRun) {
    await store.upload(key, bytes, sha256);
    await store.commit(manifest, cursor);
  }
  return {
    ...result,
    toBlock,
    coverageLagBlocks: Math.max(0, finalized.number - toBlock),
    eventCount: events.length,
    bytes: bytes.length,
    status: dryRun ? "dry-run" : "archived",
  };
}
