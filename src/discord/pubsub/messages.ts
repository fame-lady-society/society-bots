import type {
  APIInteraction,
  RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";

export type TMessageQueue<Interaction extends APIInteraction> =
  | IDeferredInteraction<"defer", Interaction>
  | IChannelMessage;

export interface IChannelMessage {
  type: "discord:channelMessage";
  channelId: string;
  message: RESTPostAPIChannelMessageJSONBody;
}

export interface IDeferredInteraction<
  Type extends string,
  Interaction extends APIInteraction
> {
  type: Type;
  interaction: Interaction;
  context?: string;
}

export function createDeferredInteractionMessage<
  Interaction extends APIInteraction
>(
  interaction: Interaction,
  context?: string
): IDeferredInteraction<"defer", Interaction> {
  return {
    type: "defer",
    interaction,
    context,
  };
}
