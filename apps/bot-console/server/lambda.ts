import { accessStore } from "./access-store";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { dynamoGroupStore } from "./telegram-groups-store";
import { groupService, GroupConflict } from "./telegram-groups";
import { handle } from "hono/aws-lambda";
import * as oauth from "oauth4webapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { createApp, identitySchema, type Store } from "./app";
import { readTelegramConfig, queueDepth } from "./telegram-runtime";
import { listMessages, lastCaptured } from "./telegram-store";
const configSchema = z.object({
  clientId: z.string().regex(/^\d{17,20}$/),
  clientSecret: z.string().min(1),
});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const groups = dynamoGroupStore();
const lambda = new LambdaClient({});
const onboarding = groupService(groups, async (chatId) => {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.TELEGRAM_VERIFIER_ARN!,
      Payload: Buffer.from(JSON.stringify({ chatId })),
    }),
  );
  const result = z
    .object({ ok: z.literal(true), name: z.string() })
    .safeParse(
      JSON.parse(Buffer.from(response.Payload ?? []).toString() || "{}"),
    );
  if (response.FunctionError || !result.success)
    throw new GroupConflict(
      "Could not verify the bot is a group administrator. Check its permissions and try again.",
    );
  return { name: result.data.name };
});
const recordSchema = z.object({
  expires: z.number(),
  absoluteExpires: z.number().optional(),
  sessionVersion: z.number().optional(),
  userId: z.string().optional(),
  name: z.string().optional(),
});
const table = process.env.SESSION_TABLE!;
const store: Store = {
  async renew(key, now, expires) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: key },
          UpdateExpression: "SET expires = :expires",
          ConditionExpression:
            "attribute_exists(pk) AND expires > :now AND absoluteExpires >= :expires AND absoluteExpires > :now",
          ExpressionAttributeValues: { ":now": now, ":expires": expires },
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return false;
      throw error;
    }
  },
  async put(key, value) {
    await ddb.send(
      new PutCommand({ TableName: table, Item: { pk: key, ...value } }),
    );
  },
  async get(key) {
    const r = await ddb.send(
      new GetCommand({
        TableName: table,
        Key: { pk: key },
        ConsistentRead: true,
      }),
    );
    return r.Item ? recordSchema.parse(r.Item) : undefined;
  },
  async take(key) {
    const r = await ddb.send(
      new DeleteCommand({
        TableName: table,
        Key: { pk: key },
        ReturnValues: "ALL_OLD",
      }),
    );
    return r.Attributes ? recordSchema.parse(r.Attributes) : undefined;
  },
};
// OAuth credentials are separate from the authoritative access registry.
export const handler = async (
  event: Parameters<ReturnType<typeof handle>>[0],
  context: Parameters<ReturnType<typeof handle>>[1],
) => {
  try {
    const secret = await secrets.send(
      new GetSecretValueCommand({ SecretId: process.env.AUTH_SECRET_ARN! }),
    );
    const config = configSchema.parse(JSON.parse(secret.SecretString ?? "{}"));
    const origin = "https://bot.fame.support";
    const server: oauth.AuthorizationServer = {
      issuer: "https://discord.com",
      authorization_endpoint: "https://discord.com/oauth2/authorize",
      token_endpoint: "https://discord.com/api/oauth2/token",
    };
    const client: oauth.Client = { client_id: config.clientId };
    const redirectUri = `${origin}/api/auth/callback`;
    const app = createApp({
      origin,
      access: accessStore(),
      store,
      groups: onboarding,
      telegram: {
        async status() {
          const c = await readTelegramConfig();
          const [queued, failed] = await Promise.all([
            queueDepth(process.env.INGEST_QUEUE_URL!),
            queueDepth(process.env.DEAD_LETTER_QUEUE_URL!),
          ]);
          return {
            botId: c.botId,
            username: c.username,
            chats: await Promise.all(
              (await groups.list())
                .filter((g) => g.hasHistory)
                .map(async (chat) => ({
                  ...chat,
                  lastCapturedAt: await lastCaptured(chat.id),
                })),
            ),
            registeredAt: c.registeredAt ?? null,
            queued,
            failed,
          };
        },
        async messages(chatId, cursor, messageId) {
          const group = await groups.get(chatId);
          if (!group?.hasHistory) throw new Error("Chat not configured");
          return listMessages(chatId, cursor, messageId);
        },
      },
      oauth: {
        url: (state) => {
          const url = new URL(server.authorization_endpoint!);
          url.search = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "identify",
            state,
            prompt: "consent",
          }).toString();
          return url.toString();
        },
        async identity(code) {
          // State was browser-bound and atomically consumed by createApp before this exchange.
          const params = oauth.validateAuthResponse(
            server,
            client,
            new URLSearchParams({ code }),
            oauth.expectNoState,
          );
          const tokenResponse = await oauth.authorizationCodeGrantRequest(
            server,
            client,
            oauth.ClientSecretPost(config.clientSecret),
            params,
            redirectUri,
            oauth.nopkce,
            { signal: AbortSignal.timeout(10_000) },
          );
          const tokens = await oauth.processAuthorizationCodeResponse(
            server,
            client,
            tokenResponse,
          );
          const response = await fetch(
            "https://discord.com/api/v10/users/@me",
            {
              headers: { Authorization: `Bearer ${tokens.access_token}` },
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!response.ok) throw new Error("Identity provider unavailable");
          return identitySchema.parse(await response.json());
        },
      },
    });
    return await handle(app)(event, context);
  } catch {
    // Never log OAuth codes, tokens, cookies, or secret-bearing errors.
    return {
      statusCode: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ error: "Authentication service unavailable." }),
    };
  }
};
