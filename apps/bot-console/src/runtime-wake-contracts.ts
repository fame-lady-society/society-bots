import { z } from "zod";
export const wakeInputSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .regex(/^[a-f0-9-]+$/),
  })
  .strict();
export const wakeRequestSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .regex(/^[a-f0-9-]+$/),
    runtimeId: z.literal("overclaw-leader"),
    action: z.literal("wake"),
    actor: z.string().regex(/^discord:\d{17,20}$/),
    requestedAt: z.number().int().nonnegative(),
  })
  .strict();
export const wakeReceiptSchema = z
  .object({
    request: wakeRequestSchema,
    outcome: z.enum(["accepted", "already-running", "rejected"]),
    reason: z.enum([
      "wake-requested",
      "already-running",
      "expired",
      "runtime-busy",
      "pending-lifecycle-command",
    ]),
  })
  .strict();
export const wakeRecordSchema = z
  .object({
    request: wakeRequestSchema,
    outcome: z.enum([
      "pending",
      "unknown",
      "accepted",
      "already-running",
      "rejected",
    ]),
    reason: z.string(),
  })
  .strict();
export type WakeRequest = z.infer<typeof wakeRequestSchema>;
export type WakeRecord = z.infer<typeof wakeRecordSchema>;
export type WakeReceipt = z.infer<typeof wakeReceiptSchema>;
export function wakeMessage(record: WakeRecord) {
  switch (record.outcome) {
    case "accepted":
      return "Wake accepted. Current startup progress and readiness are shown below.";
    case "already-running":
      return "The runtime is already awake or a wake is pending. Check its current status below.";
    case "rejected":
      return record.reason === "expired"
        ? "This wake request expired. Submit a new request if you still want to wake the runtime."
        : "Wake was not accepted while another lifecycle operation or recovery is in progress. Check the runtime status.";
    default:
      return "Wake outcome is uncertain. It may have been accepted. Check the same request again before starting another.";
  }
}
