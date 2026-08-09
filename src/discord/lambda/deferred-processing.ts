import type { SQSEvent, SQSBatchResponse } from "aws-lambda";
import type { APIInteractionResponseCallbackData, RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { InteractionType } from "discord-api-types/v10";
import type { TMessageQueue } from "../pubsub/messages.ts";
import type { InferredApplicationCommandType } from "../types.ts";

export type DeferredDependencies = {
  parseMessage(message: string): TMessageQueue<InferredApplicationCommandType>;
  commandHandler(interaction: InferredApplicationCommandType): Promise<APIInteractionResponseCallbackData>;
  messageHandler(channelId: string, message: RESTPostAPIChannelMessageJSONBody): Promise<unknown>;
  sendInteraction(token: string, message: APIInteractionResponseCallbackData): Promise<unknown>;
  onError(error: unknown): void;
};

export async function processDeferredEvent(event: SQSEvent, dependencies: DeferredDependencies): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const { Message: message } = JSON.parse(record.body);
      const payload = dependencies.parseMessage(message);
      switch (payload.type) {
        case "defer": {
          const { interaction } = payload;
          if (interaction.type !== InteractionType.ApplicationCommand) {
            throw new Error(`Unknown interaction type ${interaction.type}`);
          }
          const response = await dependencies.commandHandler(interaction);
          await dependencies.sendInteraction(interaction.token, response);
          break;
        }
        case "discord:channelMessage":
          await dependencies.messageHandler(payload.channelId, payload.message);
          break;
      }
    } catch (error: unknown) {
      dependencies.onError(error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
