import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  groupsSchema,
  inviteSchema,
  issuedInviteSchema,
  type TelegramGroup,
} from "./telegram-groups-contracts";
async function request(path: string, body?: unknown) {
  const response = await fetch(
    `/api/telegram/${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (response.status === 401)
    throw new Error("Session expired. Sign in again.");
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : "Telegram unavailable. Try again.",
    );
  }
  return response.status === 204 ? null : response.json();
}
export function TelegramGroups() {
  const client = useQueryClient();
  const [issued, setIssued] = useState<ReturnType<
    typeof issuedInviteSchema.parse
  > | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const groups = useQuery({
    queryKey: ["telegram-groups"],
    queryFn: async () => groupsSchema.parse(await request("groups")),
    refetchInterval: 5000,
    retry: false,
  });
  const invite = useQuery({
    queryKey: ["telegram-invite", issued?.id],
    queryFn: async () =>
      inviteSchema.parse(await request(`invites/${issued!.id}`)),
    enabled: !!issued,
    refetchInterval: issued && seconds > 0 ? 3000 : false,
    retry: false,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["telegram-groups"] }),
      client.invalidateQueries({ queryKey: ["telegram-status"] }),
      client.invalidateQueries({ queryKey: ["telegram-invite"] }),
    ]);
  };
  const issue = useMutation({
    mutationFn: async () => {
      if (
        issued &&
        (invite.data?.state ?? issued.state) === "available" &&
        seconds > 0
      )
        await request(`invites/${issued.id}/revoke`, {});
      return issuedInviteSchema.parse(await request("invites", {}));
    },
    onSuccess: (data) => {
      setIssued(data);
      setCopyStatus("");
    },
  });
  const revoke = useMutation({
    mutationFn: () => request(`invites/${issued!.id}/revoke`, {}),
    onSuccess: refresh,
  });
  const decision = useMutation({
    mutationFn: ({
      group,
      action,
    }: {
      group: TelegramGroup;
      action: "approve" | "reject" | "disconnect";
    }) =>
      request(`groups/${group.id}/decision`, {
        requestId: group.requestId,
        action,
      }),
    onSuccess: refresh,
    onError: refresh,
  });
  useEffect(() => {
    const tick = () =>
      setSeconds(
        Math.max(0, Math.ceil((issued?.expires ?? 0) - Date.now() / 1000)),
      );
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [issued]);
  const state = invite.data?.state ?? issued?.state;
  const valid = state === "available" && seconds > 0;
  const error =
    groups.error ??
    invite.error ??
    issue.error ??
    revoke.error ??
    decision.error;
  return (
    <section className="telegram-groups" aria-labelledby="groups-title">
      <div className="telegram-toolbar">
        <h2 id="groups-title">Group connections</h2>
        <button
          disabled={issue.isPending || revoke.isPending}
          onClick={() => issue.mutate()}
        >
          Connect group
        </button>
      </div>
      <p>
        Add @famesocietybot as a group administrator, then send a connection
        command in that group. Review the request here to start capture.
      </p>
      {error && (
        <p role="alert">
          {error.message}{" "}
          {error.message.includes("Sign in") ? (
            <a href="/api/auth/login">Sign in</a>
          ) : (
            <button onClick={() => void refresh()}>Refresh</button>
          )}
        </p>
      )}
      {issued && (
        <div className="invite-card">
          <h3>
            {state === "used"
              ? "Code redeemed"
              : state === "revoked"
                ? "Code revoked"
                : valid
                  ? "Send this command in your group"
                  : "Code expired"}
          </h3>
          {valid && (
            <>
              <code>{issued.command}</code>
              <p>
                Expires in {Math.floor(seconds / 60)}:
                {String(seconds % 60).padStart(2, "0")}. Single use. Anyone with
                this code can request a connection.
              </p>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issued.command);
                    setCopyStatus("Copied");
                  } catch {
                    setCopyStatus("Select the command and copy it manually.");
                  }
                }}
              >
                Copy command
              </button>{" "}
              <button
                disabled={revoke.isPending || issue.isPending}
                onClick={() => revoke.mutate()}
              >
                Revoke code
              </button>
              <span role="status"> {copyStatus}</span>
            </>
          )}
          {state === "used" && (
            <p>
              This code cannot be reused. Manage the connection below; pending
              requests still need approval before capture starts.
            </p>
          )}
          {!valid && (
            <button disabled={issue.isPending} onClick={() => issue.mutate()}>
              Generate another code
            </button>
          )}
        </div>
      )}
      {groups.isPending ? (
        <p>Loading groups…</p>
      ) : !groups.data?.length ? (
        <p>No group connections yet.</p>
      ) : (
        <ul className="group-connections">
          {groups.data.map((group) => (
            <li key={group.id}>
              <div>
                <strong>{group.name}</strong>
                <span className={`group-state ${group.state}`}>
                  {group.state}
                </span>
                <p>
                  <code>{group.id}</code> · Requested by Telegram user{" "}
                  {group.requestedBy}
                </p>
                <small>
                  Code issued by console user {group.createdBy}. Last updated{" "}
                  {new Date(group.updatedAt * 1000).toLocaleString()} by{" "}
                  {group.updatedBy}.
                </small>
              </div>
              <div>
                {group.state === "pending" && (
                  <>
                    <button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({ group, action: "approve" })
                      }
                    >
                      Approve capture
                    </button>{" "}
                    <button
                      disabled={decision.isPending}
                      onClick={() =>
                        decision.mutate({ group, action: "reject" })
                      }
                    >
                      Reject
                    </button>
                  </>
                )}
                {group.state === "active" && (
                  <button
                    disabled={decision.isPending}
                    onClick={() =>
                      decision.mutate({ group, action: "disconnect" })
                    }
                  >
                    Disconnect
                  </button>
                )}
                {group.state === "disconnected" && (
                  <small>Capture stopped. Existing history retained.</small>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
