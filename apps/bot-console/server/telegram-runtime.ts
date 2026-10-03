import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SQSClient,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { handle } from "hono/aws-lambda";
import {
  telegramConfigSchema,
  capturedMessageSchema,
  webhookApp,
} from "./telegram";
import { saveMessage } from "./telegram-store";
const secrets = new SecretsManagerClient({});
const sqs = new SQSClient({});
export async function readTelegramConfig() {
  const s = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.TELEGRAM_CONFIG_ARN! }),
  );
  return telegramConfigSchema.parse(JSON.parse(s.SecretString ?? "{}"));
}
export async function queueDepth(url: string) {
  const r = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );
  return (
    Number(r.Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}
export const webhook = async (
  event: Parameters<ReturnType<typeof handle>>[0],
  context: Parameters<ReturnType<typeof handle>>[1],
) => {
  try {
    const config = await readTelegramConfig();
    return await handle(
      webhookApp(config, async (item) => {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: process.env.INGEST_QUEUE_URL!,
            MessageBody: JSON.stringify(item),
          }),
        );
      }),
    )(event, context);
  } catch {
    return { statusCode: 503, body: "Temporarily unavailable" };
  }
};
export const worker = async (event: {
  Records: { messageId: string; body: string }[];
}) => {
  const config = await readTelegramConfig();
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const item = capturedMessageSchema.parse(JSON.parse(record.body));
      if (
        config.chats.some((c) => c.id === item.chatId) &&
        item.expires > Math.floor(Date.now() / 1000)
      )
        await saveMessage(item);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
