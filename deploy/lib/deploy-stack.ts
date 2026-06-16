import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
// import { AlchemyWebhooks } from "./alchemy-webhook.js";
import { ImageLambdas } from "./image-lambdas.js";
import { Distribution } from "./distribution.js";
import { Certificates } from "./certificates.js";
import { EventLambdas } from "./events-lambdas.js";
import {
  FamePoolState,
  famePoolStateClReplayMaintenanceModeFromEnv,
  famePoolStateClReplayTrustPromotionFromEnv,
} from "./fame-pool-state.js";
import { HttpApi } from "./http-api.js";
import { Eliza } from "./eliza.js";

export class DeployInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const {
      assetStorageBucket,
      fameImageMosaicLambda,
      fameImageThumbLambda,
      flsImageMosaicLambda,
      flsImageThumbLambda,
    } = new ImageLambdas(this, "ImageLambdas", {
      baseRpcsJson: process.env.BASE_RPCS_JSON!,
      mainnetRpcsJson: process.env.MAINNET_RPCS_JSON!,
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
      enableSchedules: process.env.ENABLE_EVENT_SCHEDULES !== "false",
    });

    const {
      apiAuthorizerLambda: famePoolStateApiAuthorizerLambda,
      apiLambda: famePoolStateApiLambda,
    } = new FamePoolState(this, "FamePoolState", {
      indexerBaseRpcsJson: process.env.FAME_POOL_STATE_INDEXER_BASE_RPCS_JSON,
      serviceToken: process.env.FAME_POOL_STATE_SERVICE_TOKEN ?? "",
      clReplayMaintenanceMode: famePoolStateClReplayMaintenanceModeFromEnv(
        process.env.FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE,
      ),
      clReplayTrustPromotion: famePoolStateClReplayTrustPromotionFromEnv(
        process.env.FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION,
      ),
      clReplayMaxRangeBlocks: Number(
        process.env.FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS ?? "1000",
      ),
      rpcGetLogsBlockRange: Number(
        process.env.FAME_POOL_STATE_RPC_GET_LOGS_BLOCK_RANGE ?? "500",
      ),
    });

    const { httpApi } = new HttpApi(this, "SocietyBotREST", {
      domain: JSON.parse(process.env.IMAGE_BASE_HOST_JSON!),
      fameImageThumbHandler: fameImageThumbLambda,
      fameImageMosaicHandler: fameImageMosaicLambda,
      flsImageThumbHandler: flsImageThumbLambda,
      flsImageMosaicHandler: flsImageMosaicLambda,
      discordInteractionHandler: notificationLambda,
      famePoolStateAuthorizerHandler: famePoolStateApiAuthorizerLambda,
      famePoolStateHandler: famePoolStateApiLambda,
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
