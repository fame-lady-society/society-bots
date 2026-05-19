import type { APIGatewayRequestSimpleAuthorizerHandlerV2 } from "aws-lambda";
import { poolStateRequestAuthorized } from "../auth.ts";

function serviceToken(): string {
  const token = process.env.FAME_POOL_STATE_SERVICE_TOKEN;
  if (!token || token.trim().length === 0) {
    throw new Error("FAME_POOL_STATE_SERVICE_TOKEN is not defined");
  }
  return token;
}

export const handler: APIGatewayRequestSimpleAuthorizerHandlerV2 = async (
  event,
) => ({
  isAuthorized: poolStateRequestAuthorized(event.headers ?? {}, serviceToken()),
});
