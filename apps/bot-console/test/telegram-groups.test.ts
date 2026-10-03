import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codeAlphabet,
  generateCode,
  normalizeCode,
  hashCode,
  groupService,
  GroupConflict,
} from "../server/telegram-groups";
import { memoryGroupStore } from "../local/group-store";
import { webhookApp, type CapturedMessage } from "../server/telegram";
import { dynamoGroupStore } from "../server/telegram-groups-store";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { saveMessage } from "../server/telegram-store";
import { verifyGroup } from "../server/telegram-verifier";
const config = {
  webhookSecret: "s".repeat(48),
  botId: "7393738833" as const,
  username: "famesocietybot" as const,
};
function fixture() {
  const memory = memoryGroupStore();
  let now = 1000,
    failVerification = false;
  const service = groupService(
    memory.store,
    async () => {
      if (failVerification) throw new Error("Unavailable");
      return { name: "Verified group" };
    },
    () => now,
  );
  const queued: (CapturedMessage & { associationId: string })[] = [];
  const app = webhookApp(
    config,
    async (m) => {
      queued.push(m);
    },
    { ...memory.store, redeem: service.redeem },
    () => now,
  );
  let messageId = 1;
  function send(
    text: string,
    overrides: Record<string, unknown> = {},
    edited = false,
  ) {
    return app.request("/api/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": config.webhookSecret },
      body: JSON.stringify({
        update_id: messageId,
        [edited ? "edited_message" : "message"]: {
          message_id: messageId++,
          date: now,
          chat: { id: -100, type: "supergroup", title: "Untrusted title" },
          from: { id: 777, first_name: "Unlinked person" },
          text,
          ...overrides,
        },
      }),
    });
  }
  return {
    ...memory,
    service,
    send,
    queued,
    advance: (n: number) => (now += n),
    failVerify: () => (failVerification = true),
  };
}
test("eight symbols carry 40 random bits; hyphen and case are presentation only", () => {
  assert.equal(new Set(codeAlphabet).size, 32);
  const generated = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const code = generateCode();
    assert.equal(code.id, hashCode(normalizeCode(code.code)!));
    assert.equal(
      normalizeCode(code.code.toLowerCase()),
      code.code.replace("-", ""),
    );
    generated.add(code.code);
  }
  assert.equal(generated.size, 1000);
  assert.equal(normalizeCode("7KMP-X4RT"), "7KMPX4RT");
  for (const invalid of ["123", "1234--5678", "OOOO-OOOO", " 7KMP-X4RT"])
    assert.equal(normalizeCode(invalid), null);
});
test("unlinked sender redeems once; approval gates capture; disconnect/reconnect preserves history and changes generation", async () => {
  const f = fixture(),
    invite = await f.service.issue("console-admin");
  assert.equal((await f.send(invite.command)).status, 204);
  assert.equal(f.invites.get(invite.id)?.state, "used");
  const pending = f.groups.get("-100")!;
  assert.equal(pending.requestedBy, "777");
  assert.equal(pending.createdBy, "console-admin");
  assert.equal(pending.state, "pending");
  await f.send("before approval");
  assert.equal(f.queued.length, 0);
  await f.send(invite.command, { chat: { id: -200, type: "group" } });
  assert.equal(f.groups.size, 1);
  f.advance(2);
  const active = await f.service.decide(
    pending.id,
    pending.requestId,
    "approve",
    "approver",
  );
  assert.equal(active.name, "Verified group");
  await f.send(
    "old message edited after approval",
    { date: 1000, edit_date: 1002 },
    true,
  );
  assert.equal(f.queued.length, 0);
  await f.send("same-second backlog");
  assert.equal(f.queued.length, 0);
  f.advance(1);
  await f.send("new message");
  await f.send("new edit", { message_id: 5, edit_date: 1002 }, true);
  assert.equal(f.queued.length, 2);
  await f.send(
    "onboarding edited into plain text",
    { message_id: 1, date: 1000 },
    true,
  );
  assert.equal(f.queued.length, 2);
  await f.service.decide(active.id, active.requestId, "disconnect", "approver");
  await f.send("after disconnect");
  assert.equal(f.queued.length, 2);
  const nextInvite = await f.service.issue("console-admin");
  f.advance(60);
  await f.send(nextInvite.command);
  const next = f.groups.get("-100")!;
  assert.equal(next.hasHistory, true);
  const again = await f.service.decide(
    next.id,
    next.requestId,
    "approve",
    "approver",
  );
  assert.notEqual(again.associationId, active.associationId);
  assert.equal(f.audit.length, 5);
});
test("invalid, expired, revoked, forwarded, edited, private and channel commands do not consume codes", async () => {
  const f = fixture(),
    i = await f.service.issue("operator");
  for (const type of ["private", "channel"])
    await f.send(i.command, {
      chat: { id: type === "private" ? 4 : -100, type },
    });
  await f.send(i.command, { forward_origin: { type: "user" } });
  await f.send(i.command, {}, true);
  await f.send("/start@famesocietybot BAD-CODE");
  assert.equal(f.invites.get(i.id)?.state, "available");
  assert.equal(f.groups.size, 0);
  f.advance(600);
  await f.send(i.command);
  assert.equal(f.groups.size, 0); // TTL has deliberately not removed the row.
  const revoked = await f.service.issue("operator");
  await f.service.revoke(revoked.id, "operator");
  await f.send(revoked.command);
  assert.equal(f.groups.size, 0);
});
test("concurrent redemption creates exactly one pending group; competing decisions cannot overwrite", async () => {
  const f = fixture(),
    i = await f.service.issue("operator");
  await Promise.all([
    f.service.redeem(i.code, "-100", "A", "42"),
    f.service.redeem(i.code, "-200", "B", "43"),
  ]);
  assert.equal(f.groups.size, 1);
  assert.equal(f.audit.length, 1);
  const g = [...f.groups.values()][0];
  const results = await Promise.allSettled([
    f.service.decide(g.id, g.requestId, "approve", "op"),
    f.service.decide(g.id, g.requestId, "reject", "op"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test("verification failure leaves pending state; rejection requires a fresh code", async () => {
  const f = fixture(),
    i = await f.service.issue("operator");
  await f.send(i.command);
  const g = f.groups.get("-100")!;
  f.failVerify();
  await assert.rejects(f.service.decide(g.id, g.requestId, "approve", "op"));
  assert.equal(f.groups.get(g.id)?.state, "pending");
  await f.service.decide(g.id, g.requestId, "reject", "op");
  await f.send(i.command);
  assert.equal(f.groups.get(g.id)?.state, "rejected");
  await assert.rejects(
    f.service.decide(g.id, g.requestId, "approve", "op"),
    GroupConflict,
  );
});
test("redemption is rate limited across groups, not only per attacker-selected group", async () => {
  const f = fixture();
  for (let n = 0; n < 100; n++)
    await f.service.redeem("7KMP-X4RT", `-${n + 1000}`, "Guess", "42");
  const i = await f.service.issue("operator");
  await f.service.redeem(i.code, "-100", "Real", "42");
  assert.equal(f.groups.size, 0);
  f.advance(60);
  await f.service.redeem(i.code, "-100", "Real", "42");
  assert.equal(f.groups.size, 1);
});
test("Dynamo redemption couples expiry/one-use, pending group and audit in one transaction; storage failures propagate", async () => {
  const f = fixture(),
    i = await f.service.issue("operator");
  await f.send(i.command);
  const g = f.groups.get("-100")!;
  const commands: TransactWriteCommand[] = [];
  const store = dynamoGroupStore("registry", async (c) => {
    assert.ok(c instanceof TransactWriteCommand);
    commands.push(c);
    return {};
  });
  await store.redeem(i.id, g, undefined, 1000);
  const items = commands[0].input.TransactItems!;
  assert.equal(items.length, 3);
  assert.equal(
    items[0].Update?.ConditionExpression,
    "#state = :available AND expires > :now",
  );
  assert.equal(items[1].Put?.ConditionExpression, "attribute_not_exists(pk)");
  assert.ok(!JSON.stringify(commands[0].input).includes(i.code));
  for (const error of [
    new Error("storage outage"),
    Object.assign(new Error("transaction conflict"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "TransactionConflict" }],
    }),
  ]) {
    const broken = dynamoGroupStore("registry", async () => {
      throw error;
    });
    await assert.rejects(broken.redeem(i.id, g, undefined, 1000), error);
  }
});
test("Dynamo rate buckets are conditional and expire; failed counters fail closed", async () => {
  const store = dynamoGroupStore("registry", async (c) => {
    assert.ok(c instanceof UpdateCommand);
    assert.equal(
      c.input.ConditionExpression,
      "attribute_not_exists(attempts) OR attempts < :limit",
    );
    assert.equal(c.input.ExpressionAttributeValues?.[":expires"], 1080);
    throw Object.assign(new Error(), {
      name: "ConditionalCheckFailedException",
    });
  });
  assert.equal(await store.rate("global", 100, 1000), false);
});
test("every archive write atomically checks the active association and command exclusion", async () => {
  const f = fixture(),
    i = await f.service.issue("op");
  await f.send(i.command);
  const g = f.groups.get("-100")!;
  await f.service.decide(g.id, g.requestId, "approve", "op");
  f.advance(1);
  await f.send("capture");
  const item = f.queued[0];
  let calls = 0;
  await assert.rejects(
    saveMessage(item, item.associationId, async (c) => {
      calls++;
      const checks = c.input.TransactItems!;
      assert.equal(
        checks[0].ConditionCheck?.ExpressionAttributeValues?.[":association"],
        item.associationId,
      );
      assert.equal(checks[1].ConditionCheck?.Key?.sk, item.messageId);
      throw Object.assign(new Error("disconnected"), {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
          { Code: "None" },
        ],
      });
    }),
  );
  assert.equal(calls, 1);
});
test("verifier checks exact bot and group, rejects member-only, private, migration and API failures", async () => {
  const chat = { id: -100, type: "supergroup", title: "Verified" },
    member = {
      status: "administrator",
      user: { id: 7393738833, is_bot: true },
    };
  assert.deepEqual(
    await verifyGroup("-100", async (method) =>
      method === "getChat" ? chat : member,
    ),
    { name: "Verified" },
  );
  for (const [c, m] of [
    [{ ...chat, id: -200 }, member],
    [{ ...chat, type: "private" }, member],
    [chat, { ...member, status: "member" }],
    [chat, { ...member, user: { id: 7, is_bot: true } }],
  ])
    await assert.rejects(
      verifyGroup("-100", async (method) => (method === "getChat" ? c : m)),
    );
  await assert.rejects(
    verifyGroup("-100", async () => {
      throw new Error("network");
    }),
  );
});
