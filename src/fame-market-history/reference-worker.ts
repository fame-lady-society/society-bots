import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { digest, type Scope } from "./model.ts";
import { deriveReference } from "./reference-rpc.ts";
import { validateEvidence, type ReferenceEvidence } from "./reference.ts";
import type { ReferenceStore } from "./reference-storage.ts";
/** A portable raw-evidence Parquet record, independently checked before publication. */
export async function referenceParquet(
  evidence: ReferenceEvidence,
  scope: Scope,
): Promise<Uint8Array> {
  validateEvidence(evidence, scope);
  const directory = await mkdtemp(path.join(tmpdir(), "fame-reference-"));
  const instance = await DuckDBInstance.create(":memory:", {
    threads: "1",
    memory_limit: "64MB",
    autoload_known_extensions: "false",
    autoinstall_known_extensions: "false",
  });
  let connection;
  try {
    connection = await instance.connect();
    await connection.run("CREATE TABLE reference_evidence (evidence VARCHAR)");
    await connection.run("INSERT INTO reference_evidence VALUES (?)", [
      JSON.stringify(evidence),
    ]);
    const file = path.join(directory, "reference.parquet");
    const literal = "'" + file.replaceAll("'", "''") + "'";
    await connection.run(
      `COPY reference_evidence TO ${literal} (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    const reader = await connection.runAndReadAll(
      `SELECT evidence FROM read_parquet(${literal})`,
    );
    const rebuilt = JSON.parse(
      String(reader.getRows()[0][0]),
    ) as ReferenceEvidence;
    if (
      JSON.stringify(deriveReference(rebuilt, scope)) !==
      JSON.stringify(deriveReference(evidence, scope))
    )
      throw new Error("Reference Parquet rebuild mismatch");
    return await readFile(file);
  } finally {
    connection?.closeSync();
    instance.closeSync();
    await rm(directory, { recursive: true, force: true });
  }
}
export async function publishReferences(
  scope: Scope,
  store: ReferenceStore,
  maxBuckets = 4,
  canContinue = () => true,
) {
  const collected = await store.progress("collected");
  if (!collected) return { published: 0 };
  const progress = await store.progress("published");
  if (
    progress &&
    (progress.startTimestamp !== collected.startTimestamp ||
      progress.nextTimestamp > collected.nextTimestamp)
  )
    throw new Error("Reference publication progress mismatch");
  let next = progress?.nextTimestamp ?? collected.startTimestamp,
    published = 0;
  while (
    next < collected.nextTimestamp &&
    published < maxBuckets &&
    canContinue()
  ) {
    const evidence = await store.read(next),
      point = deriveReference(evidence, scope);
    const bytes = await referenceParquet(evidence, scope),
      sha256 = digest(bytes);
    const key = `derived/reference/${scope.id}/${next}/${sha256}/reference.parquet`;
    await store.upload(key, bytes);
    await store.publish(collected.startTimestamp, evidence, point, {
      key,
      sha256,
      bytes: bytes.length,
    });
    next += 300;
    published++;
  }
  return {
    published,
    nextTimestamp: next,
    lagBuckets: (collected.nextTimestamp - next) / 300,
  };
}
