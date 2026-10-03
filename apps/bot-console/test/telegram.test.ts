import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUpdate,
  webhookApp,
  type TelegramConfig,
} from "../server/telegram";
import { saveMessage } from "../server/telegram-store";
import type { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
const config: TelegramConfig = {
  webhookSecret: "s".repeat(48),
  botId: "7393738833",
  username: "famesocietybot",
};
const groups = {
  async get(id: string) {
    return id === "-100"
      ? {
          id,
          name: "Test",
          state: "active" as const,
          requestId: "test",
          requestedBy: "42",
          createdBy: "operator",
          requestedAt: 0,
          updatedAt: 0,
          updatedBy: "operator",
          hasHistory: true,
          associationId: "association",
          activatedAt: 0,
        }
      : undefined;
  },
  async redeem() {},
  async ignore() {},
  async ignored() {
    return false;
  },
};
const message = {
  message_id: 1,
  date: 1000,
  chat: { id: -100, type: "supergroup", title: "Test" },
  from: { id: 42, first_name: "Untrusted" },
  text: "<script>hello</script>",
};
const original = { update_id: 1, message };
function post(
  app: ReturnType<typeof webhookApp>,
  body: unknown,
  secret = config.webhookSecret,
) {
  return app.request("/api/telegram/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(body),
  });
}
test("webhook rejects spoofed requests and acknowledges only after durable enqueue", async () => {
  let writes = 0;
  const app = webhookApp(
    config,
    async () => {
      writes++;
      throw new Error("private internals");
    },
    groups,
    () => 2000,
  );
  assert.equal((await post(app, original, "wrong")).status, 403);
  assert.equal(writes, 0);
  const r = await post(app, original);
  assert.equal(r.status, 503);
  assert.equal(writes, 1);
  assert.equal((await r.text()).includes("private"), false);
});
test("only explicitly allowed groups are captured; private and unsupported updates are ignored", async () => {
  let writes = 0;
  const app = webhookApp(
    config,
    async () => {
      writes++;
    },
    groups,
    () => 2000,
  );
  for (const body of [
    { update_id: 3 },
    {
      update_id: 4,
      message: { ...message, chat: { id: 42, type: "private" } },
    },
    {
      update_id: 5,
      message: { ...message, chat: { id: -200, type: "supergroup" } },
    },
  ])
    assert.equal((await post(app, body)).status, 204);
  assert.equal(writes, 0);
  assert.equal((await post(app, original)).status, 204);
  assert.equal(writes, 1);
});
test("malformed and oversized payloads fail without enqueue", async () => {
  let writes = 0;
  const app = webhookApp(
    config,
    async () => {
      writes++;
    },
    groups,
    () => 2000,
  );
  assert.equal(
    (await post(app, { ...original, update_id: "bad" })).status,
    400,
  );
  assert.equal((await post(app, { blob: "a".repeat(130 * 1024) })).status, 413);
  assert.equal(writes, 0);
});
test("capture preserves literal untrusted content, sender-chat attribution and fixed retention", () => {
  const item = normalizeUpdate(original, 2000)!;
  assert.equal(item.text, message.text);
  assert.equal(item.expires, 1000 + 3 * 365 * 86400);
  const edited = normalizeUpdate(
    {
      update_id: 2,
      edited_message: {
        ...message,
        edit_date: 3000,
        sender_chat: { id: -100, title: "Anonymous admin" },
      },
    },
    4000,
  )!;
  assert.equal(edited.senderId, "chat:-100");
  assert.equal(edited.author, "Anonymous admin");
  assert.equal(edited.expires, item.expires);
  assert.equal(normalizeUpdate(original, item.expires), null);
});
test("replay after partial failure repairs latest projection; old edits cannot replace new content", async () => {
  const rows = new Map<string, Record<string, any>>();
  let failProjection = true;
  const send = async (command: TransactWriteCommand) => {
    const c = { input: command.input.TransactItems![2].Put! };
    const i = c.input.Item!;
    const key = `${i.pk}|${i.sk}`;
    const prev = rows.get(key);
    if (i.pk.startsWith("chat#") && failProjection) {
      failProjection = false;
      throw new Error("Transient storage error");
    }
    const cond = c.input.ConditionExpression!;
    if (
      prev &&
      (cond === "attribute_not_exists(pk)" ||
        (i.version && prev.version >= i.version) ||
        (i.lastCapturedAt && prev.lastCapturedAt >= i.lastCapturedAt))
    ) {
      const e = new Error("Conditional");
      e.name = "TransactionCanceledException";
      Object.assign(e, {
        CancellationReasons: [
          { Code: "None" },
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
        ],
      });
      throw e;
    }
    rows.set(key, i);
    return {};
  };
  const old = normalizeUpdate(original, 2000)!;
  await assert.rejects(saveMessage(old, "association", send));
  await saveMessage(old, "association", send);
  const newer = normalizeUpdate(
    {
      update_id: 3,
      edited_message: { ...message, edit_date: 3000, text: "New" },
    },
    3001,
  )!;
  await saveMessage(newer, "association", send);
  await saveMessage(old, "association", send);
  await saveMessage(newer, "association", send);
  const projection = [...rows.values()].find((r) => r.pk === "chat#-100")!;
  assert.equal(projection.text, "New");
  assert.equal(
    [...rows.values()].filter((r) => r.pk.startsWith("revision#")).length,
    2,
  );
});
