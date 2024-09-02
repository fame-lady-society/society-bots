import { SQSHandler } from "aws-lambda";
import { parseMessage } from "../update-interaction";
import { createLogger } from "@/utils/logging.js";
import { handle as commandHandler } from "../update-interaction/commands";
import { handle as messageHandler } from "../commands/message/send";
import { InteractionType } from "discord-api-types/v10";
import { sendInteraction } from "../service/discord";

import "../commands/deferred.js";
import { InferredApplicationCommandType } from "../types";

const logger = createLogger({
  name: "discord/lambda",
});

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    try {
      const { body } = record;
      const { Message: message } = JSON.parse(body);
      const payload = parseMessage<InferredApplicationCommandType>(message);
      logger.debug({ payload }, "Received deferred interaction");
      switch (payload.type) {
        case "defer": {
          const { interaction } = payload;
          switch (interaction.type) {
            case InteractionType.ApplicationCommand:
              const message = await commandHandler(interaction);
              const { token } = interaction;
              logger.debug({ message }, "Sending interaction");
              await sendInteraction(token, message);
              return;
            default:
              logger.warn({ interaction }, "Unknown interaction type");
              throw new Error(`Unknown interaction type ${interaction.type}`);
          }
          break;
        }
        case "discord:channelMessage": {
          const { channelId, message } = payload;
          logger.debug({ channelId, message }, "Sending channel message");
          await messageHandler(channelId, message);
        }
      }
    } catch (error: any) {
      logger.error(error, "Failed to process message");
    }
  }
};
