import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AuthorityError, runtimeFetch } from "./api";
import { recent, type RuntimeStatus } from "./runtime-contracts";
import {
  wakeRecordSchema,
  wakeInputSchema,
  wakeMessage,
  type WakeRecord,
} from "./runtime-wake-contracts";
export function WakeControl({
  actor,
  status,
  readFailed,
  onSubmitted,
}: {
  actor: string;
  status: RuntimeStatus | null;
  readFailed: boolean;
  onSubmitted: () => void;
}) {
  const storageKey = `runtime-wake:${actor}`;
  const [saved] = useState(() => {
    try {
      const value = sessionStorage.getItem(storageKey);
      if (value && !wakeInputSchema.safeParse({ requestId: value }).success)
        throw new Error("Invalid saved request");
      return { id: value, error: "" };
    } catch {
      return {
        id: null,
        error:
          "Cannot read the pending wake request from browser storage. Restore storage access before waking.",
      };
    }
  });
  const [storageError, setStorageError] = useState(saved.error);
  const [requestId, setRequestId] = useState<string | null>(saved.id);
  const [record, setRecord] = useState<WakeRecord | null>(null);
  const uncertain =
    !!requestId && (!record || ["pending", "unknown"].includes(record.outcome));
  const wake = useMutation({
    retry: false,
    mutationFn: async (id: string) => {
      const response = await runtimeFetch(
        "/api/runtimes/overclaw-leader/wake",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: id }),
          signal: AbortSignal.timeout(12000),
        },
      );
      if (!response.ok)
        throw new Error(
          "Wake outcome is uncertain. Check the same request again.",
        );
      return wakeRecordSchema.parse(await response.json());
    },
    onSuccess: (result) => {
      setRecord(result);
      if (!["pending", "unknown"].includes(result.outcome)) {
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          setStorageError(
            "Could not clear the saved wake request. Restore browser storage access before another wake.",
          );
        }
      }
      onSubmitted();
    },
  });
  const current =
    !readFailed &&
    status?.lifecycle.availability === "available" &&
    recent(status.lifecycle.observedAt, Date.now() / 1000);
  const waiting =
    record?.outcome === "accepted" &&
    (!current || status!.lifecycle.observedAt! < record.request.requestedAt);
  const canStart = current && status!.lifecycle.phase === "asleep" && !waiting;
  return (
    <section className="runtime-card runtime-action">
      <h2>Wake FAMEliza</h2>
      <p>Bring the runtime online for scheduled work and incoming requests.</p>
      <button
        className="primary"
        disabled={!!storageError || wake.isPending || (!uncertain && !canStart)}
        onClick={() => {
          const id = uncertain ? requestId! : crypto.randomUUID();
          try {
            sessionStorage.setItem(storageKey, id);
          } catch {
            setStorageError(
              "Cannot preserve the request ID in browser storage. Wake was not submitted.",
            );
            return;
          }
          setRequestId(id);
          setRecord(null);
          wake.mutate(id);
        }}
      >
        {wake.isPending
          ? "Submitting wake…"
          : uncertain
            ? "Check / retry same request"
            : "Wake"}
      </button>
      {!uncertain && !canStart && !record && (
        <p>
          {!current
            ? "A fresh runtime observation is required before starting a wake."
            : "Wake is available when the runtime is asleep. Startup, shutdown, and recovery status appear below."}
        </p>
      )}
      {storageError && <p role="alert">{storageError}</p>}
      {record && <p role="status">{wakeMessage(record)}</p>}
      {wake.isError && !(wake.error instanceof AuthorityError) && (
        <p role="alert">
          Wake outcome is uncertain. Check the same request again before
          starting another.
        </p>
      )}
      {requestId && <small>Request {requestId}</small>}
    </section>
  );
}
