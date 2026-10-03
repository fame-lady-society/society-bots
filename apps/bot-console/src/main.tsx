import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { casesSchema, sessionSchema, type Incident } from "./contracts";
import "./style.css";
import { TelegramInbox } from "./TelegramInbox";
async function request(path: string, options?: RequestInit) {
  const r = await fetch(path, options);
  if (r.status === 401) throw new Error("SIGN_IN");
  if (!r.ok)
    throw new Error(
      "The request could not be completed. Refresh and try again.",
    );
  return r.status === 204 ? null : r.json();
}
function App() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => sessionSchema.parse(await request("/api/session")),
    retry: false,
    refetchInterval: 60_000,
  });
  if (session.isPending)
    return <div className="center">Opening your console…</div>;
  if (session.isError)
    return (
      <div className="login-page">
        <div className="login-masthead">
          <a href="https://www.fameladysociety.com/fame">$FAME</a>
          <span>SOCIETY OPERATIONS</span>
        </div>
        <div className="login">
          <p className="eyebrow">FAME LADY SOCIETY · OPERATOR ACCESS</p>
          <h1>
            Behind
            <br />
            <em>the Society.</em>
          </h1>
          <p>
            FAMEliza’s private operator workspace.
            <br />
            Access is limited to approved operators.
          </p>
          {session.error.message === "SIGN_IN" ? (
            <a className="primary" href="/api/auth/login">
              {import.meta.env.DEV
                ? "Open local rehearsal"
                : "Continue with Discord"}{" "}
              <span>↗</span>
            </a>
          ) : (
            <>
              <p role="alert">Authentication is unavailable.</p>
              <button onClick={() => void session.refetch()}>Try again</button>
            </>
          )}
          <small>Discord identity · Approved operators only</small>
        </div>
      </div>
    );
  return (
    <Console name={session.data.user.name} rehearsal={session.data.rehearsal} />
  );
}
function Console({ name, rehearsal }: { name: string; rehearsal: boolean }) {
  const client = useQueryClient();
  const [view, setView] = useState<"telegram" | "moderation">("telegram");
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState("pending");
  const [confirm, setConfirm] = useState(false);
  const cases = useQuery({
    queryKey: ["cases"],
    queryFn: async () => casesSchema.parse(await request("/api/cases")),
    refetchInterval: 30_000,
  });
  const decision = useMutation({
    mutationFn: async ({ id, value }: { id: string; value: string }) =>
      request(`/api/cases/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: value }),
      }),
    onSuccess: () => {
      setConfirm(false);
      void client.invalidateQueries({ queryKey: ["cases"] });
    },
  });
  const logout = useMutation({
    mutationFn: () => request("/api/auth/logout", { method: "POST" }),
    onSuccess: () => {
      client.clear();
      location.assign("/");
    },
  });
  const all = cases.data ?? [];
  const visible = all.filter((i) => filter === "all" || i.status === filter);
  const incident = all.find((i) => i.id === selected) ?? visible[0];
  if (cases.error?.message === "SIGN_IN")
    return (
      <div className="center">
        <a href="/api/auth/login">Your session expired. Sign in again.</a>
      </div>
    );
  return (
    <div className="layout">
      <aside>
        <a className="brand" href="/">
          <span className="mark">F</span>
          <span>
            FAMEliza<small>SOCIETY OPERATIONS</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-label">WORKSPACE</span>
          Fame Lady Society
        </div>
        <nav>
          <button
            className={view === "telegram" ? "active" : ""}
            aria-pressed={view === "telegram"}
            onClick={() => setView("telegram")}
          >
            Telegram inbox
          </button>
          <button
            className={view === "moderation" ? "active" : ""}
            aria-pressed={view === "moderation"}
            onClick={() => setView("moderation")}
          >
            ◫ <span>Moderation inbox</span>
            <b>{all.filter((i) => i.status === "pending").length}</b>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <p>
            For the
            <br />
            <em>Society.</em>
          </p>
          <small>{name}</small>
          <button className="text-button" onClick={() => logout.mutate()}>
            Sign out ↗
          </button>
          {logout.isError && (
            <small role="alert">Sign out failed. Try again.</small>
          )}
        </div>
      </aside>
      <main>
        {view === "telegram" ? (
          <>
            {rehearsal && (
              <div className="notice">
                Local rehearsal · Synthetic Telegram messages only.
              </div>
            )}
            <TelegramInbox />
          </>
        ) : (
          <>
            <header>
              <div>
                <p className="eyebrow">COMMUNITY OPERATIONS</p>
                <h1>
                  Society <em>inbox.</em>
                </h1>
                <p>Review the context. Decide what happens next.</p>
              </div>
              <span className="pill">
                {rehearsal ? "Local rehearsal" : "Private workspace"}
              </span>
            </header>
            {rehearsal && (
              <div className="notice">
                <b>Rehearsal workspace</b>
                <span>
                  Synthetic messages only. Decisions here never reach Discord or
                  Telegram.
                </span>
              </div>
            )}
            <section className="stats">
              <div>
                <small>AWAITING REVIEW</small>
                <strong>
                  {all
                    .filter((i) => i.status === "pending")
                    .length.toString()
                    .padStart(2, "0")}
                </strong>
              </div>
              <div>
                <small>CAPTURED MESSAGES</small>
                <strong>
                  {all.reduce((n, i) => n + i.messages.length, 0)}
                </strong>
              </div>
              <div>
                <small>ENFORCEMENT</small>
                <strong className="words">Human approval</strong>
              </div>
            </section>
            <div className="toolbar">
              <div role="group" aria-label="Case filter">
                {["pending", "all"].map((f) => (
                  <button
                    className={filter === f ? "chosen" : ""}
                    key={f}
                    onClick={() => {
                      setFilter(f);
                      setSelected(undefined);
                      setConfirm(false);
                    }}
                  >
                    {f === "pending" ? "Needs review" : "All cases"}
                  </button>
                ))}
              </div>
              <button
                className="text-button"
                onClick={() => void cases.refetch()}
              >
                Refresh ↻
              </button>
            </div>
            {cases.isError ? (
              <p role="alert">Could not load cases. Try refreshing.</p>
            ) : cases.isPending ? (
              <p>Loading cases…</p>
            ) : !all.length ? (
              <div className="empty">
                <div className="empty-icon" aria-hidden="true">
                  ◫
                </div>
                <h2>A clear inbox.</h2>
                <p>
                  No messages received yet. Channels have not been connected.
                </p>
              </div>
            ) : (
              <div className="split">
                <div className="case-list">
                  {visible.length === 0 ? (
                    <p>No cases need review.</p>
                  ) : (
                    visible.map((i) => (
                      <button
                        key={i.id}
                        className={`case ${incident?.id === i.id ? "selected" : ""}`}
                        onClick={() => {
                          setSelected(i.id);
                          setConfirm(false);
                          decision.reset();
                        }}
                      >
                        <div>
                          <span className="platform">{i.platform}</span>
                          <span className="case-id">{i.id}</span>
                        </div>
                        <h3>{i.title}</h3>
                        <p>{i.subject}</p>
                        <small>
                          {i.messages.length} messages <span>· {i.status}</span>
                        </small>
                      </button>
                    ))
                  )}
                </div>
                {incident && (
                  <article key={incident.id}>
                    <div className="detail-top">
                      <span className="eyebrow">{incident.channel}</span>
                      <span className="pill">{incident.status}</span>
                    </div>
                    <h2>{incident.title}</h2>
                    <p>{incident.reason}</p>
                    <div className="proposal">
                      <small>PROPOSED ACTION</small>
                      <h3>{incident.action}</h3>
                      <p>Target: {incident.subject}</p>
                    </div>
                    <div className="evidence-title">
                      <h3>Captured evidence</h3>
                      <span>{incident.messages.length} messages</span>
                    </div>
                    <div
                      className="evidence"
                      tabIndex={0}
                      aria-label="Captured evidence"
                    >
                      {incident.messages.map((m) => (
                        <div className="message" key={m.id}>
                          <div>
                            <b>{m.author}</b>
                            <time>{m.time}</time>
                          </div>
                          <p>{m.text}</p>
                        </div>
                      ))}
                    </div>
                    {rehearsal && incident.status === "pending" && (
                      <div className="actions">
                        {confirm ? (
                          <>
                            <p>
                              Record simulated approval for{" "}
                              <b>{incident.action}</b>? No platform action will
                              execute.
                            </p>
                            <button
                              className="primary"
                              disabled={decision.isPending}
                              onClick={() =>
                                decision.mutate({
                                  id: incident.id,
                                  value: "approved",
                                })
                              }
                            >
                              Confirm simulated approval
                            </button>
                            <button onClick={() => setConfirm(false)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="primary"
                              onClick={() => {
                                setSelected(incident.id);
                                setConfirm(true);
                              }}
                            >
                              Review approval →
                            </button>
                            <button
                              disabled={decision.isPending}
                              onClick={() =>
                                decision.mutate({
                                  id: incident.id,
                                  value: "rejected",
                                })
                              }
                            >
                              Reject proposal
                            </button>
                          </>
                        )}
                        {decision.isError && (
                          <p role="alert">{decision.error.message}</p>
                        )}
                      </div>
                    )}
                    {incident.status !== "pending" && (
                      <p className="receipt">
                        {rehearsal
                          ? "Simulation recorded"
                          : "Decision recorded"}
                        : {incident.status}.{" "}
                        {rehearsal ? "No external action was taken." : ""}
                      </p>
                    )}
                  </article>
                )}
              </div>
            )}
          </>
        )}
        <footer>
          FAMEliza · Operator console{" "}
          <span>
            {rehearsal ? "No external connections" : "bot.fame.support"}
          </span>
        </footer>
      </main>
    </div>
  );
}
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
});
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
