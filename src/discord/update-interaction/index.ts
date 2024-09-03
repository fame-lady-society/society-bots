import type {
  APIInteraction,
  APIInteractionResponseDeferredChannelMessageWithSource,
} from "discord-api-types/v10";
import { InteractionResponseType } from "discord-api-types/v10";
import { createSNS } from "../pubsub/sns.ts";
import { createLogger } from "@/utils/logging.ts";
import { deferredMessageTopicArn } from "../config.ts";
import {
  TMessageQueue,
  createDeferredInteractionMessage,
} from "../pubsub/messages.ts";

const logger = createLogger({
  name: "discord/update-interaction",
});

export async function createDeferredInteraction(
  interaction: APIInteraction,
  context?: string
) {
  const sns = createSNS();
  const { MessageId } = await sns.publish({
    Message: JSON.stringify(
      createDeferredInteractionMessage(interaction, context)
    ),
    TopicArn: deferredMessageTopicArn.get(),
  });
  return MessageId;
}

export function parseMessage<Type extends APIInteraction>(message: string) {
  const payload = JSON.parse(message);
  return payload as TMessageQueue<Type>;
}

export function deferredMessage(): APIInteractionResponseDeferredChannelMessageWithSource {
  return {
    type: InteractionResponseType.DeferredChannelMessageWithSource,
  };
}
