import { handle } from "hono/aws-lambda";
import * as oauth from "oauth4webapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { createApp, identitySchema, type Store } from "./app";
const configSchema = z.object({
  clientId: z.string().regex(/^\d{17,20}$/),
  clientSecret: z.string().min(1),
  adminIds: z.array(z.string().regex(/^\d{17,20}$/)).min(1),
});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const recordSchema = z.object({
  expires: z.number(),
  userId: z.string().optional(),
  name: z.string().optional(),
});
const table = process.env.SESSION_TABLE!;
const store: Store = {
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
// Read configuration on each invocation: removing an admin revokes existing sessions.
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
      adminIds: config.adminIds,
      store,
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
