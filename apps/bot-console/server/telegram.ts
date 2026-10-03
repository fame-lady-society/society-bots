import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  capturedMessageSchema,
  type CapturedMessage,
} from "../src/telegram-contracts";
export {
  capturedMessageSchema,
  type CapturedMessage,
} from "../src/telegram-contracts";

export const telegramConfigSchema = z.object({
  webhookSecret: z.string().min(32),
  botId: z.literal("7393738833"),
  username: z.literal("famesocietybot"),
  registeredAt: z.string().datetime().optional(),
});
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;
const user = z.object({
  id: z.number().int().safe(),
  first_name: z.string().max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(256).optional(),
  is_bot: z.boolean().optional(),
});
const message = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().nonnegative(),
  edit_date: z.number().int().nonnegative().optional(),
  chat: z.object({
    id: z.number().int().safe(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
    title: z.string().max(256).optional(),
  }),
  from: user.optional(),
  sender_chat: z
    .object({
      id: z.number().int().safe(),
      title: z.string().max(256).optional(),
    })
    .optional(),
  text: z.string().max(32768).optional(),
  forward_origin: z.unknown().optional(),
  caption: z.string().max(32768).optional(),
  photo: z
    .array(
      z.object({
        file_id: z.string().max(1024),
        file_size: z.number().optional(),
      }),
    )
    .optional(),
  document: z
    .object({
      file_id: z.string().max(1024),
      file_name: z.string().max(512).optional(),
      file_size: z.number().optional(),
    })
    .optional(),
});
export const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: message.optional(),
  edited_message: message.optional(),
});
export function normalizeUpdate(
  raw: unknown,
  now: number,
): CapturedMessage | null {
  const data = updateSchema.parse(raw);
  const m = data.edited_message ?? data.message;
  if (!m || !["group", "supergroup"].includes(m.chat.type)) return null;
  const photo = m.photo?.at(-1);
  const expires = m.date + 3 * 365 * 86400;
  if (expires <= now) return null;
  return capturedMessageSchema.parse({
    updateId: data.update_id,
    chatId: String(m.chat.id),
    messageId: String(m.message_id),
    chatName: m.chat.title ?? "Telegram group",
    senderId: m.sender_chat
      ? `chat:${m.sender_chat.id}`
      : m.from
        ? String(m.from.id)
        : null,
    author: m.sender_chat
      ? (m.sender_chat.title ?? "Anonymous administrator")
      : m.from
        ? [m.from.first_name, m.from.last_name].filter(Boolean).join(" ")
        : "Unknown sender",
    username: m.sender_chat ? null : (m.from?.username ?? null),
    senderIsBot: m.from?.is_bot ?? false,
    text: m.text ?? m.caption ?? "[Non-text message]",
    sentAt: m.date,
    editedAt: m.edit_date ?? null,
    receivedAt: now,
    attachment: m.document
      ? {
          kind: "document",
          fileId: m.document.file_id,
          name: m.document.file_name ?? null,
          bytes: m.document.file_size ?? null,
        }
      : photo
        ? {
            kind: "photo",
            fileId: photo.file_id,
            name: null,
            bytes: photo.file_size ?? null,
          }
        : null,
    expires,
    version: `${String(m.edit_date ?? m.date).padStart(12, "0")}:${String(data.update_id).padStart(16, "0")}`,
  });
}
export interface WebhookGroups {
  ignore(chatId: string, messageId: string, expires: number): Promise<void>;
  ignored(chatId: string, messageId: string): Promise<boolean>;
  get(
    id: string,
  ): Promise<
    import("../src/telegram-groups-contracts").TelegramGroup | undefined
  >;
  redeem(
    code: string,
    chatId: string,
    name: string,
    sender: string,
  ): Promise<void>;
}
// Suppress onboarding commands in original messages, forwards, captions and edits.
export const isStartCommand = (text: string | undefined) =>
  /^\/start(?:@famesocietybot)?(?:\s|$)/i.test(text ?? "");
export function webhookApp(
  config: TelegramConfig,
  enqueue: (m: CapturedMessage & { associationId: string }) => Promise<void>,
  groups: WebhookGroups,
  now = () => Math.floor(Date.now() / 1000),
) {
  const app = new Hono();
  app.onError(() => new Response("Temporarily unavailable", { status: 503 }));
  app.post("/api/telegram/webhook", async (c) => {
    const provided = Buffer.from(
      c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "",
    );
    const expected = Buffer.from(config.webhookSecret);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      return c.body(null, 403);
    // Check actual bytes, not just a caller-controlled Content-Length header.
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 128 * 1024) return c.body(null, 413);
    let data: z.infer<typeof updateSchema>;
    try {
      data = updateSchema.parse(JSON.parse(Buffer.from(body).toString("utf8")));
    } catch {
      return c.body(null, 400);
    }
    const m = data.edited_message ?? data.message;
    if (!m || !["group", "supergroup"].includes(m.chat.type))
      return c.body(null, 204);
    const group = await groups.get(String(m.chat.id));
    if (isStartCommand(m.text) || isStartCommand(m.caption)) {
      if (group?.hasHistory)
        await groups.ignore(
          String(m.chat.id),
          String(m.message_id),
          m.date + 3 * 365 * 86400,
        );
      const match = m.text?.match(
        /^\/start@famesocietybot\s+([A-Za-z0-9-]+)\s*$/i,
      );
      if (
        match &&
        !data.edited_message &&
        !m.edit_date &&
        !m.forward_origin &&
        !m.sender_chat &&
        m.from &&
        !m.from.is_bot
      )
        await groups.redeem(
          match[1],
          String(m.chat.id),
          m.chat.title ?? "Telegram group",
          String(m.from.id),
        );
      return c.body(null, 204);
    }
    if (await groups.ignored(String(m.chat.id), String(m.message_id)))
      return c.body(null, 204);
    const time = now();
    // Original message date prevents pre-approval backlog and its later edits from entering capture.
    if (
      group?.state !== "active" ||
      !group.associationId ||
      m.date < group.activatedAt!
    )
      return c.body(null, 204);
    const item = normalizeUpdate(data, time);
    if (item) await enqueue({ ...item, associationId: group.associationId });
    return c.body(null, 204);
  });
  return app;
}
