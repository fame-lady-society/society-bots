import React, { useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { sessionSchema } from "./contracts";
import { permits } from "./access-contracts";
import { AccessPanel } from "./AccessPanel";
import { TelegramInbox } from "./TelegramInbox";
import { TelegramGroups } from "./TelegramGroups";
import "./style.css";
function App() {
  const [view, setView] = useState("access");
  const session = useQuery({
    queryKey: ["session"],
    retry: false,
    refetchInterval: 60000,
    queryFn: async () => {
      const r = await fetch("/api/session", {
        method:
          !import.meta.env.DEV && document.visibilityState === "visible"
            ? "POST"
            : "GET",
      });
      if (!r.ok)
        throw new Error(
          r.status === 401 ? "Sign in required" : "Authentication unavailable",
        );
      return sessionSchema.parse(await r.json());
    },
  });
  const [logoutError, setLogoutError] = useState("");
  if (session.isPending)
    return <div className="center">Opening your console…</div>;
  if (session.isError)
    return (
      <div className="login-page">
        <div className="login">
          <p className="eyebrow">SOCIETY OPERATIONS</p>
          <h1>
            Behind
            <br />
            <em>the Society.</em>
          </h1>
          <p>{session.error.message}</p>
          <a className="primary" href="/api/auth/login">
            {import.meta.env.DEV
              ? "Open local rehearsal"
              : "Continue with Discord"}{" "}
            ↗
          </a>
        </div>
      </div>
    );
  const { principal, rehearsal } = session.data;
  const owner = permits(principal, "access.manage");
  const reader = principal.grants.some(
    (g) => g.role === "owner" || g.role === "reader",
  );
  const manager = permits(principal, "connections.manage");
  const current =
    (view === "telegram" && !reader) || (view === "connections" && !manager)
      ? "access"
      : view;
  return (
    <div className="layout">
      <aside>
        <a className="brand" href="/">
          <span className="mark">F</span>
          <span>
            FAMEliza<small>SOCIETY OPERATIONS</small>
          </span>
        </a>
        <nav>
          {[
            ["access", owner ? "Access & roles" : "My access"],
            ["telegram", "Telegram inbox"],
            ["connections", "Connections"],
          ]
            .filter(
              ([v]) => v === "access" || (v === "telegram" ? reader : manager),
            )
            .map(([v, label]) => (
              <button
                key={v}
                className={current === v ? "active" : ""}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <small>{session.data.user.name}</small>
          <button
            onClick={async () => {
              const r = await fetch("/api/auth/logout", { method: "POST" });
              if (r.ok) {
                location.assign("/");
              } else setLogoutError("Could not sign out. Try again.");
            }}
          >
            Sign out ↗
          </button>
          {logoutError && <p role="alert">{logoutError}</p>}
        </div>
      </aside>
      <main>
        {rehearsal && (
          <div className="notice">
            Local rehearsal · Synthetic identities and data
          </div>
        )}
        <DataBoundary
          key={JSON.stringify(principal)}
          authority={JSON.stringify(principal)}
        >
          {current === "access" ? (
            <AccessPanel
              session={session.data}
              onAccessChange={() => void session.refetch()}
            />
          ) : current === "telegram" ? (
            <TelegramInbox />
          ) : (
            <>
              <header>
                <h1>
                  Group <em>connections.</em>
                </h1>
              </header>
              <TelegramGroups />
            </>
          )}
        </DataBoundary>
      </main>
    </div>
  );
}
function DataBoundary({
  authority,
  children,
}: {
  authority: string;
  children: React.ReactNode;
}) {
  const cache = useMemo(() => new QueryClient(), [authority]);
  return <QueryClientProvider client={cache}>{children}</QueryClientProvider>;
}
const client = new QueryClient();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
