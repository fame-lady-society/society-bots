import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
// import { AlchemyWebhooks } from "./alchemy-webhook.js";
import { ImageLambdas } from "./image-lambdas.js";
import { Distribution } from "./distribution.js";
import { Certificates } from "./certificates.js";
import { EventLambdas } from "./events-lambdas.js";
import { HttpApi } from "./http-api.js";
import { Eliza } from "./eliza.js";

export class DeployInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const { assetStorageBucket, imageMosaicLambda, imageThumbLambda } =
      new ImageLambdas(this, "ImageLambdas", {
        baseRpcsJson: process.env.BASE_RPCS_JSON!,
        domain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!),
        corsAllowedOriginsJson: process.env.IMAGE_CORS_ALLOWED_ORIGINS_JSON!,
      });

    const { notificationLambda } = new EventLambdas(this, "EventLambdas", {
      baseRpcsJson: process.env.BASE_RPCS_JSON!,
      sepoliaRpcsJson: process.env.SEPOLIA_RPCS_JSON!,
      mainnetRpcsJson: process.env.MAINNET_RPCS_JSON!,
      domain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!),
      discordChannelId: process.env.DISCORD_CHANNEL_ID ?? "",
      discordAppId: process.env.DISCORD_APP_ID!,
      discordBotToken: process.env.DISCORD_BOT_TOKEN!,
      discordPublicKey: process.env.DISCORD_PUBLIC_KEY!,
    });

    const { httpApi } = new HttpApi(this, "SocietyBotREST", {
      domain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!),
      imageThumbHandler: imageThumbLambda,
      imageMosaicHandler: imageMosaicLambda,
      discordInteractionHandler: notificationLambda,
    });

    new Distribution(this, "ImageDistribution", {
      domain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!),
      httpApi,
      assetStorageBucket,
    });

    new Eliza(this, "Eliza", {
      fid: Number(process.env.FARCASTER_APP_ID!),
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
