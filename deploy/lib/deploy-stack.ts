import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
// import { AlchemyWebhooks } from "./alchemy-webhook.js";
import { ImageLambdas } from "./image-lambdas.js";
import { ImageDistribution } from "./image-distribution.js";
import { Certificates } from "./certificates.js";

export class DeployInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // new AlchemyWebhooks(this, "AlchemyWebhooks", {
    //   alchemyWebhookSigningKey: process.env.ALCHEMY_WEBHOOK_SIGNING_KEY!,
    //   baseRpcsJson: process.env.BASE_RPCS_JSON!,
    //   mainnetRpcsJson: process.env.MAINNET_RPCS_JSON!,
    //   sepoliaRpcsJson: process.env.SEPOLIA_RPCS_JSON!,
    //   telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
    //   telegramChatId: process.env.TELEGRAM_CHAT_ID!,
    // });

    const { httpApi: imageHttpApi, assetStorageBucket } = new ImageLambdas(
      this,
      "ImageLambdas",
      {
        baseRpcsJson: process.env.BASE_RPCS_JSON!,
        domain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!),
        corsAllowedOriginsJson: process.env.IMAGE_CORS_ALLOWED_ORIGINS_JSON!,
      }
    );

    new ImageDistribution(this, "ImageDistribution", {
      domain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!),
      imageHttpApi,
      assetStorageBucket,
    });
  }
}

export class DeployCertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new Certificates(this, "Certificates", {
      domains: [JSON.parse(process.env.IMAGE_BASE_HOST_JSON!).join(".")],
      hostedZoneDomain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!)[1],
    });
  }
}
