import { NotificationType, isNotificationType } from "@/types.ts";
import { createLogger } from "@/utils/logging.js";
import {
  APIApplicationCommandInteraction,
  ApplicationCommandOptionType,
} from "discord-api-types/v10";

export const logger = createLogger({
  name: "discord/commands",
}).child({
  command: "fame",
});

export class OptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptionsError";
  }
}

export interface IRegisterOptions {
  type: "register";
  guildId: string;
  channelId: string;
  addNotification?: NotificationType;
  removeNotification?: NotificationType;
}

export function getOptions(
  interaction: APIApplicationCommandInteraction
): IRegisterOptions {
  const partialOptions: Partial<IRegisterOptions> = {};
  if ("options" in interaction.data === false || !interaction.data.options) {
    throw new OptionsError("Missing options");
  }
  for (const option of interaction.data.options) {
    logger.debug({ option }, "processing option");
    if (
      option.type === ApplicationCommandOptionType.Subcommand &&
      option.name === "announce"
    ) {
      partialOptions.guildId = interaction.guild_id;
      partialOptions.channelId = interaction.channel.id;
      for (const subOptions of option.options ?? []) {
        if ("value" in subOptions) {
          logger.debug({ subOptions }, "processing suboption");
          switch (subOptions.name) {
            case "notification": {
              if (typeof subOptions.value !== "string") {
                throw new OptionsError("Notification must be a string");
              }
              if (!isNotificationType(subOptions.value)) {
                throw new OptionsError("Invalid notification type");
              }
              partialOptions.addNotification = subOptions.value;
              break;
            }
          }
        }
      }
    } else if (
      option.type === ApplicationCommandOptionType.Subcommand &&
      option.name === "silence"
    ) {
      partialOptions.guildId = interaction.guild_id;
      partialOptions.channelId = interaction.channel.id;
      for (const subOptions of option.options ?? []) {
        if ("value" in subOptions) {
          switch (subOptions.name) {
            case "notification": {
              logger.debug({ subOptions }, "processing notification");
              if (typeof subOptions.value !== "string") {
                throw new OptionsError("Notification must be a string");
              }
              if (!isNotificationType(subOptions.value)) {
                throw new OptionsError("Invalid notification type");
              }
              partialOptions.removeNotification = subOptions.value;
              break;
            }
          }
        }
      }
    }
    if (
      typeof partialOptions.channelId === "undefined" ||
      typeof partialOptions.guildId === "undefined"
    ) {
      logger.warn({ partialOptions }, "missing subcommand group");
      throw new OptionsError("Missing subcommand group");
    }
    return partialOptions as IRegisterOptions;
  }
  throw new OptionsError("Missing subcommand group");
}
