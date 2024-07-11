import { SNS } from "@aws-sdk/client-sns";
import type { RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { IChannelMessage } from "./messages";

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
  await sns.publish({
    Message: JSON.stringify(messageEvent),
    TopicArn: topicArn,
  });
}
