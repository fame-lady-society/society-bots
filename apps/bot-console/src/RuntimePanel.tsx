import { WakeControl } from "./WakeControl";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { runtimeFetch } from "./api";
import {
  runtimeResponseSchema,
  runtimePresentation,
  recent,
  type RuntimeStatus,
} from "./runtime-contracts";
const date = (at: number | null) =>
  at === null ? "Not observed" : new Date(at * 1000).toLocaleString();
function age(at: number | null, now: number) {
  return at === null
    ? "Never observed"
    : `${Math.max(0, Math.floor(now - at))} seconds ago`;
}
export function RuntimePanel({
  canWake = false,
  actor,
}: {
  canWake?: boolean;
  actor: string;
}) {
  const [visible, setVisible] = useState(
    document.visibilityState === "visible",
  );
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const visibility = () => {
      setVisible(document.visibilityState === "visible");
      setNow(Date.now() / 1000);
    };
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);
  const status = useQuery({
    queryKey: ["runtime-status", "overclaw-leader"],
    retry: false,
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const response = await runtimeFetch(
        "/api/runtimes/overclaw-leader/status",
        { signal, cache: "no-store" },
      );
      if (!response.ok)
        throw new Error("Runtime status unavailable. Try again shortly.");
      return runtimeResponseSchema.parse(await response.json());
    },
  });
  return (
    <>
      <header className="runtime-header">
        <p className="eyebrow">OVERCLAW · RUNTIME</p>
        <h1>
          FAMEliza <em>runtime.</em>
        </h1>
        <p>
          Observed runtime status. Updated every 30 seconds while this page is
          visible.
        </p>
      </header>
      {canWake && (
        <WakeControl
          actor={actor}
          status={status.data?.status ?? null}
          readFailed={status.isError}
          onSubmitted={() => void status.refetch()}
        />
      )}
      {status.isPending && <p role="status">Reading runtime status…</p>}
      {status.isError && (
        <div className="notice" role="alert">
          {status.error.message}
          {status.data?.status &&
            " The evidence below is from the last successful fetch."}
        </div>
      )}
      {status.data?.status === null && (
        <section className="runtime-card">
          <h2>No observation yet</h2>
          <p>
            The runtime has not published its first status snapshot. This does
            not mean it is asleep.
          </p>
        </section>
      )}
      {status.data?.status && (
        <RuntimeEvidence
          status={status.data.status}
          now={now}
          readFailed={status.isError}
        />
      )}
    </>
  );
}
export function RuntimeEvidence({
  status,
  now,
  readFailed = false,
}: {
  status: RuntimeStatus;
  now: number;
  readFailed?: boolean;
}) {
  const l = status.lifecycle;
  const w = status.workers;
  const presentation = runtimePresentation(status, now);
  const workersCurrent =
    !readFailed &&
    w.availability === "available" &&
    recent(w.observedAt, now) &&
    w.counts !== null;
  return (
    <div className="runtime-grid">
      <section className="runtime-card">
        <p className="eyebrow">LIFECYCLE</p>
        <h2>{readFailed ? "Status unavailable" : presentation.label}</h2>
        <p>
          {readFailed
            ? "Current status could not be fetched. Last recorded evidence is shown below."
            : presentation.detail}
        </p>
        <dl>
          <dt>Lifecycle observation</dt>
          <dd>
            {age(l.observedAt, now)}
            <small>{date(l.observedAt)}</small>
          </dd>
          <dt>Startup stage</dt>
          <dd>{l.startup ? `${l.startup} (last observed)` : "Not reported"}</dd>
          <dt>Last heard</dt>
          <dd>
            {date(l.lastHeardAt)}
            <small>
              {age(l.lastHeardAt, now)} ·{" "}
              {l.phase === "asleep" ||
              !l.heartbeatCurrent ||
              !recent(l.lastHeardAt, now)
                ? "historical heartbeat"
                : "current generation"}
            </small>
          </dd>
        </dl>
      </section>
      <section className="runtime-card">
        <p className="eyebrow">SEPARATE EC2 WORKERS</p>
        <h2>
          {workersCurrent ? `${w.total} observed` : "Worker status unknown"}
        </h2>
        <p>
          {w.availability === "unavailable"
            ? "The latest fleet observation failed. Counts are unavailable."
            : !workersCurrent
              ? "No complete, fresh fleet observation is available."
              : "Complete counts by worker phase; these are separate compute workers."}
        </p>
        <p className="runtime-time">
          Fleet observed {age(w.observedAt, now)}
          <small>{date(w.observedAt)}</small>
        </p>
        {workersCurrent && w.counts && (
          <dl>
            {Object.entries(w.counts).map(([phase, count]) => (
              <div className="runtime-count" key={phase}>
                <dt>{phase}</dt>
                <dd>{count}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section className="runtime-card">
        <p className="eyebrow">SAVED WORK</p>
        <h2 title="Changes since this checkpoint may not be saved">
          Last successful checkpoint
        </h2>
        <p>
          {date(l.checkpointCreatedAt)}
          <small>{age(l.checkpointCreatedAt, now)}</small>
        </p>
      </section>
      <section className="runtime-card">
        <p className="eyebrow">DEPLOYMENT</p>
        <h2>Recorded launch version</h2>
        <p>{l.launchVersion ?? "Not available"}</p>
        <p>
          Launch-template version recorded for this generation, not a running
          binary digest or Git commit.
        </p>
        <small>
          Snapshot #{status.revision} · published {date(status.publishedAt)}.
          Publication time is not a health check.
        </small>
      </section>
    </div>
  );
}
