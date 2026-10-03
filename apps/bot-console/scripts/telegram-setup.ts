/** Operator-only setup. Never bundled or invoked by CI/application requests. */
import { execFileSync } from "node:child_process";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { telegramConfigSchema } from "../server/telegram";
import { z } from "zod";
const url = "https://bot.fame.support/api/telegram/webhook";
const secretId = "bot-console/telegram-receiver";
async function main() {
  const [mode, extra] = process.argv.slice(2);
  if (
    !["inspect", "register", "pause", "provision-verifier"].includes(mode) ||
    extra
  )
    throw new Error(
      "Use inspect, register, pause, or provision-verifier (group connections are managed in the console)",
    );
  const identity = JSON.parse(
    execFileSync("aws", ["sts", "get-caller-identity", "--output", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (identity.Account !== "590183914614") throw new Error("Wrong AWS account");
  const token = execFileSync(
    "doppler",
    [
      "secrets",
      "get",
      "TELEGRAM_BOT_TOKEN",
      "--project",
      "fls-society-agents",
      "--config",
      "prd-controller",
      "--plain",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const telegram = async (
    method: string,
    body: Record<string, unknown> = {},
  ) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await r.json()) as { ok: boolean; result: unknown };
    if (!r.ok || !data.ok) throw new Error("Telegram request failed");
    return data.result;
  };
  const me = z
    .object({ id: z.number(), username: z.literal("famesocietybot") })
    .parse(await telegram("getMe"));
  if (me.id !== 7393738833) throw new Error("Wrong bot identity");
  const secrets = new SecretsManagerClient({ region: "us-east-1" });
  if (mode === "provision-verifier") {
    const SecretString = JSON.stringify({ token });
    try {
      await secrets.send(
        new CreateSecretCommand({
          Name: "bot-console/telegram-verifier",
          SecretString,
        }),
      );
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "ResourceExistsException")
        throw e;
      await secrets.send(
        new PutSecretValueCommand({
          SecretId: "bot-console/telegram-verifier",
          SecretString,
        }),
      );
    }
    console.log({ verifierCredentialProvisioned: true });
    return;
  }
  const webhook = z
    .object({ url: z.string(), pending_update_count: z.number() })
    .parse(await telegram("getWebhookInfo"));
  console.log({
    username: me.username,
    webhookConfigured: !!webhook.url,
    webhookMatchesConsole: webhook.url === url,
    pendingUpdates: webhook.pending_update_count,
  });
  if (mode === "inspect") return;
  if (webhook.url && webhook.url !== url)
    throw new Error("Existing webhook belongs to another service; stopping");
  if (mode === "pause") {
    await telegram("deleteWebhook", { drop_pending_updates: false });
    const stopped = z
      .object({ url: z.literal("") })
      .parse(await telegram("getWebhookInfo"));
    if (!stopped) throw new Error("Webhook pause failed");
    console.log({ paused: true, pendingUpdatesPreserved: true });
    return;
  }
  const current = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const config = telegramConfigSchema.parse(
    JSON.parse(current.SecretString ?? "{}"),
  );
  await telegram("setWebhook", {
    url,
    secret_token: config.webhookSecret,
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: false,
    max_connections: 5,
  });
  const checked = z
    .object({ url: z.literal(url) })
    .parse(await telegram("getWebhookInfo"));
  if (!checked) throw new Error("Webhook verification failed");
  await secrets.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      SecretString: JSON.stringify({
        ...config,
        registeredAt: new Date().toISOString(),
      }),
    }),
  );
  console.log({ registered: true });
}
main().catch(() => {
  console.error(
    "Telegram setup failed. No credential-bearing details logged. Inspect bot identity, existing webhook, AWS account, group membership, and receiver configuration before retrying.",
  );
  process.exitCode = 1;
});
