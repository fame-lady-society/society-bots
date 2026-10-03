import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  policySchema,
  principalSchema,
  permits,
  type Policy,
  type AccessAudit,
} from "../src/access-contracts";
export interface AccessStore {
  read(): Promise<Policy>;
  write(previous: Policy, next: Policy, audit: AccessAudit): Promise<boolean>;
  audit(): Promise<AccessAudit[]>;
}
export class AccessConflict extends Error {}
export const editSchema = z
  .object({
    version: z.number().int().nonnegative(),
    principal: z
      .object({
        id: principalSchema.shape.id,
        kind: principalSchema.shape.kind,
        name: principalSchema.shape.name,
        enabled: principalSchema.shape.enabled,
        grants: principalSchema.shape.grants,
      })
      .strict(),
    revokeSessions: z.boolean(),
  })
  .strict();
export async function editAccess(
  store: AccessStore,
  actor: string,
  input: unknown,
  now: number,
) {
  const body = editSchema.parse(input);
  const old = await store.read();
  const operator = old.principals.find((p) => p.id === actor);
  if (!operator || !permits(operator, "access.manage"))
    throw new AccessConflict("Owner access changed. Refresh and try again.");
  if (old.version !== body.version)
    throw new AccessConflict("Access changed. Refresh before saving.");
  const previous = old.principals.find((p) => p.id === body.principal.id);
  const nextPrincipal = principalSchema.parse({
    ...body.principal,
    sessionVersion:
      (previous?.sessionVersion ?? 0) +
      (body.revokeSessions || (previous?.enabled && !body.principal.enabled)
        ? 1
        : 0),
  });
  const next = policySchema.parse({
    version: old.version + 1,
    principals: [
      ...old.principals.filter((p) => p.id !== nextPrincipal.id),
      nextPrincipal,
    ],
  });
  const audit: AccessAudit = {
    id: randomUUID(),
    at: now,
    actor,
    target: nextPrincipal.id,
    action: !previous
      ? "create"
      : body.revokeSessions
        ? "revoke-sessions"
        : "update",
    before: previous ?? null,
    after: nextPrincipal,
  };
  if (!(await store.write(old, next, audit)))
    throw new AccessConflict("Access changed. Refresh before saving.");
  return next;
}
