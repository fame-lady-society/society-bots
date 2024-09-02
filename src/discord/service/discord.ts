import axios, { AxiosError, AxiosInstance } from "axios";
import { createLogger } from "@/utils/logging.js";
import {
  APIInteractionResponseCallbackData,
  RESTPostAPIChannelMessageJSONBody,
} from "discord-api-types/v10";
import { discordBotToken } from "../config";

class RateLimitHandler {
  private axiosInstance: AxiosInstance;

  constructor() {
    this.axiosInstance = axios.create();

    this.axiosInstance.interceptors.response.use(
      (response) => response,
      async (error) => {
        const { config, response } = error;
        if (response.status === 429) {
          // Extract rate limit headers
          const remaining = Number(response.headers["x-ratelimit-remaining"]);
          const reset = Number(response.headers["x-ratelimit-reset"]);
          const resetAfter = Number(
            response.headers["x-ratelimit-reset-after"]
          );

          if (remaining === 0) {
            // Calculate time to wait before retrying
            const currentTime = Math.floor(Date.now() / 1000);
            const waitTime = (reset || currentTime + resetAfter) - currentTime;

            // Wait and retry request
            await new Promise((resolve) =>
              setTimeout(resolve, waitTime * 1000)
            );
            return this.axiosInstance(config);
          }
        }
        return Promise.reject(error);
      }
    );
  }

  get instance(): AxiosInstance {
    return this.axiosInstance;
  }
}
const client = new RateLimitHandler();

const logger = createLogger({ name: "discord/service" });

export function getApplicationId() {
  if (!process.env.DISCORD_APPLICATION_ID) {
    logger.error("DISCORD_APPLICATION_ID not set");
    throw new Error("DISCORD_APPLICATION_ID not set");
  }
  return process.env.DISCORD_APPLICATION_ID;
}

export async function sendInteraction(
  token: string,
  data: APIInteractionResponseCallbackData
) {
  try {
    const response = await client.instance.patch(
      `https://discord.com/api/v10/webhooks/${getApplicationId()}/${token}/messages/@original`,
      data
    );
    return response.data;
  } catch (error: any) {
    if (error instanceof AxiosError && error.response?.data) {
      logger.error({ err: error }, "Error sending interaction");
    }
    throw error;
  }
}

export async function sendChannelMessage(
  channelId: string,
  message: RESTPostAPIChannelMessageJSONBody
) {
  try {
    const response = await client.instance.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      message,
      {
        headers: {
          Authorization: `Bot ${discordBotToken.get()}`,
        },
      }
    );
    return response.data;
  } catch (error: any) {
    if (error instanceof AxiosError && error.response?.data) {
      logger.error({ err: error }, "Error sending channel message");
    }
    throw error;
  }
}
