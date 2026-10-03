import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer } from "vite";
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
const app = new Hono();
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
