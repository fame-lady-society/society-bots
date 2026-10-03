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
  chats: z
    .array(
      z.object({
        id: z.string().regex(/^-\d+$/),
        name: z.string().min(1).max(200),
      }),
    )
    .max(20),
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
const update = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: message.optional(),
  edited_message: message.optional(),
});
export function normalizeUpdate(
  raw: unknown,
  config: TelegramConfig,
  now: number,
): CapturedMessage | null {
  const data = update.parse(raw);
  const m = data.edited_message ?? data.message;
  if (
    !m ||
    !["group", "supergroup"].includes(m.chat.type) ||
    !config.chats.some((c) => c.id === String(m.chat.id))
  )
    return null;
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
export function webhookApp(
  config: TelegramConfig,
  enqueue: (m: CapturedMessage) => Promise<void>,
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
    let item: CapturedMessage | null;
    try {
      item = normalizeUpdate(
        JSON.parse(Buffer.from(body).toString("utf8")),
        config,
        now(),
      );
    } catch {
      return c.body(null, 400);
    }
    if (item) await enqueue(item);
    return c.body(null, 204);
  });
  return app;
}
