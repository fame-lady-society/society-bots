import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
// import { AlchemyWebhooks } from "./alchemy-webhook.js";
import { ImageLambdas } from "./image-lambdas.js";
import { ImageDistribution } from "./image-distribution.js";
import { Certificates } from "./certificates.js";
import { EventLambdas } from "./events-lambdas.js";

export class DeployInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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

    new EventLambdas(this, "EventLambdas", {
      baseRpcsJson: process.env.BASE_RPCS_JSON!,
      sepoliaRpcsJson: process.env.SEPOLIA_RPCS_JSON!,
      mainnetRpcsJson: process.env.MAINNET_RPCS_JSON!,
      domain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!),
      discordChannelId: process.env.DISCORD_CHANNEL_ID!,
      discordAppId: process.env.DISCORD_APP_ID!,
      discordBotToken: process.env.DISCORD_BOT_TOKEN!,
      discordPublicKey: process.env.DISCORD_PUBLIC_KEY!,
    });
  }
}

export class DeployCertStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new Certificates(this, "Certificates", {
      domains: [JSON.parse(process.env.IMAGE_BASE_HOST_JSON!).join(".")],
      hostedZoneDomain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!).pop(),
    });
  }
}
