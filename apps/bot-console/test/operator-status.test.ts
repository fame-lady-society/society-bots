import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { projectStatus } from "../server/operator-status";
import { createApp, type RecordValue } from "../server/app";
import { memoryAccess, localOwner } from "../local/access-store";
import {
  auditSchema,
  policySchema,
  permits,
  grantSchema,
  type Principal,
} from "../src/access-contracts";
import {
  runtimePresentation,
  runtimeStatusSchema,
  snapshotSchema,
  runtimeScope,
} from "../src/runtime-contracts";
import {
  rehearsalSnapshot,
  rehearsalScenarios,
} from "../local/operator-status";
const fixture = () =>
  snapshotSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/operator-status/ready.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const item = (s: unknown = fixture()) => ({
  revision: 1,
  data: JSON.stringify(s),
});
const viewer: Principal = {
  ...localOwner,
  grants: [{ role: "operator-viewer", scope: runtimeScope }],
};
test("viewer exact scope, role separation and role-aware policy/audit parsing", () => {
  assert.ok(permits(viewer, "runtime.read", runtimeScope));
  assert.ok(permits(localOwner, "runtime.read", runtimeScope));
  for (const scope of ["*", "runtime:*", "runtime:house", "telegram:-100"]) {
    assert.equal(permits(viewer, "runtime.read", scope), false);
    assert.equal(
      grantSchema.safeParse({ role: "operator-viewer", scope }).success,
      false,
    );
  }
  assert.equal(permits(viewer, "access.manage"), false);
  assert.equal(permits(viewer, "messages.read", "telegram:-100"), false);
  policySchema.parse({
    version: 1,
    principals: [localOwner, { ...viewer, id: "discord:111111111111111111" }],
  });
  auditSchema.parse({
    id: "a",
    at: 1000,
    actor: localOwner.id,
    target: viewer.id,
    action: "update",
    before: viewer,
    after: viewer,
  });
});
test("strict fixture projection removes internal generations, accepts absent observation", () => {
  const result = projectStatus(item(), 1000)!;
  assert.ok(result.lifecycle.heartbeatCurrent);
  runtimeStatusSchema.parse(result);
  assert.equal(JSON.stringify(result).includes('"generation"'), false);
  assert.equal(JSON.stringify(result).includes('"lastHeardGeneration"'), false);
  assert.equal(projectStatus(undefined, 1000), null);
  const historical = fixture();
  historical.lifecycle.lastHeardGeneration = "old";
  assert.equal(
    projectStatus(item(historical), 1000)!.lifecycle.heartbeatCurrent,
    false,
  );
});
test("reject malformed, oversized, privacy-canary, future and inconsistent records", () => {
  const invalid: unknown[] = [
    null,
    { data: "{}", revision: 1 },
    { data: "x".repeat(16385), revision: 1 },
    { ...item(), revision: 2 },
  ];
  for (const change of [
    (s: any) => (s.schemaVersion = 2),
    (s: any) => (s.secret = "privacy-canary"),
    (s: any) => (s.lifecycle.rawError = "privacy-canary"),
    (s: any) => (s.lifecycle.observedAt = 1031),
    (s: any) => (s.lifecycle.lastHeardAt = -1),
    (s: any) => (s.lifecycle.checkpointCreatedAt = 1031),
    (s: any) => (s.publishedAt = Number.MAX_SAFE_INTEGER + 1),
    (s: any) => (s.workers.total = 1),
    (s: any) => delete s.lifecycle.generation,
  ]) {
    const s = fixture();
    change(s);
    invalid.push(item(s));
  }
  for (const value of invalid) assert.throws(() => projectStatus(value, 1000));
});
test("freshness advances without another fetch; error and historical evidence never imply ready", () => {
  const status = projectStatus(item(), 1000)!;
  assert.equal(runtimePresentation(status, 1000).label, "Ready");
  assert.equal(runtimePresentation(status, 1081).label, "Last observed awake");
  assert.match(runtimePresentation(status, 1181).detail, /stale/);
  status.lifecycle.availability = "unavailable";
  assert.equal(runtimePresentation(status, 1000).label, "Status unavailable");
  const asleep = fixture();
  asleep.lifecycle.phase = "asleep";
  asleep.lifecycle.lastHeardAt = 1;
  assert.equal(
    runtimePresentation(projectStatus(item(asleep), 1000)!, 1000).label,
    "Asleep",
  );
});
test("all local scenarios satisfy producer/consumer schema", () => {
  for (const scenario of rehearsalScenarios) {
    const s = rehearsalSnapshot(scenario, 100000);
    const result = projectStatus(s ? item(s) : undefined, 100000);
    if (result) runtimeStatusSchema.parse(result);
  }
});
function appFixture(principal: Principal = localOwner) {
  let reads = 0;
  let source: unknown = item();
  const policy = { version: 0, principals: [principal] };
  const raw = "a".repeat(43);
  const key = `session#${createHash("sha256").update(raw).digest("hex")}`;
  const records = new Map<string, RecordValue>([
    [
      key,
      {
        userId: principal.id.slice(8),
        expires: 2000,
        absoluteExpires: 3000,
        sessionVersion: 0,
      },
    ],
  ]);
  const access = memoryAccess();
  const app = createApp({
    origin: "https://bot.fame.support",
    now: () => 1000,
    access: { ...access.store, read: async () => structuredClone(policy) },
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
        return false;
      },
    },
    oauth: {
      url: () => "",
      identity: async () => ({ id: principal.id.slice(8), username: "test" }),
    },
    operatorStatus: async () => {
      reads++;
      if (source instanceof Error) throw source;
      return source;
    },
  });
  return {
    app,
    policy,
    headers: { Cookie: `__Host-bot-session=${raw}` },
    reads: () => reads,
    source: (value: unknown) => (source = value),
  };
}
test("runtime routes authorize before source read and mask denied and unknown IDs", async () => {
  for (const principal of [
    localOwner,
    viewer,
    { ...viewer, grants: [{ role: "manager" as const, scope: "*" }] },
    { ...viewer, grants: [{ role: "reader" as const, scope: "telegram:*" }] },
  ]) {
    const f = appFixture(principal);
    const allowed = permits(principal, "runtime.read", runtimeScope);
    assert.equal((await f.app.request("/api/runtimes")).status, 401);
    assert.equal(
      (await f.app.request("/api/runtimes/overclaw-leader/status")).status,
      401,
    );
    const list = await f.app.request("/api/runtimes", { headers: f.headers });
    assert.equal((await list.json()).runtimes.length, allowed ? 1 : 0);
    const detail = await f.app.request("/api/runtimes/overclaw-leader/status", {
      headers: f.headers,
    });
    assert.equal(detail.status, allowed ? 200 : 404);
    assert.equal(detail.headers.get("cache-control"), "no-store");
    assert.equal(
      (
        await f.app.request("/api/runtimes/house/status", {
          headers: f.headers,
        })
      ).status,
      404,
    );
    assert.equal(f.reads(), allowed ? 1 : 0);
  }
});
test("revoked grants, disabled and revoked epochs stop reads immediately", async () => {
  for (const change of [
    (p: Principal) => (p.grants = [{ role: "reader", scope: "telegram:*" }]),
    (p: Principal) => (p.enabled = false),
    (p: Principal) => p.sessionVersion++,
  ]) {
    const f = appFixture(structuredClone(viewer));
    assert.equal(
      (
        await f.app.request("/api/runtimes/overclaw-leader/status", {
          headers: f.headers,
        })
      ).status,
      200,
    );
    change(f.policy.principals[0]);
    assert.ok(
      [401, 404].includes(
        (
          await f.app.request("/api/runtimes/overclaw-leader/status", {
            headers: f.headers,
          })
        ).status,
      ),
    );
    assert.equal(f.reads(), 1);
  }
});
test("missing snapshot distinct from upstream failure, errors never leak", async () => {
  const f = appFixture();
  f.source(undefined);
  assert.deepEqual(
    await (
      await f.app.request("/api/runtimes/overclaw-leader/status", {
        headers: f.headers,
      })
    ).json(),
    { status: null },
  );
  for (const value of [
    new Error("secret-canary"),
    { data: "secret-canary", revision: 1 },
  ]) {
    f.source(value);
    const response = await f.app.request(
      "/api/runtimes/overclaw-leader/status",
      { headers: f.headers },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("secret-canary"), false);
  }
});

test("Dynamo reader fixes region/table/key, uses consistent bounded single-attempt reads", async (t) => {
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const { operatorStatusReader } = await import("../server/operator-status");
  const oldTable = process.env.OPERATOR_STATUS_TABLE;
  const oldRegion = process.env.OPERATOR_STATUS_REGION;
  process.env.OPERATOR_STATUS_TABLE = "OverclawLeader-OperatorStatus";
  process.env.OPERATOR_STATUS_REGION = "us-west-1";
  t.after(() => {
    if (oldTable === undefined) delete process.env.OPERATOR_STATUS_TABLE;
    else process.env.OPERATOR_STATUS_TABLE = oldTable;
    if (oldRegion === undefined) delete process.env.OPERATOR_STATUS_REGION;
    else process.env.OPERATOR_STATUS_REGION = oldRegion;
  });
  let calls = 0;
  t.mock.method(
    DynamoDBDocumentClient.prototype,
    "send",
    async function (
      this: ReturnType<typeof DynamoDBDocumentClient.from>,
      command: { input: unknown },
      options: { abortSignal: AbortSignal },
    ) {
      calls++;
      assert.equal(await this.config.region(), "us-west-1");
      assert.equal(await this.config.maxAttempts(), 1);
      assert.deepEqual(command.input, {
        TableName: "OverclawLeader-OperatorStatus",
        Key: { pk: "runtime:overclaw-leader" },
        ConsistentRead: true,
      });
      assert.ok(options.abortSignal instanceof AbortSignal);
      return { Item: item() };
    },
  );
  assert.deepEqual(await operatorStatusReader()(), item());
  assert.equal(calls, 1);
  t.mock.restoreAll();
  t.mock.method(DynamoDBDocumentClient.prototype, "send", async () => {
    throw new Error("timeout");
  });
  await assert.rejects(operatorStatusReader()(), /timeout/);
});

test("contradictory availability and observation order fail closed", () => {
  for (const change of [
    (s: ReturnType<typeof fixture>) => {
      s.lifecycle.phase = "asleep";
      s.lifecycle.error = "reconcile_failed";
    },
    (s: ReturnType<typeof fixture>) => {
      s.lifecycle.availability = "unavailable";
    },
    (s: ReturnType<typeof fixture>) => {
      s.lifecycle.observedAt = null;
    },
    (s: ReturnType<typeof fixture>) => {
      s.workers.counts = null;
      s.workers.total = null;
    },
    (s: ReturnType<typeof fixture>) => {
      s.workers.error = "orphan_compute";
    },
    (s: ReturnType<typeof fixture>) => {
      s.workers.observedAt = 1001;
    },
  ]) {
    const s = fixture();
    change(s);
    assert.throws(() => projectStatus(item(s), 1000));
  }
});

test("real reader timeout aborts a pending SDK read rather than leaving work running", async (t) => {
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const { operatorStatusReader } = await import("../server/operator-status");
  const oldTable = process.env.OPERATOR_STATUS_TABLE;
  const oldRegion = process.env.OPERATOR_STATUS_REGION;
  process.env.OPERATOR_STATUS_TABLE = "OverclawLeader-OperatorStatus";
  process.env.OPERATOR_STATUS_REGION = "us-west-1";
  t.after(() => {
    if (oldTable === undefined) delete process.env.OPERATOR_STATUS_TABLE;
    else process.env.OPERATOR_STATUS_TABLE = oldTable;
    if (oldRegion === undefined) delete process.env.OPERATOR_STATUS_REGION;
    else process.env.OPERATOR_STATUS_REGION = oldRegion;
  });
  let pending = false;
  let calls = 0;
  t.mock.method(
    DynamoDBDocumentClient.prototype,
    "send",
    async (_command: unknown, options: { abortSignal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        calls++;
        pending = true;
        options.abortSignal.addEventListener(
          "abort",
          () => {
            pending = false;
            reject(options.abortSignal.reason);
          },
          { once: true },
        );
      }),
  );
  // AbortSignal.timeout does not keep the event loop alive; model the SDK socket.
  const socket = setInterval(() => {}, 100);
  try {
    await assert.rejects(
      operatorStatusReader()(),
      (error: unknown) =>
        error instanceof Error && error.name === "TimeoutError",
    );
  } finally {
    clearInterval(socket);
  }
  assert.equal(calls, 1);
  assert.equal(pending, false);
});

test("role-aware persistence artifact round-trips saved policy and audit after viewer removal", async () => {
  const { accessStore } = await import("../server/access-store");
  const { editAccess } = await import("../server/access");
  const { GetCommand, QueryCommand, TransactWriteCommand } = await import(
    "@aws-sdk/lib-dynamodb"
  );
  let policy: Record<string, unknown> = {
    value: { version: 0, principals: [localOwner] },
  };
  const events: Record<string, unknown>[] = [];
  const store = accessStore("fixture", async (command) => {
    if (command instanceof GetCommand)
      return { Item: JSON.parse(JSON.stringify(policy)) };
    if (command instanceof QueryCommand)
      return { Items: JSON.parse(JSON.stringify(events)) };
    assert.ok(command instanceof TransactWriteCommand);
    const [write, audit] = command.input.TransactItems!;
    policy = JSON.parse(JSON.stringify(write.Put!.Item));
    events.push(JSON.parse(JSON.stringify(audit.Put!.Item)));
    return {};
  });
  const { sessionVersion: _epoch, ...person } = {
    ...viewer,
    id: "discord:111111111111111111",
  };
  await editAccess(
    store,
    localOwner.id,
    { version: 0, principal: person, revokeSessions: false },
    1000,
  );
  assert.equal(
    (await store.read()).principals[1].grants[0].role,
    "operator-viewer",
  );
  await editAccess(
    store,
    localOwner.id,
    {
      version: 1,
      principal: {
        ...person,
        grants: [{ role: "reader", scope: "telegram:*" }],
      },
      revokeSessions: false,
    },
    1001,
  );
  assert.equal((await store.read()).principals[1].grants[0].role, "reader");
  assert.equal(
    (await store.audit())[0].after.grants[0].role,
    "operator-viewer",
  );
  assert.equal(
    (await store.audit())[1].before!.grants[0].role,
    "operator-viewer",
  );
});

test("all producer contract fixtures round-trip the strict browser projection", () => {
  const scenarios = {
    ready: 1000,
    starting: 1000,
    asleep: 100000,
    recovery: 1000,
    "stale-observer": 2000,
    "partial-failure": 1010,
    "historical-checkpoint": 1000,
    "no-observation": 1000,
  };
  for (const [name, now] of Object.entries(scenarios)) {
    const fixture = JSON.parse(
      readFileSync(
        new URL(`./fixtures/operator-status/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
    const result = projectStatus(
      fixture
        ? { data: JSON.stringify(fixture), revision: fixture.revision }
        : undefined,
      now,
    );
    if (result) runtimeStatusSchema.parse(result);
    else assert.equal(name, "no-observation");
  }
});
