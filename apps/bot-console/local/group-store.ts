import { GroupConflict, type GroupStore } from "../server/telegram-groups";
import type { Invite, TelegramGroup } from "../src/telegram-groups-contracts";
// Rehearsal/test storage only. No connection to AWS or Telegram.
export function memoryGroupStore() {
  const groups = new Map<string, TelegramGroup>();
  const invites = new Map<string, Invite>();
  const limits = new Map<string, number>();
  const ignored = new Set<string>();
  const audit: TelegramGroup[] = [];
  const same = (a: TelegramGroup | undefined, b: TelegramGroup | undefined) =>
    JSON.stringify(a) === JSON.stringify(b);
  const store: GroupStore = {
    async list() {
      return [...groups.values()].map((v) => ({ ...v }));
    },
    async get(id) {
      const v = groups.get(id);
      return v && { ...v };
    },
    async invite(id) {
      const v = invites.get(id);
      return v && { ...v };
    },
    async issue(invite) {
      if (invites.has(invite.id)) return false;
      invites.set(invite.id, { ...invite });
      return true;
    },
    async revoke(id) {
      const i = invites.get(id);
      if (!i || i.state !== "available")
        throw new GroupConflict("Code is no longer available.");
      i.state = "revoked";
    },
    async rate(key, max, now) {
      const k = `${key}#${Math.floor(now / 60)}`,
        n = limits.get(k) ?? 0;
      if (n >= max) return false;
      limits.set(k, n + 1);
      return true;
    },
    async redeem(id, group, previous, now) {
      const i = invites.get(id);
      if (
        !i ||
        i.state !== "available" ||
        i.expires <= now ||
        !same(groups.get(group.id), previous)
      )
        return false;
      i.state = "used";
      i.chatId = group.id;
      groups.set(group.id, { ...group });
      audit.push({ ...group });
      return true;
    },
    async decide(previous, next) {
      if (!same(groups.get(previous.id), previous))
        throw new GroupConflict("Group changed. Refresh and try again.");
      groups.set(next.id, { ...next });
      audit.push({ ...next });
    },
    async ignore(chatId, messageId) {
      ignored.add(`${chatId}/${messageId}`);
    },
    async ignored(chatId, messageId) {
      return ignored.has(`${chatId}/${messageId}`);
    },
  };
  return { store, groups, invites, audit };
}
