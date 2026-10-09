import { HistoryError } from "./api.ts";

/** Optional exclusive boundary for backwards navigation; not event pagination. */
export function parseAvailabilityRequest(raw: string): number | undefined {
  const q = new URLSearchParams(raw);
  for (const key of q.keys())
    if (!["view", "before"].includes(key) || q.getAll(key).length !== 1)
      throw new HistoryError(400, "invalid-query");
  if (q.get("view") !== "availability")
    throw new HistoryError(400, "invalid-query");
  if (!q.has("before")) return undefined;
  const value = q.get("before")!,
    before = Number(value);
  if (
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(before) ||
    before % 300 !== 0
  )
    throw new HistoryError(400, "invalid-query");
  return before;
}
