import { register } from "../../interactions/command.ts";
import {
  createDeferredInteraction,
  deferredMessage,
} from "../../update-interaction/index.ts";
import { logger } from "./common.ts";

register({
  handler: async (interaction) => {
    if (interaction.data.name !== "ping") {
      return false;
    }
    logger.info("creating deferred ping");
    const messageId = await createDeferredInteraction(interaction);
    logger.info(
      `Created deferred interaction ${messageId} and acknowledging ping`
    );
    return {
      statusCode: 200,
      body: JSON.stringify(deferredMessage()),
    };
  },
});
