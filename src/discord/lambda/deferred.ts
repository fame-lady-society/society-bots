import type { SQSHandler } from "aws-lambda";
import { parseMessage } from "../update-interaction/index.ts";
import { createLogger } from "@/utils/logging.js";
import { handle as commandHandler } from "../update-interaction/commands.ts";
import { handle as messageHandler } from "../commands/message/send.ts";
import { sendInteraction } from "../service/discord.ts";
import { processDeferredEvent } from "./deferred-processing.ts";

import "../commands/deferred.js";
const logger = createLogger({
  name: "discord/lambda",
});

export const handler: SQSHandler = async (event) => processDeferredEvent(event, {
  parseMessage,
  commandHandler,
  messageHandler,
  sendInteraction,
  onError: (error) => logger.error(error, "Failed to process message"),
});
