import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { sign } from "tweetnacl";
import { createLogger } from "@/utils/logging.js";
import { InferredApplicationCommandType } from "../types.ts";
import { handle as pingHandler } from "../interactions/ping.ts";
import { handle as commandHandler } from "../interactions/command.ts";
import type {
  APIInteraction,
  APIInteractionResponse,
  APIInteractionResponseUpdateMessage,
} from "discord-api-types/v10";
import {
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import "../commands/immediate.ts";
import { publicKey } from "../config.ts";

/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 *
 */
const logger = createLogger({
  name: "discord/lambda/discord",
});

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  try {
    logger.info({ event }, "Received event");
    const PUBLIC_KEY = publicKey.get();
    if (!PUBLIC_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "PUBLIC_KEY is not set",
        }),
      };
    }

    if (!event.headers) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "headers is not set",
        }),
      };
    }
    const signature = event.headers["x-signature-ed25519"];
    const timestamp = event.headers["x-signature-timestamp"];

    if (!signature || !timestamp) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "signature or timestamp is not set",
        }),
      };
    }

    const strBody = event.body;
    if (!strBody) {
      throw new Error("Body is not set");
    }

    const isVerified = sign.detached.verify(
      Buffer.from(timestamp + strBody),
      Buffer.from(signature, "hex"),
      Buffer.from(PUBLIC_KEY, "hex")
    );

    if (!isVerified) {
      return {
        statusCode: 401,
        body: JSON.stringify("invalid request signature"),
      };
    }

    const body: APIInteraction = JSON.parse(strBody);
    logger.debug({ body }, "body");

    switch (body.type) {
      case InteractionType.Ping:
        return pingHandler(body);
      case InteractionType.ApplicationCommand:
        // return {
        //   statusCode: 200,
        //   body: JSON.stringify({
        //     type: InteractionResponseType.DeferredChannelMessageWithSource,
        //   } as APIInteractionResponse),
        // };
        const response = await commandHandler(
          body as InferredApplicationCommandType
        );
        logger.info({ response }, "response");
        return response;
      default:
        logger.error({ body }, "unknown interaction type");
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "unknown interaction type",
          }),
        };
    }
  } catch (e: any) {
    logger.error({
      err: e,
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: e.message,
      }),
    };
  }
};
