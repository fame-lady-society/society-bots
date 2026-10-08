import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixtureRange, scope, metadata, epoch } from "./worker-fixture.ts";
import { rebuildActivity, sampledPages } from "./sampled-rebuild.ts";
import { immutableFile, readJson } from "./local-artifacts.ts";
test("verified archives preserve actual trade counts/atoms across dedup and resume", async () => {
  const a = await fixtureRange(99, 105, 102),
    b = await fixtureRange(106, 111, 107);
  const r = rebuildActivity(scope, metadata, [b, a, a], epoch, epoch + 600);
  expect(r.buckets.get(epoch)?.reduce((n, p) => n + p.tradeCount, 0)).toBe(1);
  expect(
    r.buckets.get(epoch + 300)?.reduce((n, p) => n + p.tradeCount, 0),
  ).toBe(1);
  expect(r.buckets.get(epoch)?.every((p) => p.coverage === "complete")).toBe(
    true,
  );
  expect(
    rebuildActivity(scope, metadata, [a, b], epoch, epoch + 600).sourceRevision,
  ).toBe(r.sourceRevision);
  const pages = sampledPages(scope, r, new Map());
  expect(pages).toHaveLength(2);
  const usdc = JSON.parse(
    pages.find((p) => p.key.startsWith("USDC"))!.bytes.toString(),
  );
  expect(usdc.buckets[0].totals.tradeCount).toBe(1);
  expect(
    usdc.buckets[0].series.every((p: { price: unknown }) => p.price === null),
  ).toBe(true);
});
test("archive gaps and unknown activity never become verified zero", async () => {
  const a = await fixtureRange(99, 101),
    b = await fixtureRange(109, 115);
  const r = rebuildActivity(scope, metadata, [a, b], epoch, epoch + 900);
  expect(r.buckets.get(epoch)?.every((p) => p.coverage === "partial")).toBe(
    true,
  );
  expect(
    r.buckets.get(epoch + 600)?.every((p) => p.coverage === "complete"),
  ).toBe(true);
  const empty = rebuildActivity(scope, metadata, [], epoch, epoch + 300);
  expect(empty.buckets.get(epoch)?.every((p) => p.coverage === "missing")).toBe(
    true,
  );
});
test("corrupt and overlapping archives fail before publication", async () => {
  const a = await fixtureRange(99, 105),
    b = await fixtureRange(104, 110);
  expect(() =>
    rebuildActivity(scope, metadata, [a, b], epoch, epoch + 300),
  ).toThrow();
  expect(() =>
    rebuildActivity(
      scope,
      metadata,
      [{ ...a, bytes: Buffer.from("bad") }],
      epoch,
      epoch + 300,
    ),
  ).toThrow();
});
test("immutable local artifacts survive identical concurrent retries and reject conflicting writes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sampled-artifact-"));
  try {
    const file = path.join(dir, "a.json"),
      bytes = Buffer.from('{"ok":true}');
    await Promise.all([immutableFile(file, bytes), immutableFile(file, bytes)]);
    await expect(immutableFile(file, Buffer.from("bad"))).rejects.toThrow(
      "conflict",
    );
    expect(await readFile(file, "utf8")).toBe(bytes.toString());
    expect(await readJson(file)).toEqual({ ok: true });
    expect(await readJson(path.join(dir, "absent"))).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local serving pins checksummed pages and rejects corruption or duplicate buckets", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { digest } = await import("./model.ts");
  const { readLocalSampledMarket } = await import("./sampled-local-api.ts");
  const { sampledPolicy } = await import("./sampled-market.ts");
  const dir = await mkdtemp(path.join(tmpdir(), "sampled-reader-"));
  try {
    await mkdir(path.join(dir, "pages"));
    const activity = rebuildActivity(scope, metadata, [], epoch, epoch + 300);
    const pages = sampledPages(scope, activity, new Map());
    for (const p of pages)
      await writeFile(path.join(dir, "pages", p.key), p.bytes);
    const manifest = {
      version: "sampled-local-publication-v1",
      from: epoch,
      to: epoch + 300,
      sourceRevision: activity.sourceRevision,
      policyRevision: sampledPolicy(scope).revision,
      pages: pages.map((p) => ({
        key: p.key,
        sha256: p.sha256,
        bytes: p.bytes.length,
      })),
    };
    await writeFile(
      path.join(dir, "publication.json"),
      JSON.stringify(manifest),
    );
    const result = await readLocalSampledMarket(dir, "ETH", epoch, epoch + 300);
    expect(result.buckets[0].totals.tradeCount).toBeNull();
    await expect(
      readLocalSampledMarket(dir, "ETH", epoch - 300, epoch + 300),
    ).rejects.toThrow();
    const p = pages[0];
    await writeFile(path.join(dir, "pages", p.key), "corrupt");
    await expect(
      readLocalSampledMarket(dir, "ETH", epoch, epoch + 300),
    ).rejects.toThrow("Corrupt");
    const duplicate = JSON.parse(p.bytes.toString());
    duplicate.buckets.push(duplicate.buckets[0]);
    const bytes = Buffer.from(JSON.stringify(duplicate));
    await writeFile(path.join(dir, "pages", p.key), bytes);
    manifest.pages[0] = {
      key: p.key,
      sha256: digest(bytes),
      bytes: bytes.length,
    };
    await writeFile(
      path.join(dir, "publication.json"),
      JSON.stringify(manifest),
    );
    await expect(
      readLocalSampledMarket(dir, "ETH", epoch, epoch + 300),
    ).rejects.toThrow("duplicate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
