import { build } from "esbuild";
import { mkdir, copyFile, cp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const target = process.argv[2];
if (!target || process.argv.length !== 3)
  throw new Error("Expected new container context directory");
const app = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const runtime = JSON.parse(
  await readFile(
    path.join(root, "deploy/docker/market-history/package.json"),
    "utf8",
  ),
);
if (
  app.dependencies["@duckdb/node-api"] !==
  runtime.dependencies["@duckdb/node-api"]
)
  throw new Error("DuckDB runtime dependency differs from application lock");
await mkdir(target, { recursive: false });
await build({
  entryPoints: [path.join(root, "scripts/market-history/e2e.ts")],
  outfile: path.join(target, "e2e.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["@duckdb/node-api"],
});
for (const name of ["Dockerfile", "package.json", "package-lock.json"])
  await copyFile(
    path.join(root, "deploy/docker/market-history", name),
    path.join(target, name),
  );
await cp(
  path.join(root, "src/fame-market-history/fixtures/base-52090000-52139999"),
  path.join(target, "fixture"),
  { recursive: true, errorOnExist: true },
);
console.log(`Prepared credential-free runtime proof context: ${target}`);
