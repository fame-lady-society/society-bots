import { SNS } from "@aws-sdk/client-sns";
import type { RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { IChannelMessage } from "./messages.ts";
import { createLogger } from "@/utils/logging.ts";

const logger = createLogger("discord:pubsub:send");

export async function sendDiscordMessage({
  topicArn,
  channelId,
  message,
  sns,
}: {
  topicArn: string;
  channelId: string;
  message: RESTPostAPIChannelMessageJSONBody;
  sns: SNS;
}) {
  const messageEvent: IChannelMessage = {
    type: "discord:channelMessage",
    channelId,
    message,
  };

  logger.info("Sending discord message", {
    topicArn,
    channelId,
    message,
  });

  await sns.publish({
    Message: JSON.stringify(messageEvent),
    TopicArn: topicArn,
  });
}
