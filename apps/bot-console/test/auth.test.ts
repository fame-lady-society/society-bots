import { memoryAccess, localOwner } from "../local/access-store";
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
    async renew(k, now, expires) {
      const value = records.get(k);
      if (
        !value ||
        value.expires <= now ||
        !value.absoluteExpires ||
        value.absoluteExpires <= now ||
        value.absoluteExpires < expires
      )
        return false;
      records.set(k, { ...value, expires });
      return true;
    },
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
  const policy = { version: 0, principals: [structuredClone(localOwner)] };
  const access = memoryAccess(policy);
  const app = createApp({
    origin: "https://bot.fame.support",
    access: { ...access.store, read: async () => structuredClone(policy) },
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
    policy,
    advance: (seconds = 1000) => (clock += seconds),
    store,
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
test("secure session, expiry and principal revocation enforced server-side", async () => {
  const f = fixture();
  const r = await login(f);
  assert.equal(r.status, 302);
  const cookie = r.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!;
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=604800"])
    assert.ok(cookie.includes(flag));
  const headers = { Cookie: cookie.split(";")[0] };
  assert.equal((await f.app.request("/api/cases", { headers })).status, 200);
  f.policy.principals[0].enabled = false;
  assert.equal((await f.app.request("/api/cases", { headers })).status, 401);
  f.policy.principals[0].enabled = true;
  f.advance(604800);
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
    access: memoryAccess().store,
    store: {
      async renew() {
        throw new Error("secret-value");
      },
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

test("same-origin renewal survives original deadline but GET polling does not renew", async () => {
  const f = fixture();
  const signed = await login(f);
  const Cookie = signed.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!
    .split(";")[0];
  const headers = { Cookie, Origin: "https://bot.fame.support" };
  f.advance(604700);
  const renewed = await f.app.request("/api/session", {
    method: "POST",
    headers,
  });
  assert.equal(renewed.status, 200);
  assert.match(renewed.headers.get("set-cookie")!, /Max-Age=604800/);
  f.advance(200);
  assert.equal((await f.app.request("/api/session", { headers })).status, 200);
  f.advance(604600);
  assert.equal(
    (await f.app.request("/api/session", { method: "POST", headers })).status,
    401,
  );
});

test("renewal requires the approved session and exact Origin", async () => {
  const f = fixture();
  assert.equal(
    (await f.app.request("/api/session", { method: "POST" })).status,
    401,
  );
  const signed = await login(f);
  const Cookie = signed.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!
    .split(";")[0];
  for (const Origin of [undefined, "https://evil.invalid"]) {
    assert.equal(
      (
        await f.app.request("/api/session", {
          method: "POST",
          headers: { Cookie, ...(Origin ? { Origin } : {}) },
        })
      ).status,
      403,
    );
  }
  f.policy.principals[0].enabled = false;
  assert.equal(
    (
      await f.app.request("/api/session", {
        method: "POST",
        headers: { Cookie, Origin: "https://bot.fame.support" },
      })
    ).status,
    401,
  );
});

test("renewal respects the thirty-day absolute deadline", async () => {
  const f = fixture();
  const signed = await login(f);
  const Cookie = signed.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!
    .split(";")[0];
  const headers = { Cookie, Origin: "https://bot.fame.support" };
  for (let i = 0; i < 4; i++) {
    f.advance(604700);
    assert.equal(
      (await f.app.request("/api/session", { method: "POST", headers })).status,
      200,
    );
  }
  f.advance(173100);
  const final = await f.app.request("/api/session", {
    method: "POST",
    headers,
  });
  assert.equal(final.status, 200);
  assert.match(final.headers.get("set-cookie")!, /Max-Age=100(?:;|$)/);
  f.advance(100);
  assert.equal(
    (await f.app.request("/api/session", { method: "POST", headers })).status,
    401,
  );
});

test("logout racing renewal cannot resurrect the session", async () => {
  const f = fixture();
  const signed = await login(f);
  const Cookie = signed.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!
    .split(";")[0];
  const headers = { Cookie, Origin: "https://bot.fame.support" };
  const renew = f.store.renew;
  f.store.renew = async (key, now, expires) => {
    assert.equal(
      (await f.app.request("/api/auth/logout", { method: "POST", headers }))
        .status,
      204,
    );
    return renew(key, now, expires);
  };
  assert.equal(
    (await f.app.request("/api/session", { method: "POST", headers })).status,
    401,
  );
  assert.equal((await f.app.request("/api/session", { headers })).status, 401);
});
