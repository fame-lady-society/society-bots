import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryAccess, localOwner } from "../local/access-store";
import { editAccess } from "../server/access";
import {
  permits,
  principalSchema,
  policySchema,
  type Principal,
} from "../src/access-contracts";
const reader = {
  id: "discord:123456789012345678",
  kind: "human" as const,
  name: "Reader",
  enabled: true,
  grants: [{ role: "reader" as const, scope: "telegram:-100" }],
  sessionVersion: 0,
};
const edit = (
  p: typeof reader | typeof localOwner,
  version: number,
  revokeSessions = false,
) => {
  const { sessionVersion, ...principal } = p;
  return { version, principal, revokeSessions };
};
test("exact scopes, role separation, disabled identities and service-owner rejection", () => {
  assert.ok(permits(reader, "messages.read", "telegram:-100"));
  for (const scope of ["telegram:-1000", "telegram:-200", "*", "discord:-100"])
    assert.equal(permits(reader, "messages.read", scope), false);
  assert.equal(permits(reader, "connections.manage"), false);
  assert.equal(permits(reader, "access.manage"), false);
  assert.equal(
    permits({ ...reader, enabled: false }, "messages.read", "telegram:-100"),
    false,
  );
  assert.equal(
    principalSchema.safeParse({
      ...localOwner,
      id: "service:executor",
      kind: "service",
    }).success,
    false,
  );
  assert.equal(
    principalSchema.safeParse({
      ...reader,
      grants: [{ role: "reader", scope: "*" }],
    }).success,
    false,
  );
  assert.equal(
    principalSchema.safeParse({ ...reader, id: "service:executor" }).success,
    false,
  );
  const manager = {
    ...reader,
    grants: [{ role: "manager" as const, scope: "*" }],
  };
  assert.ok(permits(manager, "connections.manage"));
  assert.equal(permits(manager, "messages.read", "telegram:-100"), false);
});
test("only owners can change grants; changes have server attribution and reject forged fields", async () => {
  const { store } = memoryAccess();
  await assert.rejects(editAccess(store, reader.id, edit(reader, 0), 100));
  await assert.rejects(
    editAccess(
      store,
      localOwner.id,
      { ...edit(reader, 0), actor: reader.id },
      100,
    ),
  );
  await editAccess(store, localOwner.id, edit(reader, 0), 100);
  assert.equal((await store.audit())[0].actor, localOwner.id);
  assert.equal((await store.audit())[0].before, null);
  await assert.rejects(
    editAccess(
      store,
      reader.id,
      edit(
        {
          ...reader,
          grants: [{ role: "owner", scope: "*" }],
        } as typeof localOwner,
        1,
      ),
      101,
    ),
  );
});
test("last owner cannot be disabled or demoted; concurrent owner removals cannot remove both", async () => {
  const { store } = memoryAccess();
  await assert.rejects(
    editAccess(
      store,
      localOwner.id,
      edit({ ...localOwner, enabled: false }, 0),
      100,
    ),
  );
  await assert.rejects(
    editAccess(
      store,
      localOwner.id,
      edit({ ...localOwner, grants: [] }, 0),
      100,
    ),
  );
  const second = { ...localOwner, id: reader.id };
  await editAccess(store, localOwner.id, edit(second, 0), 100);
  const results = await Promise.allSettled([
    editAccess(
      store,
      localOwner.id,
      edit({ ...localOwner, enabled: false }, 1),
      101,
    ),
    editAccess(store, second.id, edit({ ...second, enabled: false }, 1), 101),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(policySchema.safeParse(await store.read()).success);
  assert.equal((await store.audit()).length, 2);
});
test("disable and explicit session revocation advance the epoch, stale saves cannot undo it", async () => {
  const { store } = memoryAccess();
  await editAccess(store, localOwner.id, edit(reader, 0), 100);
  await editAccess(store, localOwner.id, edit(reader, 1, true), 101);
  assert.equal(
    (await store.read()).principals.find((p) => p.id === reader.id)
      ?.sessionVersion,
    1,
  );
  await assert.rejects(editAccess(store, localOwner.id, edit(reader, 1), 102));
  await editAccess(
    store,
    localOwner.id,
    edit({ ...reader, enabled: false }, 2),
    103,
  );
  assert.equal(
    (await store.read()).principals.find((p) => p.id === reader.id)
      ?.sessionVersion,
    2,
  );
});

import { createApp, type RecordValue } from "../server/app";
async function apiFixture(principal: Principal = reader) {
  const memory = memoryAccess({
    version: 0,
    principals: [structuredClone(localOwner), structuredClone(principal)],
  });
  const records = new Map<string, RecordValue>();
  const app = createApp({
    origin: "https://bot.fame.support",
    access: memory.store,
    store: {
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
      async renew() {
        return true;
      },
    },
    oauth: {
      url: (state) => `https://discord.com/?state=${state}`,
      identity: async () => ({
        id: principal.id.slice(8),
        username: principal.name,
        mfa_enabled: true,
      }),
    },
    telegram: {
      status: async () => ({
        chats: [
          { id: "-100", name: "Allowed" },
          { id: "-200", name: "Private" },
        ],
        queued: 9,
        failed: 2,
      }),
      messages: async () => ({ items: [], cursor: null }),
    },
  });
  const start = await app.request("/api/auth/login");
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const logged = await app.request(`/api/auth/callback?state=${state}&code=x`, {
    headers: { Cookie: `__Host-bot-state=${state}` },
  });
  const Cookie = logged.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-bot-session="))!
    .split(";")[0];
  return {
    app,
    memory,
    headers: { Cookie, Origin: "https://bot.fame.support" },
  };
}
test("reader HTTP routes filter discovery and reject other groups, management, audit and forgery", async () => {
  const { app, headers } = await apiFixture();
  const status = await app.request("/api/telegram/status", { headers });
  assert.deepEqual(await status.json(), {
    chats: [{ id: "-100", name: "Allowed" }],
    queued: 0,
    failed: 0,
  });
  assert.equal(
    (await app.request("/api/telegram/messages?chatId=-100", { headers }))
      .status,
    200,
  );
  for (const url of [
    "/api/telegram/messages?chatId=-200",
    "/api/access",
    "/api/cases",
    "/api/telegram/invites/" + "a".repeat(64),
  ])
    assert.equal((await app.request(url, { headers })).status, 403);
  for (const url of [
    "/api/access",
    "/api/telegram/invites",
    "/api/telegram/groups/-100/decision",
  ])
    assert.equal(
      (
        await app.request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            actor: localOwner.id,
            action: "approve",
            requestId: "x",
          }),
        })
      ).status,
      403,
    );
});
test("access changes revoke existing sessions without waiting for cookie expiry", async () => {
  const { app, headers, memory } = await apiFixture();
  assert.equal((await app.request("/api/session", { headers })).status, 200);
  await editAccess(memory.store, localOwner.id, edit(reader, 0, true), 100);
  assert.equal((await app.request("/api/session", { headers })).status, 401);
  assert.equal(
    (await app.request("/api/session", { headers, method: "POST" })).status,
    401,
  );
});
test("changing scopes takes effect immediately without signing in again", async () => {
  const { app, headers, memory } = await apiFixture();
  await editAccess(
    memory.store,
    localOwner.id,
    edit(
      { ...reader, grants: [{ role: "reader", scope: "telegram:-200" }] },
      0,
    ),
    100,
  );
  assert.equal(
    (await app.request("/api/telegram/messages?chatId=-100", { headers }))
      .status,
    403,
  );
  assert.equal(
    (await app.request("/api/telegram/messages?chatId=-200", { headers }))
      .status,
    200,
  );
});

test("disable then re-enable does not revive an old browser session", async () => {
  const { app, headers, memory } = await apiFixture();
  await editAccess(
    memory.store,
    localOwner.id,
    edit({ ...reader, enabled: false }, 0),
    100,
  );
  await editAccess(memory.store, localOwner.id, edit(reader, 1), 101);
  assert.equal((await app.request("/api/session", { headers })).status, 401);
});

test("connection manager HTTP access does not imply message or owner access", async () => {
  const { app, headers } = await apiFixture({
    ...reader,
    grants: [{ role: "manager", scope: "*" }],
  });
  assert.equal(
    (await app.request("/api/telegram/status", { headers })).status,
    200,
  );
  for (const url of [
    "/api/access",
    "/api/telegram/messages?chatId=-100",
    "/api/telegram/messages?chatId=-100&messageId=1",
  ])
    assert.equal((await app.request(url, { headers })).status, 403);
});

import { accessStore } from "../server/access-store";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
test("DynamoDB adapter commits policy CAS and immutable audit together, and propagates storage failures", async () => {
  const memory = memoryAccess();
  const previous = await memory.store.read();
  const next = await editAccess(
    memory.store,
    localOwner.id,
    edit(reader, 0),
    100,
  );
  const receipt = (await memory.store.audit())[0];
  const commands: (GetCommand | QueryCommand | TransactWriteCommand)[] = [];
  const store = accessStore("access-test", async (c) => {
    commands.push(c);
    if (c instanceof GetCommand) return { Item: { value: previous } };
    if (c instanceof QueryCommand) return { Items: [{ value: receipt }] };
    return {};
  });
  assert.deepEqual(await store.read(), previous);
  assert.equal((commands[0] as GetCommand).input.ConsistentRead, true);
  assert.equal(await store.write(previous, next, receipt), true);
  const tx = commands[1] as TransactWriteCommand;
  assert.equal(tx.input.TransactItems?.length, 2);
  const [policy, audit] = tx.input.TransactItems!;
  assert.equal(policy.Put?.ConditionExpression, "#v = :previous");
  assert.deepEqual(policy.Put?.ExpressionAttributeValues, { ":previous": 0 });
  assert.deepEqual(policy.Put?.Item?.value, next);
  assert.equal(audit.Put?.ConditionExpression, "attribute_not_exists(pk)");
  assert.deepEqual(audit.Put?.Item?.value, receipt);
  assert.deepEqual(await store.audit(), [receipt]);
  const conflict = Object.assign(new Error("conflict"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
  });
  const rejected = accessStore("access-test", async () => {
    throw conflict;
  });
  assert.equal(await rejected.write(previous, next, receipt), false);
  conflict.CancellationReasons[0].Code = "ProvisionedThroughputExceeded";
  await assert.rejects(rejected.write(previous, next, receipt), /conflict/);
});
