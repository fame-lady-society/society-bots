import { readFile, writeFile, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { digest } from "./model.ts";
/** Publish complete bytes atomically with no overwrite, including competing retries. */
export async function immutableFile(file: string, bytes: Uint8Array) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { flag: "wx" });
  try {
    try {
      await link(temp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (digest(await readFile(file)) !== digest(bytes))
      throw new Error("Immutable artifact conflict");
  } finally {
    await unlink(temp);
  }
}
export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
