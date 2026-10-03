import { apiFetch } from "./api";
import { useState } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import {
  inboxStatusSchema,
  messagePageSchema,
  type CapturedMessage,
} from "./telegram-contracts";
async function get(path: string) {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error("Could not load Telegram data. Try again.");
  return response.json();
}
const time = (v: number) => new Date(v * 1000).toLocaleString();
export function TelegramInbox() {
  const [selected, setSelected] = useState("");
  const status = useQuery({
    queryKey: ["telegram-status"],
    queryFn: async () =>
      inboxStatusSchema.parse(await get("/api/telegram/status")),
    retry: false,
    refetchInterval: 30_000,
  });
  const chat = selected || status.data?.chats[0]?.id || "";
  const messages = useInfiniteQuery({
    queryKey: ["telegram-messages", chat],
    initialPageParam: null as string | null,
    enabled: !!chat && status.isSuccess,
    queryFn: async ({ pageParam }) =>
      messagePageSchema.parse(
        await get(
          `/api/telegram/messages?${new URLSearchParams({ chatId: chat, ...(pageParam ? { cursor: pageParam } : {}) })}`,
        ),
      ),
    getNextPageParam: (p) => p.cursor ?? undefined,
    refetchInterval: 30_000,
    retry: false,
  });

  return (
    <>
      <header>
        <div>
          <p className="eyebrow">TELEGRAM · READ ONLY</p>
          <h1>
            Message <em>inbox.</em>
          </h1>
          <p>Captured messages. No automated replies or moderation.</p>
        </div>
      </header>
      {status.isPending ? (
        <p>Checking connection…</p>
      ) : status.isError ? (
        <div role="alert">
          <p>Telegram status is unavailable.</p>
          <button onClick={() => void status.refetch()}>
            Retry connection check
          </button>
        </div>
      ) : (
        <section className="connection-panel">
          {"username" in status.data && (
            <div>
              <span className="eyebrow">SOCIETY BOT</span>
              <h2>@{status.data.username}</h2>
              <p>
                {status.data.registeredAt
                  ? `Webhook registration recorded ${new Date(status.data.registeredAt).toLocaleString()}`
                  : "Webhook not registered by this service"}
              </p>
              <small>
                Registration is configuration, not a live Telegram health check.
              </small>
            </div>
          )}
          <div>
            <p>
              {status.data.chats.length} group
              {status.data.chats.length === 1 ? "" : "s"} in inbox
            </p>
            {"queued" in status.data && (
              <>
                <p>
                  {status.data.queued} updates processing · {status.data.failed}{" "}
                  failed
                </p>
                <small>Queue counts are approximate.</small>
              </>
            )}
          </div>
        </section>
      )}

      {status.data && "failed" in status.data && status.data.failed ? (
        <p role="alert">
          Some updates could not be stored. They are held in the recovery queue
          for operator investigation.
        </p>
      ) : null}
      {status.data && !status.data.chats.length ? (
        <div className="empty">
          <h2>Choose the first group.</h2>
          <p>No groups with captured history are available to your account.</p>
        </div>
      ) : chat ? (
        <>
          <div className="telegram-toolbar">
            <label>
              Group{" "}
              <select
                value={chat}
                onChange={(e) => setSelected(e.target.value)}
              >
                {status.data?.chats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.state !== "active" ? " · capture stopped" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => void messages.refetch()}>
              Refresh messages
            </button>
          </div>
          <p className="capture-note">
            Last captured:{" "}
            {status.data?.chats.find((c) => c.id === chat)?.lastCapturedAt
              ? time(
                  status.data.chats.find((c) => c.id === chat)!.lastCapturedAt!,
                )
              : "No messages yet"}
            . A quiet group is not necessarily disconnected.
          </p>
          {messages.isPending ? (
            <p>Loading messages…</p>
          ) : messages.isError ? (
            <p role="alert">{messages.error.message}</p>
          ) : (
            <>
              <div className="telegram-messages">
                {messages.data?.pages
                  .flatMap((p) => p.items)
                  .map((m) => (
                    <Message key={`${m.chatId}:${m.messageId}`} message={m} />
                  ))}
              </div>
              {!messages.data?.pages.some((p) => p.items.length) && (
                <div className="empty">
                  <h2>No captured messages yet.</h2>
                  <p>
                    New group messages will appear here after webhook setup.
                    This is not a historical chat import.
                  </p>
                </div>
              )}
              {messages.hasNextPage && (
                <button
                  disabled={messages.isFetchingNextPage}
                  onClick={() => void messages.fetchNextPage()}
                >
                  Load older messages
                </button>
              )}
            </>
          )}
          <p className="capture-note">
            Captured text is untrusted. Telegram deletions may not be reflected
            here. Text and observed edits are retained for three years; media
            files are not downloaded.
          </p>
        </>
      ) : null}
    </>
  );
}
function Message({ message: m }: { message: CapturedMessage }) {
  const [history, setHistory] = useState(false);
  const revisions = useInfiniteQuery({
    queryKey: ["telegram-revisions", m.chatId, m.messageId, m.version],
    initialPageParam: null as string | null,
    enabled: history,
    retry: false,
    queryFn: async ({ pageParam }) =>
      messagePageSchema.parse(
        await get(
          `/api/telegram/messages?${new URLSearchParams({ chatId: m.chatId, messageId: m.messageId, ...(pageParam ? { cursor: pageParam } : {}) })}`,
        ),
      ),
    getNextPageParam: (p) => p.cursor ?? undefined,
  });
  return (
    <article className="telegram-message">
      <div className="telegram-message-meta">
        <strong>{m.author}</strong>
        <time>{time(m.sentAt)}</time>
      </div>
      <small>
        {m.username ? `@${m.username} · ` : ""}
        {m.senderId ?? "Unknown identity"} · Message {m.messageId}
      </small>
      <p className="message-body">{m.text}</p>
      {m.attachment && (
        <p>
          Attachment: {m.attachment.kind}
          {m.attachment.name ? ` · ${m.attachment.name}` : ""} · not downloaded
        </p>
      )}
      {m.editedAt && <p>Edited {time(m.editedAt)}</p>}
      <button
        className="text-button"
        aria-expanded={history}
        onClick={() => setHistory(!history)}
      >
        {history ? "Hide" : "Show"} captured history
      </button>
      {history && (
        <div className="revision-list">
          {revisions.isPending ? (
            <p>Loading history…</p>
          ) : revisions.isError ? (
            <p role="alert">History could not be loaded.</p>
          ) : (
            revisions.data?.pages
              .flatMap((p) => p.items)
              .map((v) => (
                <div key={v.version}>
                  <small>
                    {time(v.editedAt ?? v.sentAt)} · received{" "}
                    {time(v.receivedAt)}
                  </small>
                  <p className="message-body">{v.text}</p>
                </div>
              ))
          )}
          {revisions.hasNextPage && (
            <button
              disabled={revisions.isFetchingNextPage}
              onClick={() => void revisions.fetchNextPage()}
            >
              Older revisions
            </button>
          )}
        </div>
      )}
    </article>
  );
}
