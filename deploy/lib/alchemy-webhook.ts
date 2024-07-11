import * as cdk from "aws-cdk-lib";
import * as path from "path";
import { buildSync, type BuildOptions } from "esbuild";
import { Construct } from "constructs";
import * as apigw2 from "aws-cdk-lib/aws-apigatewayv2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Props {
  readonly mainnetRpcsJson: string;
  readonly sepoliaRpcsJson: string;
  readonly baseRpcsJson: string;
  readonly telegramBotToken: string;
  readonly alchemyWebhookSigningKey: string;
}

function compile(entrypoint: string, options?: BuildOptions) {
  const outfile = path.join(
    cdk.FileSystem.mkdtemp(path.basename(entrypoint)),
    "index.mjs"
  );
  buildSync({
    entryPoints: [entrypoint],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["aws-sdk", "canvas"],
    inject: [path.join(__dirname, "./esbuild/cjs-shim.ts")],
    sourcemap: true,
    ...options,
  });
  const finalDir = path.dirname(outfile);
  return finalDir;
}

export class AlchemyWebhooks extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const {
      mainnetRpcsJson,
      sepoliaRpcsJson,
      baseRpcsJson,
      alchemyWebhookSigningKey,
      telegramBotToken,
    } = props;

    const webhookSwapHandler = new lambda.Function(this, "SwapSchwing", {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(
        compile(path.join(__dirname, "../../src/webhook/swap/index.ts"))
      ),
      handler: "index.handler",
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        MAINNET_RPCS_JSON: mainnetRpcsJson,
        SEPOLIA_RPCS_JSON: sepoliaRpcsJson,
        BASE_RPCS_JSON: baseRpcsJson,
        TELEGRAM_BOT_TOKEN: telegramBotToken,
        ALCHEMY_WEBHOOK_SIGNING_KEY: alchemyWebhookSigningKey,
        LOG_LEVEL: "INFO",
      },
    });

    const httpApi = new apigw2.HttpApi(this, "Webhooks", {
      description: "This service accepts webhooks responses from alchemy.",
    });
    httpApi.addRoutes({
      path: "/schwing-event-1",
      methods: [apigw2.HttpMethod.POST],
      integration: new HttpLambdaIntegration(
        "webhook-swap-base-schwing",
        webhookSwapHandler
      ),
    });

    const apiUrl = cdk.Fn.select(1, cdk.Fn.split("//", httpApi.apiEndpoint));
    new cdk.CfnOutput(this, "ApiUrl", {
      value: apiUrl,
    });
  }
}
