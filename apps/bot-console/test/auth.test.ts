import { memoryGroupStore } from "../local/group-store";
import { groupService } from "../server/telegram-groups";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createApp,
  type Store,
  type RecordValue,
  type Dependencies,
} from "../server/app";
const owner = "931691901592145930";
function fixture(
  identity = { id: owner, username: "Operator", mfa_enabled: true },
  groups?: Dependencies["groups"],
) {
  const records = new Map<string, RecordValue>();
  let clock = 1000;
  let exchanges = 0;
  const store: Store = {
    async put(k, v) {
      records.set(k, v);
    },
    async get(k) {
      return records.get(k);
    },
    async take(k) {
      const v = records.get(k);
      records.delete(k);
      return v;
    },
  };
  const adminIds = [owner];
  const app = createApp({
    origin: "https://bot.fame.support",
    adminIds,
    groups,
    store,
    now: () => clock,
    oauth: {
      url: (state) => `https://discord.com/oauth2/authorize?state=${state}`,
      async identity() {
        exchanges++;
        return identity;
      },
    },
  });
  return {
    app,
    adminIds,
    advance: () => (clock += 1000),
    exchanges: () => exchanges,
  };
}
async function start(app: ReturnType<typeof createApp>) {
  const response = await app.request("/api/auth/login");
  const state = new URL(response.headers.get("location")!).searchParams.get(
    "state",
  )!;
  return { state, cookie: `__Host-bot-state=${state}` };
}
async function login(f: ReturnType<typeof fixture>) {
  const s = await start(f.app);
  return f.app.request(`/api/auth/callback?state=${s.state}&code=code`, {
    headers: { Cookie: s.cookie },
  });
}
test("all data requires a session and there is no production mock login", async () => {
  const f = fixture();
  for (const path of [
    "/api/session",
    "/api/cases",
    "/api/local/login",
    "/api/telegram/status",
    "/api/telegram/messages?chatId=-100",
  ])
    assert.equal((await f.app.request(path)).status, 401);
});
test("rejects missing/mismatched state before provider exchange", async () => {
  const f = fixture();
  const s = await start(f.app);
  assert.equal(
    (await f.app.request(`/api/auth/callback?state=${s.state}&code=code`))
      .status,
    400,
  );
  assert.equal(f.exchanges(), 0);
});
test("state is one-use even for simultaneous callbacks", async () => {
  const f = fixture();
  const s = await start(f.app);
  const requests = await Promise.all(
    [1, 2].map(() =>
      f.app.request(`/api/auth/callback?state=${s.state}&code=code`, {
        headers: { Cookie: s.cookie },
      }),
    ),
  );
  assert.deepEqual(requests.map((r) => r.status).sort(), [302, 400]);
  assert.equal(f.exchanges(), 1);
});
test("rejects expired login state", async () => {
  const f = fixture();
  const s = await start(f.app);
  f.advance();
  assert.equal(
    (
      await f.app.request(`/api/auth/callback?state=${s.state}&code=code`, {
        headers: { Cookie: s.cookie },
      })
    ).status,
    400,
  );
});
test("second account and administrator without MFA cannot log in", async () => {
  for (const identity of [
    { id: "111111111111111111", username: "Test", mfa_enabled: true },
    { id: owner, username: "Owner", mfa_enabled: false },
  ]) {
    assert.equal((await login(fixture(identity))).status, 403);
  }
});
test("secure session, expiry and allowlist revocation enforced server-side", async () => {
  const f = fixture();
  const r = await login(f);
  assert.equal(r.status, 302);
  const cookie = r.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!;
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=900"])
    assert.ok(cookie.includes(flag));
  const headers = { Cookie: cookie.split(";")[0] };
  assert.equal((await f.app.request("/api/cases", { headers })).status, 200);
  f.adminIds.splice(0);
  assert.equal((await f.app.request("/api/cases", { headers })).status, 401);
  f.adminIds.push(owner);
  f.advance();
  assert.equal((await f.app.request("/api/cases", { headers })).status, 401);
});
test("logout rejects cross-site mutation and revokes valid sessions", async () => {
  const f = fixture();
  const r = await login(f);
  const Cookie = r.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!
    .split(";")[0];
  assert.equal(
    (
      await f.app.request("/api/auth/logout", {
        method: "POST",
        headers: { Cookie, Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.app.request("/api/auth/logout", {
        method: "POST",
        headers: { Cookie, Origin: "https://bot.fame.support" },
      })
    ).status,
    204,
  );
  assert.equal(
    (await f.app.request("/api/cases", { headers: { Cookie } })).status,
    401,
  );
});
test("storage failures are fail-closed and do not expose internal errors", async () => {
  const app = createApp({
    origin: "https://bot.fame.support",
    adminIds: [owner],
    store: {
      async put() {
        throw new Error("secret-value");
      },
      async get() {
        return undefined;
      },
      async take() {
        return undefined;
      },
    },
    oauth: {
      url: () => "",
      async identity() {
        throw new Error("unused");
      },
    },
  });
  const response = await app.request("/api/auth/login");
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret-value"));
});

test("group management endpoints require approved sessions and same-origin mutations", async () => {
  const f = fixture();
  const paths = [
    "/api/telegram/invites",
    `/api/telegram/invites/${"a".repeat(64)}/revoke`,
    "/api/telegram/groups/-100/decision",
  ];
  for (const path of paths)
    assert.equal((await f.app.request(path, { method: "POST" })).status, 401);
  assert.equal((await f.app.request("/api/telegram/groups")).status, 401);
  const response = await login(f);
  const Cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!
    .split(";")[0];
  for (const path of paths)
    assert.equal(
      (
        await f.app.request(path, {
          method: "POST",
          headers: { Cookie, Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
});

test("authenticated group API attributes issuance and approval to the session actor", async () => {
  const memory = memoryGroupStore();
  const groups = groupService(
    memory.store,
    async () => ({ name: "Verified group" }),
    () => 1000,
  );
  const f = fixture(undefined, groups);
  const response = await login(f);
  const Cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!
    .split(";")[0];
  const headers = {
    Cookie,
    Origin: "https://bot.fame.support",
    "Content-Type": "application/json",
  };
  const issued = await f.app.request("/api/telegram/invites", {
    method: "POST",
    headers,
  });
  assert.equal(issued.status, 201);
  const invite = await issued.json();
  assert.equal(invite.createdBy, owner);
  const stored = await f.app.request(`/api/telegram/invites/${invite.id}`, {
    headers,
  });
  assert.equal((await stored.json()).code, undefined);
  await groups.redeem(invite.code, "-100", "Unverified", "42");
  const listed = await f.app.request("/api/telegram/groups", { headers });
  const group = (await listed.json())[0];
  const approve = await f.app.request("/api/telegram/groups/-100/decision", {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId: group.requestId, action: "approve" }),
  });
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).updatedBy, owner);
  const stale = await f.app.request("/api/telegram/groups/-100/decision", {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId: group.requestId, action: "reject" }),
  });
  assert.equal(stale.status, 409);
  const forged = await f.app.request("/api/telegram/groups/-100/decision", {
    method: "POST",
    headers,
    body: JSON.stringify({
      requestId: group.requestId,
      action: "disconnect",
      actor: "someone else",
    }),
  });
  assert.equal(forged.status, 400);
});
