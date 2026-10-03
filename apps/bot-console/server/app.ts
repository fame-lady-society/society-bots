import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";

import { GroupConflict, type GroupService } from "./telegram-groups";

export interface RecordValue {
  expires: number;
  absoluteExpires?: number;
  userId?: string;
  name?: string;
}
export interface Store {
  put(key: string, value: RecordValue): Promise<void>;
  get(key: string): Promise<RecordValue | undefined>;
  take(key: string): Promise<RecordValue | undefined>;
  renew(key: string, now: number, expires: number): Promise<boolean>;
}
export interface Identity {
  id: string;
  username: string;
  mfa_enabled?: boolean;
  bot?: boolean;
}
export interface Dependencies {
  origin: string;
  adminIds: string[];
  store: Store;
  oauth: {
    url(state: string): string;
    identity(code: string): Promise<Identity>;
  };
  telegram?: {
    status(): Promise<unknown>;
    messages(
      chatId: string,
      cursor?: string,
      messageId?: string,
    ): Promise<unknown>;
  };
  groups?: GroupService;
  now?: () => number;
}
const sessionCookie = "__Host-bot-session";
const stateCookie = "__Host-bot-state";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const validToken = (value: string | undefined): value is string =>
  !!value && /^[A-Za-z0-9_-]{43}$/.test(value);
export function createApp(deps: Dependencies) {
  if (
    new URL(deps.origin).protocol !== "https:" ||
    deps.adminIds.length === 0 ||
    deps.adminIds.some((id) => !/^\d{17,20}$/.test(id))
  )
    throw new Error("Invalid admin configuration");
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono<{ Variables: { actor: string } }>();
  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.onError((_error, c) =>
    c.json({ error: "Service unavailable. Please try again." }, 503),
  );
  app.get("/api/auth/login", async (c) => {
    const state = token();
    await deps.store.put(`state#${digest(state)}`, { expires: now() + 300 });
    setCookie(c, stateCookie, state, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 300,
    });
    return c.redirect(deps.oauth.url(state));
  });
  app.get("/api/auth/callback", async (c) => {
    const state = c.req.query("state");
    const cookie = getCookie(c, stateCookie);
    deleteCookie(c, stateCookie, { secure: true, path: "/" });
    if (!validToken(state) || !validToken(cookie) || state !== cookie)
      return c.json({ error: "Invalid login request. Start again." }, 400);
    const saved = await deps.store.take(`state#${digest(state)}`);
    if (!saved || saved.expires <= now())
      return c.json({ error: "Login expired. Start again." }, 400);
    const code = c.req.query("code");
    if (!code || code.length > 2048)
      return c.json({ error: "Login was not completed." }, 400);
    const identity = await deps.oauth.identity(code);
    if (
      !deps.adminIds.includes(identity.id) ||
      identity.bot ||
      identity.mfa_enabled !== true
    )
      return c.json(
        {
          error:
            "Access requires an approved administrator with Discord MFA enabled.",
        },
        403,
      );
    const old = getCookie(c, sessionCookie);
    if (validToken(old)) await deps.store.take(`session#${digest(old)}`);
    const session = token();
    await deps.store.put(`session#${digest(session)}`, {
      expires: now() + 900,
      absoluteExpires: now() + 12 * 3600,
      userId: identity.id,
      name: identity.username,
    });
    setCookie(c, sessionCookie, session, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 900,
    });
    return c.redirect("/");
  });
  app.use("/api/*", async (c, next) => {
    const raw = getCookie(c, sessionCookie);
    if (!validToken(raw)) return c.json({ error: "Sign in required." }, 401);
    const session = await deps.store.get(`session#${digest(raw)}`);
    if (
      !session?.userId ||
      session.expires <= now() ||
      !session.absoluteExpires ||
      session.absoluteExpires <= now() ||
      !deps.adminIds.includes(session.userId)
    )
      return c.json({ error: "Session expired or access revoked." }, 401);
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("Origin") !== deps.origin
    )
      return c.json({ error: "Request origin rejected." }, 403);
    c.set("actor", session.userId);
    await next();
  });
  app.on(["GET", "POST"], "/api/session", async (c) => {
    const session = await deps.store.get(
      `session#${digest(getCookie(c, sessionCookie)!)}`,
    );
    if (
      !session?.userId ||
      session.expires <= now() ||
      !session.absoluteExpires ||
      session.absoluteExpires <= now()
    )
      return c.json({ error: "Session expired." }, 401);
    if (c.req.method === "POST") {
      const time = now();
      const expires = Math.min(time + 900, session.absoluteExpires);
      // Conditional renewal cannot recreate a session deleted by concurrent logout.
      if (
        !(await deps.store.renew(
          `session#${digest(getCookie(c, sessionCookie)!)}`,
          time,
          expires,
        ))
      )
        return c.json({ error: "Session expired." }, 401);
      setCookie(c, sessionCookie, getCookie(c, sessionCookie)!, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: expires - time,
      });
    }
    return c.json({
      user: { id: session.userId, name: session.name ?? "Administrator" },
      rehearsal: false,
    });
  });
  app.post("/api/auth/logout", async (c) => {
    await deps.store.take(`session#${digest(getCookie(c, sessionCookie)!)}`);
    deleteCookie(c, sessionCookie, { secure: true, path: "/" });
    return c.body(null, 204);
  });
  app.get("/api/telegram/status", async (c) => {
    if (!deps.telegram) return c.json({ error: "Telegram unavailable" }, 503);
    return c.json(await deps.telegram.status());
  });
  app.get("/api/telegram/messages", async (c) => {
    if (!deps.telegram) return c.json({ error: "Telegram unavailable" }, 503);
    const chatId = c.req.query("chatId");
    const messageId = c.req.query("messageId");
    const cursor = c.req.query("cursor");
    if (
      !chatId ||
      !/^-\d+$/.test(chatId) ||
      (messageId && !/^\d+$/.test(messageId)) ||
      (cursor && cursor.length > 2048)
    )
      return c.json({ error: "Invalid query" }, 400);
    try {
      return c.json(await deps.telegram.messages(chatId, cursor, messageId));
    } catch (e) {
      if (
        e instanceof Error &&
        ["Chat not configured", "Invalid cursor"].includes(e.message)
      )
        return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  app.get("/api/telegram/groups", async (c) => {
    if (!deps.groups) return c.json({ error: "Telegram unavailable" }, 503);
    return c.json(await deps.groups.list());
  });
  app.post("/api/telegram/invites", async (c) => {
    if (!deps.groups) return c.json({ error: "Telegram unavailable" }, 503);
    try {
      return c.json(await deps.groups.issue(c.get("actor")), 201);
    } catch (e) {
      if (e instanceof GroupConflict) return c.json({ error: e.message }, 409);
      throw e;
    }
  });
  app.get("/api/telegram/invites/:id", async (c) => {
    if (!deps.groups) return c.json({ error: "Telegram unavailable" }, 503);
    if (!/^[a-f0-9]{64}$/.test(c.req.param("id")))
      return c.json({ error: "Invalid code reference" }, 400);
    const invite = await deps.groups.invite(c.req.param("id"));
    return invite
      ? c.json(invite)
      : c.json({ error: "Code expired or unavailable" }, 404);
  });
  app.post("/api/telegram/invites/:id/revoke", async (c) => {
    if (!deps.groups) return c.json({ error: "Telegram unavailable" }, 503);
    if (!/^[a-f0-9]{64}$/.test(c.req.param("id")))
      return c.json({ error: "Invalid code reference" }, 400);
    try {
      await deps.groups.revoke(c.req.param("id"), c.get("actor"));
      return c.body(null, 204);
    } catch (e) {
      if (e instanceof GroupConflict) return c.json({ error: e.message }, 409);
      throw e;
    }
  });
  app.post("/api/telegram/groups/:id/decision", async (c) => {
    if (!deps.groups) return c.json({ error: "Telegram unavailable" }, 503);
    const body = z
      .object({
        requestId: z.string().min(1).max(100),
        action: z.enum(["approve", "reject", "disconnect"]),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!/^-\d+$/.test(c.req.param("id")) || !body.success)
      return c.json({ error: "Invalid decision" }, 400);
    try {
      return c.json(
        await deps.groups.decide(
          c.req.param("id"),
          body.data.requestId,
          body.data.action,
          c.get("actor"),
        ),
      );
    } catch (e) {
      if (e instanceof GroupConflict) return c.json({ error: e.message }, 409);
      throw e;
    }
  });
  // No production moderation executor. Local fixtures are a separate server.
  app.get("/api/cases", (c) => c.json([]));
  app.notFound((c) => c.json({ error: "Not found." }, 404));
  return app;
}
export const identitySchema = z.object({
  id: z.string().regex(/^\d{17,20}$/),
  username: z.string(),
  mfa_enabled: z.boolean().optional(),
  bot: z.boolean().optional(),
});
