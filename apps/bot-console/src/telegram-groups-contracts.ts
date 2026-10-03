import { z } from "zod";
export const groupSchema = z.object({
  id: z.string().regex(/^-\d+$/),
  name: z.string(),
  state: z.enum(["pending", "active", "rejected", "disconnected"]),
  requestId: z.string(),
  requestedBy: z.string(),
  createdBy: z.string(),
  requestedAt: z.number(),
  updatedAt: z.number(),
  updatedBy: z.string(),
  associationId: z.string().optional(),
  activatedAt: z.number().optional(),
  hasHistory: z.boolean(),
});
export type TelegramGroup = z.infer<typeof groupSchema>;
export const groupsSchema = z.array(groupSchema);
export const inviteSchema = z.object({
  id: z.string(),
  expires: z.number(),
  state: z.enum(["available", "used", "revoked"]),
  createdBy: z.string(),
  chatId: z.string().optional(),
});
export type Invite = z.infer<typeof inviteSchema>;
export const issuedInviteSchema = inviteSchema.extend({
  code: z.string(),
  command: z.string(),
});
