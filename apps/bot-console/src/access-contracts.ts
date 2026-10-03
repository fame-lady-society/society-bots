import { z } from "zod";
export const roles = {
  owner: {
    name: "Owner",
    permissions: [
      "access.manage",
      "connections.read",
      "connections.manage",
      "messages.read",
    ],
    scope: "global",
    description:
      "Manage portal access and all Telegram connections and history.",
  },
  reader: {
    name: "Inbox reader",
    permissions: ["connections.read", "messages.read"],
    scope: "telegram",
    description: "Read captured messages for the assigned Telegram group(s).",
  },
  manager: {
    name: "Connection manager",
    permissions: ["connections.read", "connections.manage"],
    scope: "global",
    description:
      "Connect and disconnect Telegram groups. Does not grant message access.",
  },
} as const;
export const grantSchema = z
  .object({
    role: z.enum(["owner", "reader", "manager"]),
    scope: z.string().max(80),
  })
  .strict()
  .refine(
    (g) =>
      g.role === "reader"
        ? g.scope === "telegram:*" || /^telegram:-\d+$/.test(g.scope)
        : g.scope === "*",
    "Invalid scope for role",
  );
export const principalSchema = z
  .object({
    id: z
      .string()
      .regex(/^(discord:\d{17,20}|(?:agent|service):[a-z][a-z0-9-]{0,63})$/),
    kind: z.enum(["human", "agent", "service"]),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean(),
    grants: z.array(grantSchema).max(20),
    sessionVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (p) => p.id.startsWith(p.kind === "human" ? "discord:" : `${p.kind}:`),
    "Identity kind mismatch",
  )
  .refine(
    (p) => p.kind === "human" || !p.grants.some((g) => g.role === "owner"),
    "Only people can be owners",
  );
export const policySchema = z
  .object({
    version: z.number().int().nonnegative(),
    principals: z.array(principalSchema).max(100),
  })
  .strict()
  .refine(
    (p) => new Set(p.principals.map((x) => x.id)).size === p.principals.length,
    "Duplicate identity",
  )
  .refine(
    (p) =>
      p.principals.some(
        (x) =>
          x.enabled &&
          x.kind === "human" &&
          x.grants.some((g) => g.role === "owner"),
      ),
    "At least one active owner is required",
  );
export type Principal = z.infer<typeof principalSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Permission =
  (typeof roles)[keyof typeof roles]["permissions"][number];
export function permits(
  p: Principal,
  permission: Permission,
  scope = "*",
): boolean {
  return (
    p.enabled &&
    p.grants.some(
      (g) =>
        (roles[g.role].permissions as readonly string[]).includes(permission) &&
        (g.scope === "*" ||
          g.scope === scope ||
          (g.scope === "telegram:*" && /^telegram:-\d+$/.test(scope))),
    )
  );
}
export const auditSchema = z.object({
  id: z.string(),
  at: z.number(),
  actor: z.string(),
  target: z.string(),
  action: z.enum(["create", "update", "revoke-sessions"]),
  before: principalSchema.nullable(),
  after: principalSchema,
});
export type AccessAudit = z.infer<typeof auditSchema>;
export const accessViewSchema = z.object({
  policy: policySchema,
  audit: z.array(auditSchema),
});
