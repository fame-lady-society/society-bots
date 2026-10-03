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
import { dynamoGroupStore } from "./telegram-groups-store";
import { groupService } from "./telegram-groups";
import { saveMessage } from "./telegram-store";
const secrets = new SecretsManagerClient({});
const sqs = new SQSClient({});
const groups = dynamoGroupStore();
const onboarding = groupService(groups, async () => {
  throw new Error("Approval unavailable in receiver");
});
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
      webhookApp(
        config,
        async (item) => {
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: process.env.INGEST_QUEUE_URL!,
              MessageBody: JSON.stringify(item),
            }),
          );
        },
        {
          get: groups.get,
          redeem: onboarding.redeem,
          ignore: groups.ignore,
          ignored: groups.ignored,
        },
      ),
    )(event, context);
  } catch {
    return { statusCode: 503, body: "Temporarily unavailable" };
  }
};
export const worker = async (event: {
  Records: { messageId: string; body: string }[];
}) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const raw: unknown = JSON.parse(record.body);
      const item = capturedMessageSchema.parse(raw);
      const associationId = (raw as { associationId?: string }).associationId;
      const group = await groups.get(item.chatId);
      if (
        group?.state === "active" &&
        !!associationId &&
        group.associationId === associationId &&
        item.sentAt >= group.activatedAt! &&
        !(await groups.ignored(item.chatId, item.messageId)) &&
        item.expires > Math.floor(Date.now() / 1000)
      )
        await saveMessage(item, associationId);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
