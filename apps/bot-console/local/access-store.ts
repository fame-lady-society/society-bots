import type { AccessStore } from "../server/access";
import type { Policy, AccessAudit } from "../src/access-contracts";
export const localOwner = {
  id: "discord:931691901592145930",
  kind: "human" as const,
  name: "Flick",
  enabled: true,
  sessionVersion: 0,
  grants: [{ role: "owner" as const, scope: "*" }],
};
export function memoryAccess(
  initial: Policy = { version: 0, principals: [structuredClone(localOwner)] },
) {
  let policy = structuredClone(initial);
  const events: AccessAudit[] = [];
  const store: AccessStore = {
    async read() {
      return structuredClone(policy);
    },
    async write(old, next, audit) {
      if (old.version !== policy.version) return false;
      policy = structuredClone(next);
      events.unshift(structuredClone(audit));
      return true;
    },
    async audit() {
      return structuredClone(events.slice(0, 50));
    },
  };
  return {
    store,
    set: (p: Policy) => {
      policy = structuredClone(p);
    },
  };
}
