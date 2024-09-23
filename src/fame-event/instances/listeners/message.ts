import { SNS } from "@aws-sdk/client-sns";
import { IChannelMessage, SupportedChainId } from "./types.ts";
import { EVENT_LOG_TOPIC_ARN } from "./config.ts";

export async function sendFameEventMessage({
  topicArn = EVENT_LOG_TOPIC_ARN,
  chainId,
  transactionHash,
  sns,
}: {
  topicArn?: string;
  chainId: SupportedChainId;
  transactionHash: `0x${string}`;
  sns: SNS;
}) {
  const messageEvent: IChannelMessage = {
    type: "fame:event:swap",
    chainId,
    transactionHash,
  };
  await sns.publish({
    Message: JSON.stringify(messageEvent),
    TopicArn: topicArn,
  });
}
