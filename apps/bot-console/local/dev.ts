import {
  rehearsalSnapshot,
  rehearsalScenarios,
  type RehearsalScenario,
} from "./operator-status";
import { projectStatus } from "../server/operator-status";
import { runtime, runtimeScope } from "../src/runtime-contracts";
import { permits, type Principal } from "../src/access-contracts";
import { z } from "zod";
import { memoryAccess, localOwner } from "./access-store";
import { editAccess } from "../server/access";
import { memoryGroupStore } from "./group-store";
import { groupService } from "../server/telegram-groups";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer } from "vite";
import { normalizeUpdate, type TelegramConfig } from "../server/telegram";
import type { Incident } from "../src/contracts";
const incidents: Incident[] = [
  {
    id: "case-104",
    title: "Possible staff impersonation",
    platform: "Discord",
    channel: "#public-rehearsal",
    subject: "Airdrop coordinator · test account",
    reason:
      "Claims a staff role and asks members to connect a wallet. Identity is unverified; this is synthetic evidence.",
    action: "Ban test account and delete 204 captured messages",
    status: "pending",
    messages: Array.from({ length: 204 }, (_, i) => ({
      id: `m-${i}`,
      author: i % 5 === 0 ? "Operator" : "Airdrop coordinator",
      text:
        i % 5 === 0
          ? "Is this an official announcement?"
          : "Synthetic rehearsal message: claim your reward at example.invalid. No real link or wallet is involved.",
      time: `10:${String(i % 60).padStart(2, "0")}`,
    })),
  },
  {
    id: "case-103",
    title: "Question about FAME",
    platform: "Telegram",
    channel: "$FAME Society · mock",
    subject: "Community member",
    reason:
      "A question without an approved knowledge source. Abstain and request an operator answer.",
    action: "Request an operator answer",
    status: "pending",
    messages: [
      {
        id: "q-1",
        author: "Community member",
        text: "Where can I find the official FAME information?",
        time: "09:54",
      },
    ],
  },
  {
    id: "case-102",
    title: "Promotion reviewed",
    platform: "Discord",
    channel: "#public-rehearsal",
    subject: "Known member",
    reason: "Operator marked this as permitted community promotion.",
    action: "No moderation action",
    status: "rejected",
    messages: [
      {
        id: "p-1",
        author: "Known member",
        text: "Synthetic community event announcement.",
        time: "09:42",
      },
    ],
  },
];
let signedIn = false;
let runtimeScenario: RehearsalScenario = "ready";
let rehearsalPrincipal: Principal = structuredClone(localOwner);
const app = new Hono();
const access = memoryAccess();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/api/auth/login", (c) => {
  signedIn = true;
  return c.redirect("/");
});
app.use("/api/*", async (c, next) => {
  if (!signedIn) return c.json({ error: "Sign in required." }, 401);
  await next();
});
app.get("/api/session", (c) =>
  c.json({
    user: { id: "local-operator", name: "Local operator" },
    rehearsal: true,
    principal: rehearsalPrincipal,
    expires: Math.floor(Date.now() / 1000) + 604800,
    absoluteExpires: Math.floor(Date.now() / 1000) + 2592000,
  }),
);
app.post("/api/local/runtime", async (c) => {
  const body = z
    .object({
      scenario: z.enum(rehearsalScenarios).optional(),
      role: z.enum(["owner", "operator-viewer", "reader"]).optional(),
    })
    .strict()
    .parse(await c.req.json());
  if (body.scenario) runtimeScenario = body.scenario;
  if (body.role)
    rehearsalPrincipal = {
      ...localOwner,
      grants: [
        {
          role: body.role,
          scope:
            body.role === "operator-viewer"
              ? runtimeScope
              : body.role === "reader"
                ? "telegram:-100"
                : "*",
        },
      ],
    };
  return c.body(null, 204);
});
app.get("/api/runtimes", (c) =>
  c.json({
    runtimes: permits(rehearsalPrincipal, "runtime.read", runtimeScope)
      ? [runtime]
      : [],
  }),
);
app.get("/api/runtimes/:id/status", (c) => {
  if (
    c.req.param("id") !== runtime.id ||
    !permits(rehearsalPrincipal, "runtime.read", runtimeScope)
  )
    return c.json({ error: "Runtime not found." }, 404);
  if (runtimeScenario === "unavailable")
    return c.json({ error: "Runtime status unavailable." }, 503);
  const now = Math.floor(Date.now() / 1000);
  const snapshot = rehearsalSnapshot(runtimeScenario, now);
  return c.json({
    status: projectStatus(
      snapshot
        ? { revision: snapshot.revision, data: JSON.stringify(snapshot) }
        : undefined,
      now,
    ),
  });
});
app.get("/api/access", async (c) =>
  c.json({
    policy: await access.store.read(),
    audit: await access.store.audit(),
  }),
);
app.post("/api/access", async (c) => {
  try {
    return c.json(
      await editAccess(
        access.store,
        localOwner.id,
        await c.req.json(),
        Math.floor(Date.now() / 1000),
      ),
    );
  } catch (e) {
    return c.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.map((issue) => issue.message).join(". ")
            : e instanceof Error
              ? e.message
              : "Access update failed",
      },
      400,
    );
  }
});
const mockConfig: TelegramConfig = {
  webhookSecret: "x".repeat(48),
  botId: "7393738833",
  username: "famesocietybot",
};
const memory = memoryGroupStore();
const onboarding = groupService(memory.store, async () => ({
  name: "New test group · synthetic",
}));
memory.groups.set("-100", {
  id: "-100",
  name: "Society test · synthetic",
  state: "active",
  requestId: "seed",
  requestedBy: "42",
  createdBy: "local-operator",
  requestedAt: 0,
  updatedAt: Math.floor(Date.now() / 1000),
  updatedBy: "local-operator",
  hasHistory: true,
  associationId: "seed",
  activatedAt: 0,
});
app.get("/api/telegram/groups", async (c) => c.json(await onboarding.list()));
app.post("/api/telegram/invites", async (c) =>
  c.json(await onboarding.issue("local-operator"), 201),
);
app.get("/api/telegram/invites/:id", async (c) =>
  c.json(await onboarding.invite(c.req.param("id"))),
);
app.post("/api/telegram/invites/:id/revoke", async (c) => {
  await onboarding.revoke(c.req.param("id"), "local-operator");
  return c.body(null, 204);
});
app.post("/api/telegram/groups/:id/decision", async (c) => {
  const body = await c.req.json();
  return c.json(
    await onboarding.decide(
      c.req.param("id"),
      body.requestId,
      body.action,
      "local-operator",
    ),
  );
});
app.post("/api/local/telegram-redeem", async (c) => {
  const { code } = await c.req.json();
  await onboarding.redeem(code, "-200", "New test group · synthetic", "777");
  return c.body(null, 204);
});
const now = Math.floor(Date.now() / 1000);
const raw = {
  update_id: 1,
  message: {
    message_id: 10,
    date: now - 300,
    chat: { id: -100, type: "supergroup", title: "Society test · synthetic" },
    from: { id: 42, first_name: "Flick · mock" },
    text: "Hello from the local rehearsal. No Telegram messages are sent.",
  },
};
const original = normalizeUpdate(raw, now - 300)!;
const edited = normalizeUpdate(
  {
    update_id: 2,
    edited_message: {
      ...raw.message,
      edit_date: now - 60,
      text: "Edited synthetic message. Original text remains in captured history.",
    },
  },
  now - 60,
)!;
app.get("/api/telegram/status", async (c) =>
  c.json({
    botId: mockConfig.botId,
    username: mockConfig.username,
    chats: (await memory.store.list())
      .filter((g) => g.hasHistory)
      .map((chat) => ({
        ...chat,
        lastCapturedAt: now - 60,
      })),
    registeredAt: null,
    queued: 0,
    failed: 0,
  }),
);
app.get("/api/telegram/messages", (c) =>
  c.json({
    items: c.req.query("messageId") ? [edited, original] : [edited],
    cursor: null,
  }),
);
app.get("/api/cases", (c) => c.json(incidents));
app.post("/api/auth/logout", (c) => {
  signedIn = false;
  return c.body(null, 204);
});
app.post("/api/cases/:id/decision", async (c) => {
  if (c.req.header("Origin") !== "http://127.0.0.1:5173")
    return c.json({ error: "Invalid origin" }, 403);
  const incident = incidents.find((i) => i.id === c.req.param("id"));
  const body = await c.req.json();
  if (
    !incident ||
    incident.status !== "pending" ||
    !["approved", "rejected"].includes(body.decision)
  )
    return c.json({ error: "Decision unavailable" }, 409);
  incident.status = body.decision;
  return c.json(incident);
});
const api = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 5174 });
const vite = await createServer();
await vite.listen();
vite.printUrls();
async function close() {
  await vite.close();
  api.close();
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
