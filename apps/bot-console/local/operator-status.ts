import { readFileSync } from "node:fs";
import { snapshotSchema, type RuntimeSnapshot } from "../src/runtime-contracts";
const fixture = snapshotSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../test/fixtures/operator-status/ready.json", import.meta.url),
      "utf8",
    ),
  ),
);
export const rehearsalScenarios = [
  "ready",
  "starting",
  "asleep",
  "recovery",
  "stale",
  "partial-failure",
  "no-observation",
  "historical-checkpoint",
  "unavailable",
] as const;
export type RehearsalScenario = (typeof rehearsalScenarios)[number];
export function rehearsalSnapshot(
  scenario: RehearsalScenario,
  now: number,
): RuntimeSnapshot | undefined {
  if (scenario === "no-observation") return undefined;
  const s = structuredClone(fixture);
  s.publishedAt = now;
  s.lifecycle.observedAt = now;
  s.lifecycle.lastHeardAt = now - 10;
  s.workers.observedAt = now;
  if (scenario === "starting") {
    s.lifecycle.phase = "launching";
    s.lifecycle.ready = false;
    s.lifecycle.startup = "restoring";
  }
  if (scenario === "asleep") {
    s.lifecycle.phase = "asleep";
    s.lifecycle.ready = false;
    s.lifecycle.lastHeardAt = now - 86400;
  }
  if (scenario === "recovery") {
    s.lifecycle.phase = "recovery";
    s.lifecycle.blocker = "recovery_required";
    s.lifecycle.ready = false;
  }
  if (scenario === "stale") {
    s.lifecycle.observedAt = now - 600;
    s.lifecycle.lastHeardAt = now - 600;
    s.workers.observedAt = now - 600;
  }
  if (scenario === "partial-failure") {
    s.workers.availability = "unavailable";
    s.workers.error = "reconcile_failed";
  }
  if (scenario === "historical-checkpoint") {
    s.lifecycle.checkpointCreatedAt = now - 86400;
  }
  return s;
}
