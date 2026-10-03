import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
const secrets = new SecretsManagerClient({});
const chatSchema = z.object({
  id: z.number().int().safe(),
  type: z.enum(["group", "supergroup"]),
  title: z.string().min(1),
});
const membershipSchema = z.object({
  status: z.enum(["administrator", "creator"]),
  user: z.object({ id: z.literal(7393738833), is_bot: z.literal(true) }),
});
export async function verifyGroup(
  chatId: string,
  call: (method: string, args: Record<string, string>) => Promise<unknown>,
) {
  const chat = chatSchema.parse(await call("getChat", { chat_id: chatId }));
  if (String(chat.id) !== chatId) throw new Error("Group identity changed");
  membershipSchema.parse(
    await call("getChatMember", { chat_id: chatId, user_id: "7393738833" }),
  );
  return { name: chat.title };
}
// No generic Telegram proxy: this Lambda only checks one group and bot membership.
export const verify = async (event: unknown) => {
  try {
    const { chatId } = z
      .object({ chatId: z.string().regex(/^-\d+$/) })
      .strict()
      .parse(event);
    const secret = await secrets.send(
      new GetSecretValueCommand({ SecretId: process.env.TELEGRAM_TOKEN_ARN! }),
    );
    const { token } = z
      .object({ token: z.string().regex(/^7393738833:[A-Za-z0-9_-]+$/) })
      .parse(JSON.parse(secret.SecretString ?? "{}"));
    return {
      ok: true,
      ...(await verifyGroup(chatId, async (method, args) => {
        const response = await fetch(
          `https://api.telegram.org/bot${token}/${method}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args),
            signal: AbortSignal.timeout(4000),
          },
        );
        if (!response.ok) throw new Error("Telegram unavailable");
        const result = z
          .object({ ok: z.literal(true), result: z.unknown() })
          .parse(await response.json());
        return result.result;
      })),
    };
  } catch {
    // Never return or log errors containing credential-bearing Telegram URLs.
    return { ok: false };
  }
};
