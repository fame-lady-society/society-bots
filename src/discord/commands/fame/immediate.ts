import {
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import { register } from "../../interactions/command.ts";
import {
  createDeferredInteraction,
  deferredMessage,
} from "../../update-interaction/index.ts";
import { getOptions, logger } from "./common.ts";
import {
  deleteNotification,
  getNotification,
  putNotifications,
} from "@/fame-event/dynamodb/discord-guilds-notifications.ts";

register({
  handler: async (interaction) => {
    if (interaction.data.name !== "fame") {
      return false;
    }

    try {
      logger.info("responding to fame");
      if ("options" in interaction.data === false) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Missing options",
            },
          }),
        };
      }
      const { channelId, guildId, addNotification, removeNotification } =
        getOptions(interaction);
      logger.debug(
        { addNotification, removeNotification, guildId, channelId },
        "got options"
      );
      if (addNotification) {
        // check if already registered
        const registered = await getNotification({
          channelId,
          guildId,
          notification: addNotification,
        });
        logger.debug({ registered }, "got registered");
        if (registered) {
          return {
            statusCode: 200,
            body: JSON.stringify({
              type: InteractionResponseType.ChannelMessageWithSource,
              data: {
                content: "Already registered",
              },
            }),
            headers: {
              "Content-Type": "application/json",
            },
          };
        }
        logger.debug(
          { channelId, guildId, notification: addNotification },
          "putting notification"
        );
        await putNotifications({
          channelId,
          guildId,
          notification: addNotification,
        });

        return {
          statusCode: 200,
          body: JSON.stringify({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Registered",
            },
          }),
          headers: {
            "Content-Type": "application/json",
          },
        };
      } else if (removeNotification) {
        await deleteNotification({
          channelId,
          guildId,
          notification: removeNotification,
        });

        return {
          statusCode: 200,
          body: JSON.stringify({
            type: InteractionResponseType.ChannelMessageWithSource,
            data: {
              content: "Unregistered",
            },
          }),
          headers: {
            "Content-Type": "application/json",
          },
        };
      }
      return {
        statusCode: 200,
        body: JSON.stringify({
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: "No notification provided",
          },
        }),
        headers: {
          "Content-Type": "application/json",
        },
      };
    } catch (error: any) {
      logger.error(`Error: ${error.message}`);
      return {
        statusCode: 200,
        body: JSON.stringify({
          type: InteractionResponseType.ChannelMessageWithSource,
          data: {
            content: `Error: ${error.message}`,
          },
        }),
        headers: {
          "Content-Type": "application/json",
        },
      };
    }
  },
});
