import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Invite, TelegramGroup } from "../src/telegram-groups-contracts";
// Use Crockford's 32-symbol alphabet, excluding I, L, O and U.
export const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const hashCode = (code: string) =>
  createHash("sha256").update(code).digest("hex");
export function normalizeCode(value: string): string | null {
  const compact = value
    .toUpperCase()
    .replace(/^([A-Z0-9]{4})-([A-Z0-9]{4})$/, "$1$2");
  return compact.length === 8 &&
    [...compact].every((c) => codeAlphabet.includes(c))
    ? compact
    : null;
}
export function generateCode() {
  const raw = [...randomBytes(8)].map((b) => codeAlphabet[b & 31]).join("");
  return { id: hashCode(raw), code: `${raw.slice(0, 4)}-${raw.slice(4)}` };
}
export class GroupConflict extends Error {}
export interface GroupStore {
  ignore(chatId: string, messageId: string, expires: number): Promise<void>;
  ignored(chatId: string, messageId: string): Promise<boolean>;
  list(): Promise<TelegramGroup[]>;
  get(id: string): Promise<TelegramGroup | undefined>;
  invite(id: string): Promise<Invite | undefined>;
  issue(invite: Invite): Promise<boolean>;
  revoke(id: string, actor: string): Promise<void>;
  rate(key: string, limit: number, now: number): Promise<boolean>;
  redeem(
    id: string,
    group: TelegramGroup,
    previous: TelegramGroup | undefined,
    now: number,
  ): Promise<boolean>;
  decide(previous: TelegramGroup, next: TelegramGroup): Promise<void>;
}
export function groupService(
  store: GroupStore,
  verify: (id: string) => Promise<{ name: string }>,
  now = () => Math.floor(Date.now() / 1000),
) {
  return {
    list: () => store.list(),
    async issue(actor: string) {
      if (!(await store.rate(`issue#${actor}`, 10, now())))
        throw new GroupConflict("Too many codes. Try again in a minute.");
      for (let attempt = 0; attempt < 3; attempt++) {
        const { id, code } = generateCode();
        const invite: Invite = {
          id,
          expires: now() + 600,
          state: "available",
          createdBy: actor,
        };
        if (await store.issue(invite))
          return { ...invite, code, command: `/start@famesocietybot ${code}` };
      }
      throw new Error("Code generation unavailable");
    },
    invite: (id: string) => store.invite(id),
    revoke: (id: string, actor: string) => store.revoke(id, actor),
    async redeem(code: string, chatId: string, name: string, sender: string) {
      const normalized = normalizeCode(code);
      if (!normalized) return;
      const time = now();
      // Bound both targeted and distributed guesses across all groups.
      if (
        !(await store.rate(`redeem#${chatId}`, 5, time)) ||
        !(await store.rate("redeem#global", 100, time))
      )
        return;
      const id = hashCode(normalized);
      const invite = await store.invite(id);
      if (!invite || invite.state !== "available" || invite.expires <= time)
        return;
      const previous = await store.get(chatId);
      if (previous && ["pending", "active"].includes(previous.state)) return;
      await store.redeem(
        id,
        {
          id: chatId,
          name,
          state: "pending",
          requestId: randomUUID(),
          requestedBy: sender,
          createdBy: invite.createdBy,
          requestedAt: time,
          updatedAt: time,
          updatedBy: invite.createdBy,
          hasHistory: previous?.hasHistory ?? false,
        },
        previous,
        time,
      );
    },
    async decide(
      id: string,
      requestId: string,
      action: "approve" | "reject" | "disconnect",
      actor: string,
    ) {
      const previous = await store.get(id);
      if (
        !previous ||
        previous.requestId !== requestId ||
        previous.state !== (action === "disconnect" ? "active" : "pending")
      )
        throw new GroupConflict("Group changed. Refresh and try again.");
      const checked = action === "approve" ? await verify(id) : undefined;
      const time = now();
      const next: TelegramGroup = {
        ...previous,
        updatedAt: time,
        updatedBy: actor,
        state:
          action === "approve"
            ? "active"
            : action === "reject"
              ? "rejected"
              : "disconnected",
        ...(checked
          ? {
              name: checked.name,
              associationId: randomUUID(),
              activatedAt: time + 1,
              hasHistory: true,
            }
          : {}),
      };
      await store.decide(previous, next);
      return next;
    },
  };
}
export type GroupService = ReturnType<typeof groupService>;
