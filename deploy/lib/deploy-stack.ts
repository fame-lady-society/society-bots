import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { AlchemyWebhooks } from "./alchemy-webhook.js";

export class DeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new AlchemyWebhooks(this, "AlchemyWebhooks", {
      alchemyWebhookSigningKey: process.env.ALCHEMY_WEBHOOK_SIGNING_KEY!,
      baseRpcsJson: process.env.BASE_RPCS_JSON!,
      mainnetRpcsJson: process.env.MAINNET_RPCS_JSON!,
      sepoliaRpcsJson: process.env.SEPOLIA_RPCS_JSON!,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
    });
  }
}
