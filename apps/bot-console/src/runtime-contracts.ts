import { z } from "zod";
export const runtime = {
  id: "overclaw-leader",
  name: "FAMEliza",
  backend: "Overclaw",
} as const;
export const runtimeScope = "runtime:overclaw-leader";
export const freshnessSeconds = 180;
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const phase = z.enum([
  "asleep",
  "launching",
  "awake",
  "draining",
  "terminating",
  "stopping",
  "recovery",
]);
const counts = z
  .object({
    queued: timestamp,
    launching: timestamp,
    ready: timestamp,
    draining: timestamp,
    terminating: timestamp,
    stopping: timestamp,
    asleep: timestamp,
    paused: timestamp,
    recovery: timestamp,
  })
  .strict();
const lifecycle = z
  .object({
    availability: z.enum(["available", "unavailable"]),
    observedAt: timestamp.nullable(),
    error: z
      .enum(["reconcile_failed", "not_initialized", "orphan_compute"])
      .nullable(),
    phase: phase.nullable(),
    lastHeardAt: timestamp.nullable(),
    ready: z.boolean(),
    startup: z
      .enum(["restoring", "connecting", "configuring", "loading", "checking"])
      .nullable(),
    blocker: z
      .enum([
        "startup_failed",
        "recovery_required",
        "stopping",
        "heartbeat_failed",
      ])
      .nullable(),
    checkpointCreatedAt: timestamp.nullable(),
    launchVersion: z.string().min(1).max(128).nullable(),
  })
  .strict();
const workers = z
  .object({
    availability: z.enum(["available", "unavailable"]),
    observedAt: timestamp.nullable(),
    error: z.enum(["reconcile_failed", "orphan_compute"]).nullable(),
    counts: counts.nullable(),
    total: timestamp.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.counts === null
        ? v.total === null
        : v.total === Object.values(v.counts).reduce((a, b) => a + b, 0),
    "Incomplete worker counts",
  );
function coherentEvidence(s: {
  publishedAt: number;
  lifecycle: z.infer<typeof lifecycle>;
  workers: z.infer<typeof workers>;
}) {
  const l = s.lifecycle;
  const w = s.workers;
  return (
    (l.availability === "available"
      ? l.error === null && l.observedAt !== null && l.phase !== null
      : l.error !== null) &&
    (w.availability === "available"
      ? w.error === null &&
        w.observedAt !== null &&
        w.counts !== null &&
        w.total !== null
      : w.error !== null) &&
    (l.observedAt === null || l.observedAt <= s.publishedAt) &&
    (w.observedAt === null || w.observedAt <= s.publishedAt)
  );
}
export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeId: z.literal(runtime.id),
    revision: timestamp.min(1),
    publishedAt: timestamp,
    lifecycle: lifecycle
      .extend({
        generation: z.string().min(1).max(256).nullable(),
        lastHeardGeneration: z.string().min(1).max(256).nullable(),
      })
      .strict(),
    workers,
  })
  .strict()
  .refine(coherentEvidence, "Contradictory status evidence");
export type RuntimeSnapshot = z.infer<typeof snapshotSchema>;
export const runtimeStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeId: z.literal(runtime.id),
    revision: timestamp.min(1),
    publishedAt: timestamp,
    lifecycle: lifecycle.extend({ heartbeatCurrent: z.boolean() }).strict(),
    workers,
  })
  .strict()
  .refine(coherentEvidence, "Contradictory status evidence");
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export const runtimeResponseSchema = z
  .object({ status: runtimeStatusSchema.nullable() })
  .strict();
export function recent(at: number | null, now: number) {
  return at !== null && at <= now + 30 && now - at <= freshnessSeconds;
}
export function runtimePresentation(status: RuntimeStatus, now: number) {
  const l = status.lifecycle;
  const labels = {
    asleep: "Asleep",
    launching: "Starting",
    awake: "Awake",
    draining: "Saving",
    terminating: "Shutting down",
    stopping: "Stopping",
    recovery: "Recovery needed",
  };
  if (l.availability === "unavailable")
    return {
      label: "Status unavailable",
      detail:
        "The latest lifecycle observation failed. Previous evidence is historical.",
    };
  if (!l.phase || l.observedAt === null)
    return {
      label: "Not observed",
      detail: "Waiting for the first lifecycle observation.",
    };
  if (!recent(l.observedAt, now))
    return {
      label: `Last observed ${labels[l.phase].toLowerCase()}`,
      detail:
        "Status stale — the producer has not supplied a recent observation.",
    };
  if (l.blocker)
    return {
      label: labels[l.phase],
      detail: {
        startup_failed: "Startup failed.",
        recovery_required: "Recovery is required.",
        stopping: "The runtime is stopping.",
        heartbeat_failed: "The heartbeat reported a failure.",
      }[l.blocker],
    };
  if (l.phase === "awake") {
    if (!l.heartbeatCurrent || !recent(l.lastHeardAt, now))
      return {
        label: "Last observed awake",
        detail: "Current heartbeat unavailable or stale. Readiness is unknown.",
      };
    return {
      label: l.ready ? "Ready" : "Starting",
      detail: l.ready
        ? "A current heartbeat reports ready."
        : "Waiting for startup to finish.",
    };
  }
  return {
    label: labels[l.phase],
    detail:
      l.phase === "asleep"
        ? "Sleeping normally; the last heartbeat is historical."
        : "Last successfully observed lifecycle state.",
  };
}
