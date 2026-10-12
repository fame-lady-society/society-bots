/** Compose immutable, dated market definitions without copying retained history. */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { HistoryError } from "./api.ts";
import { validateHistory, type HistorySegment } from "./dataset.ts";
import { digest } from "./model.ts";
import { sampledReader } from "./sampled-reader.ts";
import {
  validateSources,
  type WindowSource,
  type ReadPublication,
} from "./dated-publication.ts";
import type { SampledBucket, SampledPageRef } from "./sampled-live.ts";
import type { Currency } from "./sampled-market.ts";

export function historyReader(
  db: DynamoDBDocumentClient,
  table: string,
  currentRevision: string,
  now = Date.now,
  history: HistorySegment[] = [],
) {
  validateHistory(history);
  if (history.some((s) => s.policyRevision === currentRevision))
    throw new Error("Current policy repeats historical membership");
  const current = sampledReader(db, table, currentRevision, now);
  if (!history.length)
    return {
      ...current,
      revision: currentRevision,
      revisionAt: (_t: number) => currentRevision,
    };
  const revision = digest(JSON.stringify({ currentRevision, history }));
  const segments = [
    ...history,
    { from: history.at(-1)!.to, to: Infinity, policyRevision: currentRevision },
  ];
  // All readers share the same deadline, including old snapshot and page reads.
  const started = now();
  const readers = new Map(
    segments.map((s) => [
      s.policyRevision,
      sampledReader(db, table, s.policyRevision, () => now(), {
        emptyFrom: s.from,
        forceWindow: true,
      }),
    ]),
  );
  const budget = () => {
    if (now() - started >= 6500)
      throw new HistoryError(503, "history-read-budget-exceeded");
  };
  const revisionAt = (t: number) =>
    segments.find((s) => t >= s.from && t < s.to)!.policyRevision;
  const window = async (
    from: number,
    to: number,
    sources?: WindowSource[],
  ): Promise<ReadPublication> => {
    if (
      ![from, to].every(
        (t) => Number.isSafeInteger(t) && t >= 0 && t % 300 === 0,
      ) ||
      to <= from ||
      to - from > 86400
    )
      throw new HistoryError(400, "invalid-query");
    const included = segments.filter((s) => from < s.to && to > s.from);
    if (included.length > 8)
      throw new HistoryError(503, "history-read-budget-exceeded");
    if (sources) {
      validateSources(sources);
      if (
        sources.some(
          (s) => !included.some((i) => i.policyRevision === s.revision),
        ) ||
        included.some(
          (i) => !sources.some((s) => s.revision === i.policyRevision),
        )
      )
        throw new HistoryError(400, "invalid-query");
    }
    const pages: SampledPageRef[] = [],
      selected: WindowSource[] = [];
    let nextTimestamp = from;
    for (const s of included) {
      budget();
      const lower = Math.max(from, s.from),
        upper = Math.min(to, s.to);
      const p = await readers.get(s.policyRevision)!.window(
        lower,
        upper,
        sources
          ?.filter((v) => v.revision === s.policyRevision)
          .map(({ revision: _, ...v }) => v),
      );
      if (!("sources" in p)) throw new Error("Unpinned history segment");
      pages.push(
        ...p.pages.filter((r) => r.timestamp >= lower && r.timestamp < upper),
      );
      selected.push(
        ...p.sources.map((v) => ({ ...v, revision: s.policyRevision })),
      );
      nextTimestamp = Math.max(nextTimestamp, Math.min(upper, p.nextTimestamp));
    }
    const body = {
      version: "fame-history-window-v1" as const,
      policyRevision: revision,
      startTimestamp: from,
      nextTimestamp,
      pages,
    };
    return {
      ...body,
      sources: selected,
      generation: digest(
        JSON.stringify({ ...body, sources: selected, from, to }),
      ),
    };
  };
  const pages = async (refs: SampledPageRef[], currency: Currency) => {
    if (refs.length > 288) throw new Error("Too many history pages");
    const result = new Map<number, SampledBucket>();
    let bytes = 0;
    for (const s of segments) {
      const part = refs.filter(
        (r) => revisionAt(r.timestamp) === s.policyRevision,
      );
      if (!part.length) continue;
      budget();
      for (const [t, b] of await readers
        .get(s.policyRevision)!
        .pages(part, currency)) {
        bytes += Buffer.byteLength(JSON.stringify(b));
        if (bytes > 2 * 1024 * 1024)
          throw new Error("Sampled response too large");
        result.set(t, b);
      }
    }
    return result;
  };
  const availability = async (before?: number) => {
    const first = await readers.get(segments[0].policyRevision)!.availability();
    budget();
    const live = await current.get("published");
    const latest = live
      ? (await current.publication()).nextTimestamp - 300
      : history.at(-1)!.to - 300;
    return {
      ...first,
      policyRevision: revision,
      latestAvailableTimestamp: latest,
      ...(before === undefined
        ? {}
        : { before, hasEarlier: first.earliestAvailableTimestamp < before }),
    };
  };
  return { ...current, revision, revisionAt, window, pages, availability };
}
