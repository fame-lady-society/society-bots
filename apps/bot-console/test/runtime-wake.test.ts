import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createApp } from "../server/app";
import { wakeService, wakeStore, type WakeStore } from "../server/runtime-wake";
import { localOwner, memoryAccess } from "../local/access-store";
import {
  permits,
  principalSchema,
  policySchema,
  grantSchema,
  type Principal,
} from "../src/access-contracts";
import type { WakeRequest, WakeRecord } from "../src/runtime-wake-contracts";
const id = "7a029cfe-a503-42b5-a229-e19927e9d1f8";
const request: WakeRequest = {
  requestId: id,
  runtimeId: "overclaw-leader",
  action: "wake",
  actor: localOwner.id,
  requestedAt: 1000,
};
function memory() {
  const records = new Map<string, WakeRecord>();
  const store: WakeStore = {
    async get(id) {
      return records.has(id) ? structuredClone(records.get(id)) : undefined;
    },
    async create(request) {
      if (!records.has(request.requestId))
        records.set(request.requestId, {
          request,
          outcome: "pending",
          reason: "dispatch-requested",
        });
    },
    async finish(record) {
      const current = records.get(record.request.requestId)!;
      if (["pending", "unknown"].includes(current.outcome))
        records.set(record.request.requestId, record);
      return records.get(record.request.requestId)!;
    },
  };
  return { records, store };
}
test("runtime operator is a scoped human role, viewers remain read-only", () => {
  const operator: Principal = {
    ...localOwner,
    grants: [{ role: "runtime-operator", scope: "runtime:overclaw-leader" }],
  };
  assert.equal(
    policySchema.safeParse({ version: 0, principals: [operator] }).success,
    false,
  );
  assert.ok(permits(operator, "runtime.wake", "runtime:overclaw-leader"));
  assert.ok(permits(localOwner, "runtime.wake", "runtime:overclaw-leader"));
  assert.equal(permits(operator, "runtime.wake", "runtime:house"), false);
  assert.equal(permits(operator, "access.manage"), false);
  assert.equal(permits(operator, "messages.read", "telegram:-100"), false);
  assert.equal(
    permits(
      {
        ...operator,
        grants: [{ role: "operator-viewer", scope: "runtime:overclaw-leader" }],
      },
      "runtime.wake",
      "runtime:overclaw-leader",
    ),
    false,
  );
  assert.equal(
    grantSchema.safeParse({ role: "runtime-operator", scope: "*" }).success,
    false,
  );
  assert.equal(
    principalSchema.safeParse({
      ...operator,
      kind: "agent",
      id: "agent:fameliza",
    }).success,
    false,
  );
});
test("audit precedes dispatch; duplicates return receipt and bind actor", async () => {
  const { store, records } = memory();
  let invokes = 0;
  const service = wakeService(store, async (r) => {
    assert.equal(records.get(id)?.outcome, "pending");
    invokes++;
    // DynamoDB and Rust are allowed to reorder JSON object properties.
    return {
      request: {
        actor: r.actor,
        requestedAt: r.requestedAt,
        action: r.action,
        runtimeId: r.runtimeId,
        requestId: r.requestId,
      },
      outcome: "accepted",
      reason: "wake-requested",
    };
  });
  assert.equal((await service.submit(request, 0)).outcome, "accepted");
  await service.submit({ ...request, requestedAt: 1100 }, 1);
  assert.equal(invokes, 1);
  await assert.rejects(
    service.submit({ ...request, actor: "discord:111111111111111111" }, 0),
  );
  assert.equal(invokes, 1);
});
test("ambiguous dispatch remains unknown and retry uses original envelope", async () => {
  const { store } = memory();
  let first = true;
  const service = wakeService(store, async (r) => {
    assert.deepEqual(r, request);
    if (first) {
      first = false;
      throw new Error("lost response after acceptance");
    }
    return { request: r, outcome: "accepted", reason: "wake-requested" };
  });
  assert.equal((await service.submit(request, 0)).outcome, "unknown");
  assert.equal(
    (await service.submit({ ...request, requestedAt: 1800 }, 0)).outcome,
    "accepted",
  );
});
test("audit failure prevents dispatch, mismatched receipts cannot establish acceptance", async () => {
  let calls = 0;
  const { store } = memory();
  const service = wakeService(
    {
      ...store,
      create: async () => {
        throw new Error("DB failed");
      },
    },
    async () => {
      calls++;
    },
  );
  await assert.rejects(service.submit(request, 0));
  assert.equal(calls, 0);
  const wrong = wakeService(store, async (r) => ({
    request: { ...r, actor: "discord:111111111111111111" },
    outcome: "accepted",
    reason: "wake-requested",
  }));
  assert.equal((await wrong.submit(request, 0)).outcome, "unknown");
});
test("late ambiguous response cannot overwrite concurrent confirmed receipt", async () => {
  const { store } = memory();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const pending = new Promise<void>((r) => (release = r));
  let first = true;
  const service = wakeService(store, async (r) => {
    if (first) {
      first = false;
      entered();
      await pending;
      throw new Error("timeout");
    }
    return { request: r, outcome: "accepted", reason: "wake-requested" };
  });
  const a = service.submit(request, 0);
  await started;
  const b = await service.submit(request, 0);
  release();
  assert.equal(b.outcome, "accepted");
  assert.equal((await a).outcome, "accepted");
});
test("Dynamo audit creation checks policy atomically; completion cannot overwrite final outcome", async () => {
  const commands: (GetCommand | TransactWriteCommand | UpdateCommand)[] = [];
  const store = wakeStore("access", async (command) => {
    commands.push(command);
    return command instanceof GetCommand
      ? {
          Item: {
            value: { request, outcome: "accepted", reason: "wake-requested" },
          },
        }
      : {};
  });
  await store.create(request, 7);
  const tx = (commands[0] as TransactWriteCommand).input.TransactItems!;
  assert.deepEqual(tx[0].ConditionCheck!.Key, { pk: "policy", sk: "current" });
  assert.equal(tx[0].ConditionCheck!.ExpressionAttributeValues![":version"], 7);
  assert.equal(tx[1].Put!.ConditionExpression, "attribute_not_exists(pk)");
  assert.equal(tx[1].Put!.Item!.value.request.actor, localOwner.id);
  await store.finish({
    request,
    outcome: "unknown",
    reason: "delivery-uncertain",
  });
  assert.equal(
    (commands[1] as UpdateCommand).input.ConditionExpression,
    "#v.#o IN (:pending, :unknown)",
  );
});
function appFixture(principal: Principal = structuredClone(localOwner)) {
  let calls = 0;
  const raw = "a".repeat(43),
    key = `session#${createHash("sha256").update(raw).digest("hex")}`;
  const session = {
    userId: principal.id.slice(8),
    expires: 2000,
    absoluteExpires: 3000,
    sessionVersion: 0,
  };
  const policy = { version: 0, principals: [principal] };
  const { store } = memory();
  const wake = wakeService(store, async (r) => {
    calls++;
    return { request: r, outcome: "accepted", reason: "wake-requested" };
  });
  const app = createApp({
    origin: "https://bot.fame.support",
    now: () => 1000,
    access: {
      ...memoryAccess().store,
      read: async () => structuredClone(policy),
    },
    store: {
      get: async (k) => (k === key ? session : undefined),
      put: async () => {},
      take: async () => undefined,
      renew: async () => false,
    },
    oauth: {
      url: () => "",
      identity: async () => ({ id: principal.id.slice(8), username: "Test" }),
    },
    wake,
  });
  const headers = {
    Cookie: `__Host-bot-session=${raw}`,
    Origin: "https://bot.fame.support",
    "Content-Type": "application/json",
  };
  return { app, headers, policy, session, calls: () => calls };
}
test("API authenticates and authorizes each request before dispatch; origin and payload are strict", async () => {
  const path = "/api/runtimes/overclaw-leader/wake";
  const f = appFixture();
  const body = JSON.stringify({ requestId: id });
  assert.equal(
    (await f.app.request(path, { method: "POST", body })).status,
    401,
  );
  assert.equal(
    (
      await f.app.request(path, {
        method: "POST",
        body,
        headers: { ...f.headers, Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  for (const input of [
    { requestId: id, actor: "discord:111111111111111111" },
    { requestId: id, task: "do work" },
    { requestId: "bad" },
  ])
    assert.equal(
      (
        await f.app.request(path, {
          method: "POST",
          body: JSON.stringify(input),
          headers: f.headers,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.app.request("/api/runtimes/house/wake", {
        method: "POST",
        body,
        headers: f.headers,
      })
    ).status,
    404,
  );
  assert.equal(f.calls(), 0);
  const response = await f.app.request(path, {
    method: "POST",
    body,
    headers: f.headers,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).request.actor, localOwner.id);
  f.policy.principals[0].grants = [
    { role: "operator-viewer", scope: "runtime:overclaw-leader" },
  ];
  assert.equal(
    (await f.app.request(path, { method: "POST", body, headers: f.headers }))
      .status,
    404,
  );
  f.policy.principals[0].sessionVersion++;
  assert.equal(
    (await f.app.request(path, { method: "POST", body, headers: f.headers }))
      .status,
    401,
  );
  assert.equal(f.calls(), 1);
});
test("manager, reader, viewer and expired sessions cannot wake", async () => {
  for (const role of ["manager", "reader", "operator-viewer"] as const) {
    const f = appFixture({
      ...localOwner,
      grants: [
        {
          role,
          scope:
            role === "manager"
              ? "*"
              : role === "reader"
                ? "telegram:*"
                : "runtime:overclaw-leader",
        },
      ],
    });
    assert.equal(
      (
        await f.app.request("/api/runtimes/overclaw-leader/wake", {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({ requestId: id }),
        })
      ).status,
      404,
    );
    assert.equal(f.calls(), 0);
  }
  const f = appFixture();
  f.session.expires = 999;
  assert.equal(
    (
      await f.app.request("/api/runtimes/overclaw-leader/wake", {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ requestId: id }),
      })
    ).status,
    401,
  );
});

test("policy transaction cancellation cannot fall through to dispatch", async () => {
  const canceled = Object.assign(new Error("policy changed"), {
    name: "TransactionCanceledException",
  });
  let reads = 0;
  const store = wakeStore("access", async (command) => {
    if (command instanceof TransactWriteCommand) throw canceled;
    reads++;
    return {
      Item: {
        value: { request, outcome: "pending", reason: "dispatch-requested" },
      },
    };
  });
  await assert.rejects(store.create(request, 7), canceled);
  assert.equal(reads, 0);
});
