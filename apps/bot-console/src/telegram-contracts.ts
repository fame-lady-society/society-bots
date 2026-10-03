import { z } from "zod";
export const capturedMessageSchema = z.object({
  updateId: z.number().int().nonnegative().safe(),
  chatId: z.string().regex(/^-\d+$/),
  messageId: z.string().regex(/^\d+$/),
  chatName: z.string(),
  senderId: z.string().nullable(),
  author: z.string(),
  username: z.string().nullable(),
  senderIsBot: z.boolean(),
  text: z.string().max(32768),
  sentAt: z.number().int(),
  editedAt: z.number().int().nullable(),
  receivedAt: z.number().int(),
  attachment: z
    .object({
      kind: z.enum(["photo", "document"]),
      fileId: z.string(),
      name: z.string().nullable(),
      bytes: z.number().nullable(),
    })
    .nullable(),
  expires: z.number().int(),
  version: z.string(),
});
export type CapturedMessage = z.infer<typeof capturedMessageSchema>;

export const messagePageSchema = z.object({
  items: z.array(capturedMessageSchema),
  cursor: z.string().nullable(),
});
export const connectionSchema = z.object({
  username: z.string(),
  botId: z.string(),
  registeredAt: z.string().nullable(),
  chats: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      state: z.enum(["pending", "active", "rejected", "disconnected"]),
      lastCapturedAt: z.number().nullable(),
    }),
  ),
  queued: z.number(),
  failed: z.number(),
});
