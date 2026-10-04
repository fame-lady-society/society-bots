import { apiFetch } from "./api";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { sessionSchema } from "./contracts";
import {
  roles,
  permits,
  accessViewSchema,
  type Principal,
} from "./access-contracts";
const date = (n: number) => new Date(n * 1000).toLocaleString();
const blank: Principal = {
  id: "discord:",
  kind: "human",
  name: "",
  enabled: true,
  grants: [],
  sessionVersion: 0,
};
export function AccessPanel({
  session,
  onAccessChange,
}: {
  session: z.infer<typeof sessionSchema>;
  onAccessChange: () => void;
}) {
  const owner = permits(session.principal, "access.manage");
  const client = useQueryClient();
  const access = useQuery({
    queryKey: ["access"],
    enabled: owner,
    retry: false,
    refetchInterval: 30000,
    queryFn: async () => {
      const r = await apiFetch("/api/access");
      if (!r.ok)
        throw new Error(
          "Could not load access. Your owner access may have changed.",
        );
      return accessViewSchema.parse(await r.json());
    },
  });
  const [edit, setEdit] = useState<{
    principal: Principal;
    version: number;
    existing: boolean;
  } | null>(null);
  const save = useMutation({
    mutationFn: async ({
      p,
      version,
      revokeSessions,
    }: {
      p: Principal;
      version: number;
      revokeSessions: boolean;
    }) => {
      const { sessionVersion, ...principal } = p;
      const r = await apiFetch("/api/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, principal, revokeSessions }),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.error ?? "Could not save access.");
      }
    },
    onSuccess: async () => {
      setEdit(null);
      await client.invalidateQueries({ queryKey: ["access"] });
      onAccessChange();
    },
  });
  const change = (patch: Partial<Principal>) =>
    edit && setEdit({ ...edit, principal: { ...edit.principal, ...patch } });
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">SOCIETY ACCESS</p>
          <h1>
            {owner ? "People, agents" : "Your"}
            <br />
            <em>{owner ? "& permissions." : "permissions."}</em>
          </h1>
          <p>Explicit roles. Scoped access. Owner-controlled changes.</p>
        </div>
        <span className="pill">{owner ? "Owner" : "Member"}</span>
      </header>
      <section className="connection-panel">
        <div>
          <h2>Signed in as {session.user.name}</h2>
          <p>{session.principal.id}</p>
          <p>Session expires {date(session.expires)}. Visible tabs renew it.</p>
          <small>
            Sign in again by {date(session.absoluteExpires)}. Sessions last 7
            days without renewal, with a 30-day maximum.
          </small>
        </div>
        <div>
          <h3>Your roles</h3>
          {session.principal.grants.map((g, i) => (
            <p key={i}>
              {roles[g.role].name} · {g.scope}
            </p>
          ))}
        </div>
      </section>
      <section className="access-catalog">
        <h2>Roles & permissions</h2>
        <div className="access-cards">
          {Object.entries(roles).map(([id, role]) => (
            <article key={id}>
              <h3>{role.name}</h3>
              <p>{role.description}</p>
              <small>{role.permissions.join(" · ")}</small>
            </article>
          ))}
        </div>
      </section>
      {owner && (
        <>
          <div className="telegram-toolbar">
            <h2>People, agents & services</h2>
            <button
              disabled={!access.data || save.isPending}
              onClick={() => {
                save.reset();
                setEdit({
                  principal: structuredClone(blank),
                  version: access.data!.policy.version,
                  existing: false,
                });
              }}
            >
              Add identity
            </button>
          </div>
          <p>
            Only Discord-bound people can sign in. Agent and service entries do
            not issue credentials or change Overclaw or vault permissions.
          </p>
          {access.isPending ? (
            <p>Loading access…</p>
          ) : access.isError ? (
            <p role="alert">
              {access.error.message}{" "}
              <button onClick={() => void access.refetch()}>Retry</button>
            </p>
          ) : (
            <div className="access-cards">
              {access.data.policy.principals.map((p) => (
                <article key={p.id}>
                  <div className="telegram-toolbar">
                    <h3>{p.name}</h3>
                    <span className="pill">
                      {p.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <p>
                    {p.kind} · {p.id}
                  </p>
                  {p.grants.length ? (
                    p.grants.map((g, i) => (
                      <p key={i}>
                        <strong>{roles[g.role].name}</strong> · {g.scope}
                      </p>
                    ))
                  ) : (
                    <p>No assigned roles</p>
                  )}
                  {p.kind !== "human" && (
                    <small>No runtime authentication connected</small>
                  )}
                  <div className="telegram-toolbar">
                    <button
                      onClick={() => {
                        save.reset();
                        setEdit({
                          principal: structuredClone(p),
                          version: access.data.policy.version,
                          existing: true,
                        });
                      }}
                    >
                      Edit access
                    </button>
                    {p.kind === "human" && (
                      <button
                        disabled={save.isPending}
                        onClick={() => {
                          if (confirm(`Sign out every session for ${p.name}?`))
                            save.mutate({
                              p,
                              version: access.data.policy.version,
                              revokeSessions: true,
                            });
                        }}
                      >
                        Revoke sessions
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {edit && (
            <section className="access-editor">
              <h2>{edit.existing ? "Edit access" : "Add identity"}</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate({
                    p: edit.principal,
                    version: edit.version,
                    revokeSessions: false,
                  });
                }}
              >
                <label>
                  Name
                  <input
                    required
                    maxLength={80}
                    value={edit.principal.name}
                    onChange={(e) => change({ name: e.target.value })}
                  />
                </label>
                <label>
                  Kind
                  <select
                    disabled={edit.existing}
                    value={edit.principal.kind}
                    onChange={(e) => {
                      const kind = e.target.value as Principal["kind"];
                      change({
                        ...blank,
                        kind,
                        id: kind === "human" ? "discord:" : `${kind}:`,
                      });
                    }}
                  >
                    <option value="human">Person (Discord)</option>
                    <option value="agent">Agent</option>
                    <option value="service">Service</option>
                  </select>
                </label>
                <label>
                  Identity ID
                  <input
                    required
                    disabled={edit.existing}
                    value={edit.principal.id}
                    placeholder="discord:123456789012345678"
                    onChange={(e) => change({ id: e.target.value })}
                  />
                  <small>
                    People: discord:numeric-user-id. Others: agent:name or
                    service:name.
                  </small>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={edit.principal.enabled}
                    onChange={(e) => change({ enabled: e.target.checked })}
                  />{" "}
                  Enabled
                </label>
                <fieldset>
                  <legend>Scoped roles</legend>
                  {edit.principal.grants.map((g, i) => (
                    <div className="access-grant" key={i}>
                      <label>
                        Role
                        <select
                          value={g.role}
                          onChange={(e) => {
                            const grants = [...edit.principal.grants];
                            const role = e.target.value as typeof g.role;
                            grants[i] = {
                              role,
                              scope:
                                role === "reader"
                                  ? ""
                                  : role === "operator-viewer"
                                    ? "runtime:overclaw-leader"
                                    : "*",
                            };
                            change({ grants });
                          }}
                        >
                          {Object.entries(roles)
                            .filter(
                              ([id]) =>
                                edit.principal.kind === "human" ||
                                id !== "owner",
                            )
                            .map(([id, r]) => (
                              <option key={id} value={id}>
                                {r.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Scope
                        {g.role === "operator-viewer" ? (
                          <select
                            value="runtime:overclaw-leader"
                            aria-label="Runtime scope"
                          >
                            <option value="runtime:overclaw-leader">
                              FAMEliza · Overclaw
                            </option>
                          </select>
                        ) : (
                          <input
                            required
                            placeholder="telegram:-100… or telegram:*"
                            value={g.scope}
                            disabled={g.role !== "reader"}
                            onChange={(e) => {
                              const grants = [...edit.principal.grants];
                              grants[i] = { ...g, scope: e.target.value };
                              change({ grants });
                            }}
                          />
                        )}
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          change({
                            grants: edit.principal.grants.filter(
                              (_, j) => j !== i,
                            ),
                          })
                        }
                      >
                        Remove role
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={edit.principal.grants.length >= 20}
                    onClick={() =>
                      change({
                        grants: [
                          ...edit.principal.grants,
                          { role: "reader", scope: "" },
                        ],
                      })
                    }
                  >
                    Add role
                  </button>
                  <p>
                    Reader scope: telegram:* for all groups, or telegram:-100…
                    for one group. Operator viewers see the named runtime only.
                    Owners and connection managers use *.
                  </p>
                </fieldset>
                <p>
                  Disabling a person revokes their sessions. At least one
                  enabled human owner must remain.
                </p>
                <button disabled={save.isPending} type="submit">
                  {save.isPending ? "Saving…" : "Save access"}
                </button>{" "}
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => setEdit(null)}
                >
                  Cancel
                </button>
              </form>
            </section>
          )}
          {save.isError && <p role="alert">{save.error.message}</p>}
          <section className="access-audit">
            <h2>Access history</h2>
            <p>
              Latest 50 changes. Changes and audit receipts are saved together.
            </p>
            {access.data?.audit.length ? (
              access.data.audit.map((a) => (
                <article key={a.id}>
                  <strong>
                    {a.action} · {a.after.name}
                  </strong>
                  <p>
                    {date(a.at)} · {a.actor}
                  </p>
                  <small>
                    {a.target} · {a.after.enabled ? "enabled" : "disabled"} ·{" "}
                    {a.after.grants
                      .map((g) => `${g.role} (${g.scope})`)
                      .join(", ") || "no roles"}
                  </small>
                </article>
              ))
            ) : (
              <p>No access changes recorded yet.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
