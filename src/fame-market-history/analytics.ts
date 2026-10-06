import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { marketCandles, MARKET_VERSION, type MarketCandle } from "./market.ts";
import { servingRevision } from "./revision.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalBatches,
  readArchiveContent,
  validateBatchSequence,
} from "./archive.ts";
import {
  decode,
  validateMetadata,
  DECODER_VERSION,
  type TokenMetadata,
  type DecodedEvent,
} from "./decode.ts";
import {
  digest,
  FAME_ADDRESS,
  integer,
  type ArchiveBatch,
  type Manifest,
  type Scope,
} from "./model.ts";

export const RESOLUTIONS = [300, 3600, 86400] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export interface Candle {
  poolId: string;
  timestamp: number;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  baseVolumeAtoms: string;
  quoteVolumeAtoms: string;
  tradeCount: number;
  rejectedEvents: number;
  coverage: "complete" | "partial" | "missing";
}
export interface HistoryDataset {
  market: MarketCandle[];
  version: typeof DECODER_VERSION;
  sourceRevision: string;
  scope: Scope;
  metadata: TokenMetadata;
  coverage: {
    fromBlock: number;
    toBlock: number;
    fromTime: number;
    toTime: number;
  }[];
  candles: Record<Resolution, Candle[]>;
  liquidity: ArchiveBatch["observations"];
}
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
/** Same SQL for canonical raw input and a fresh Parquet rebuild. No DOUBLE division. */
export const CANDLE_SQL = `
SELECT pool_id, block_timestamp // CAST($resolution AS BIGINT) * CAST($resolution AS BIGINT) AS bucket,
  CAST(first(CAST(price_x18 AS DECIMAL(38,0)) ORDER BY block_number, tx_index, log_index) FILTER (WHERE classification = 'trade') AS VARCHAR),
  CAST(max(CAST(price_x18 AS DECIMAL(38,0))) FILTER (WHERE classification = 'trade') AS VARCHAR),
  CAST(min(CAST(price_x18 AS DECIMAL(38,0))) FILTER (WHERE classification = 'trade') AS VARCHAR),
  CAST(last(CAST(price_x18 AS DECIMAL(38,0)) ORDER BY block_number, tx_index, log_index) FILTER (WHERE classification = 'trade') AS VARCHAR),
  CAST(sum(CAST(base_atoms AS BIGNUM)) FILTER (WHERE classification = 'trade') AS VARCHAR),
  CAST(sum(CAST(quote_atoms AS BIGNUM)) FILTER (WHERE classification = 'trade') AS VARCHAR),
  count(*) FILTER (WHERE classification = 'trade'),
  count(*) FILTER (WHERE classification IN ('unknown', 'invalid-trade'))
FROM candle_source GROUP BY pool_id, bucket ORDER BY pool_id, bucket`;

export function decimalPrice(atoms: string | null): string | null {
  if (atoms === null) return null;
  const padded = atoms.padStart(19, "0");
  return `${padded.slice(0, -18)}.${padded.slice(-18)}`;
}

function coverageRanges(batches: ArchiveBatch[]): HistoryDataset["coverage"] {
  const ranges: HistoryDataset["coverage"] = [];
  for (const batch of batches) {
    const first = batch.headers.find((h) => h.number === batch.fromBlock)!;
    const last = batch.headers.find((h) => h.number === batch.toBlock)!;
    const prior = ranges.at(-1);
    if (prior && prior.toBlock + 1 === batch.fromBlock) {
      prior.toBlock = batch.toBlock;
      prior.toTime = last.timestamp;
    } else {
      // Conservative: earlier/later blocks can share a timestamp at either edge.
      ranges.push({
        fromBlock: batch.fromBlock,
        toBlock: batch.toBlock,
        fromTime: first.timestamp + 1,
        toTime: last.timestamp,
      });
    }
  }
  return ranges;
}

async function candles(
  connection: DuckDBConnection,
  scope: Scope,
  coverage: HistoryDataset["coverage"],
  from: number,
  to: number,
  resolution: Resolution,
): Promise<Candle[]> {
  const rows = (
    await connection.runAndReadAll(CANDLE_SQL, { resolution })
  ).getRows();
  const values = new Map(rows.map((row) => [`${row[0]}:${row[1]}`, row]));
  const result: Candle[] = [];
  const start = Math.floor(from / resolution) * resolution;
  for (const pool of scope.pools) {
    for (let timestamp = start; timestamp < to; timestamp += resolution) {
      const row = values.get(`${pool.id}:${timestamp}`);
      const rejectedEvents = row ? Number(row[9]) : 0;
      const complete = coverage.some(
        (r) => r.fromTime <= timestamp && r.toTime >= timestamp + resolution,
      );
      const intersects = coverage.some(
        (r) => r.fromTime < timestamp + resolution && r.toTime > timestamp,
      );
      result.push({
        poolId: pool.id,
        timestamp,
        open: decimalPrice((row?.[2] as string) ?? null),
        high: decimalPrice((row?.[3] as string) ?? null),
        low: decimalPrice((row?.[4] as string) ?? null),
        close: decimalPrice((row?.[5] as string) ?? null),
        baseVolumeAtoms: (row?.[6] as string) ?? "0",
        quoteVolumeAtoms: (row?.[7] as string) ?? "0",
        tradeCount: row ? Number(row[8]) : 0,
        rejectedEvents,
        coverage:
          complete && !rejectedEvents
            ? "complete"
            : intersects || row
              ? "partial"
              : "missing",
      });
    }
  }
  return result;
}

async function appendEvents(
  connection: DuckDBConnection,
  events: DecodedEvent[],
) {
  await connection.run(`CREATE TABLE events (
    pool_id VARCHAR, block_number BIGINT, tx_index INTEGER, log_index INTEGER,
    block_timestamp BIGINT, classification VARCHAR, base_atoms VARCHAR, quote_atoms VARCHAR,
    price_x18 VARCHAR, payload VARCHAR)`);
  const appender = await connection.createAppender("events");
  try {
    for (const event of events) {
      appender.appendVarchar(event.raw.poolId);
      appender.appendBigInt(BigInt(event.raw.blockNumber));
      appender.appendInteger(event.raw.transactionIndex);
      appender.appendInteger(event.raw.logIndex);
      appender.appendBigInt(BigInt(event.raw.blockTimestamp));
      appender.appendVarchar(event.classification);
      for (const value of [event.baseAtoms, event.quoteAtoms, event.priceX18])
        value === null ? appender.appendNull() : appender.appendVarchar(value);
      appender.appendVarchar(JSON.stringify(event));
      appender.endRow();
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
}

/** Bounded offline worker core. Output directory must be new; publication occurs last. */
export async function buildHistory(
  inputs: { manifest: Manifest; bytes: Uint8Array }[],
  metadata: TokenMetadata,
  outputDirectory: string,
) {
  return buildVerifiedHistory(
    canonicalBatches(inputs),
    inputs.map((i) => i.manifest),
    metadata,
    outputDirectory,
  );
}

async function buildVerifiedHistory(
  batches: ArchiveBatch[],
  manifests: Manifest[],
  metadata: TokenMetadata,
  outputDirectory: string,
) {
  const scope = batches[0].scope;
  validateMetadata(scope, metadata);
  const anchor = batches
    .flatMap((b) => b.headers)
    .find((h) => h.number === metadata.blockNumber);
  if (anchor && anchor.hash !== metadata.blockHash)
    throw new Error("Token metadata anchor conflicts with archive");
  const events = batches.flatMap((batch) =>
    batch.events.map((log) =>
      decode(log, scope.pools.find((p) => p.id === log.poolId)!, metadata),
    ),
  );
  const from = Math.min(
    ...batches.map(
      (b) => b.headers.find((h) => h.number === b.fromBlock)!.timestamp,
    ),
  );
  const to =
    Math.max(
      ...batches.map(
        (b) => b.headers.find((h) => h.number === b.toBlock)!.timestamp,
      ),
    ) + 1;
  if (Math.ceil((to - from) / 300) * scope.pools.length > 10000)
    throw new Error(
      "Aggregation time range exceeds point allowance; split the job",
    );
  await mkdir(outputDirectory, { recursive: false });
  const coverage = coverageRanges(batches);
  const revision = digest(
    JSON.stringify({
      decoder: DECODER_VERSION,
      market: MARKET_VERSION,
      serving: servingRevision(scope, metadata),
      sources: [...new Set(manifests.map((m) => m.sha256))].sort(),
      metadata,
    }),
  );
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    memory_limit: "128MB",
    max_temp_directory_size: "64MB",
    temp_directory: path.join(outputDirectory, "spill"),
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
  });
  const connection = await instance.connect().catch((error) => {
    instance.closeSync();
    throw error;
  });
  const timeout = setTimeout(() => connection.interrupt(), 30_000);
  try {
    await appendEvents(connection, events);
    await connection.run("CREATE VIEW candle_source AS SELECT * FROM events");
    const original = {} as HistoryDataset["candles"];
    for (const resolution of RESOLUTIONS)
      original[resolution] = await candles(
        connection,
        scope,
        coverage,
        from,
        to,
        resolution,
      );
    const parquet = path.join(outputDirectory, "events.parquet");
    await connection.run(
      `COPY events TO ${sqlString(parquet)} (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    await connection.run(
      `CREATE TABLE rebuilt AS SELECT * FROM read_parquet(${sqlString(parquet)})`,
    );
    const mismatch = (
      await connection.runAndReadAll(`SELECT count(*) FROM (
      (SELECT * FROM events EXCEPT ALL SELECT * FROM rebuilt)
      UNION ALL (SELECT * FROM rebuilt EXCEPT ALL SELECT * FROM events))`)
    ).getRows()[0][0];
    if (mismatch !== 0n) throw new Error("Parquet round-trip mismatch");
    await connection.run(
      "DROP VIEW candle_source; DROP TABLE events; CREATE VIEW candle_source AS SELECT * FROM rebuilt",
    );
    const rebuilt = {} as HistoryDataset["candles"];
    for (const resolution of RESOLUTIONS)
      rebuilt[resolution] = await candles(
        connection,
        scope,
        coverage,
        from,
        to,
        resolution,
      );
    if (JSON.stringify(original) !== JSON.stringify(rebuilt))
      throw new Error("Parquet candle rebuild differs from raw aggregation");
    const liquidity = [
      ...new Map(
        batches
          .flatMap((b) => b.observations)
          .map((o) => [JSON.stringify(o), o]),
      ).values(),
    ];
    const dataset: HistoryDataset = {
      version: DECODER_VERSION,
      sourceRevision: revision,
      scope,
      metadata,
      coverage,
      candles: rebuilt,
      market: marketCandles(
        scope,
        metadata,
        events,
        rebuilt[300],
        batches.flatMap((b) => b.valuation ?? []),
      ),
      liquidity,
    };
    // Retain range/observation evidence alongside the columnar events. No RPCs are needed to rebuild.
    const evidence = {
      version: DECODER_VERSION,
      sourceRevision: revision,
      metadata,
      ranges: batches.map(({ events: _, ...range }) => range),
      sources: manifests,
      parquetSha256: digest(await readFile(parquet)),
      eventCount: events.length,
    };
    await writeFile(
      path.join(outputDirectory, "evidence.json"),
      JSON.stringify(evidence, null, 2),
      { flag: "wx" },
    );
    // This local publication file is written only after exact round-trip + SQL equivalence checks.
    await writeFile(
      path.join(outputDirectory, "history.json"),
      JSON.stringify(dataset, null, 2),
      { flag: "wx" },
    );
    return {
      dataset,
      eventCount: events.length,
      tradeCount: events.filter((e) => e.classification === "trade").length,
      unknownEvents: events.filter((e) => e.classification === "unknown")
        .length,
      invalidTrades: events.filter((e) => e.classification === "invalid-trade")
        .length,
      parquetBytes: (await readFile(parquet)).length,
      rebuildMatches: true,
    };
  } finally {
    clearTimeout(timeout);
    connection.closeSync();
    instance.closeSync();
  }
}

/** Rebuild using only saved Parquet + evidence; original gzip files and RPC are unnecessary. */
export async function rebuildParquet(
  directory: string,
  outputDirectory: string,
) {
  const evidenceBytes = await readFile(path.join(directory, "evidence.json"));
  if (evidenceBytes.length > 4 * 1024 * 1024)
    throw new Error("Evidence allowance exceeded");
  const evidence = JSON.parse(evidenceBytes.toString()) as {
    version: string;
    metadata: TokenMetadata;
    ranges: Omit<ArchiveBatch, "events">[];
    sources: Manifest[];
    parquetSha256: string;
    eventCount: number;
  };
  if (
    evidence.version !== DECODER_VERSION ||
    evidence.ranges.length > 8 ||
    evidence.sources.length > 8 ||
    integer(evidence.eventCount, "event count") > 10000
  )
    throw new Error("Unsupported compaction evidence");
  const parquet = path.join(directory, "events.parquet");
  if (digest(await readFile(parquet)) !== evidence.parquetSha256)
    throw new Error("Parquet checksum mismatch");
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    memory_limit: "128MB",
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
    max_temp_directory_size: "0B",
  });
  const connection = await instance.connect().catch((error) => {
    instance.closeSync();
    throw error;
  });
  const timeout = setTimeout(() => connection.interrupt(), 30000);
  let events: DecodedEvent[];
  try {
    const rows = (
      await connection.runAndReadAll(
        `SELECT payload FROM read_parquet(${sqlString(parquet)}) ORDER BY block_number, tx_index, log_index LIMIT 10001`,
      )
    ).getRows();
    if (rows.length !== evidence.eventCount)
      throw new Error("Parquet count mismatch");
    events = rows.map((row) => JSON.parse(row[0] as string) as DecodedEvent);
  } finally {
    clearTimeout(timeout);
    connection.closeSync();
    instance.closeSync();
  }
  const rebuilt = evidence.ranges.map((range) => {
    const manifest = evidence.sources.find(
      (m) => m.fromBlock === range.fromBlock && m.toBlock === range.toBlock,
    );
    if (!manifest) throw new Error("Missing original source manifest");
    const raw = events
      .filter(
        (e) =>
          e.raw.blockNumber >= range.fromBlock &&
          e.raw.blockNumber <= range.toBlock,
      )
      .map((e) => e.raw);
    const content = Buffer.from(
      [
        JSON.stringify({ kind: "range", ...range }),
        ...raw.map((e) => JSON.stringify({ kind: "event", ...e })),
      ].join("\n") + "\n",
    );
    return { manifest, batch: readArchiveContent(manifest, content) };
  });
  const batches = rebuilt.map((r) => r.batch),
    manifests = rebuilt.map((r) => r.manifest);
  validateBatchSequence(batches, manifests);
  return buildVerifiedHistory(
    batches,
    manifests,
    evidence.metadata,
    outputDirectory,
  );
}
