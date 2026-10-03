import { principalSchema } from "./access-contracts";
import { z } from "zod";
export const sessionSchema = z.object({
  user: z.object({ id: z.string(), name: z.string() }),
  rehearsal: z.boolean(),
  principal: principalSchema,
  expires: z.number(),
  absoluteExpires: z.number(),
});
export const caseSchema = z.object({
  id: z.string(),
  title: z.string(),
  platform: z.enum(["Discord", "Telegram"]),
  channel: z.string(),
  subject: z.string(),
  reason: z.string(),
  action: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  messages: z.array(
    z.object({
      id: z.string(),
      author: z.string(),
      text: z.string(),
      time: z.string(),
    }),
  ),
});
export const casesSchema = z.array(caseSchema);
export type Incident = z.infer<typeof caseSchema>;
