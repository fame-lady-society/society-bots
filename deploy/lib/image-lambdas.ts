import * as cdk from "aws-cdk-lib";
import * as path from "path";
import { buildSync, type BuildOptions } from "esbuild";
import { Construct } from "constructs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as apigw2 from "aws-cdk-lib/aws-apigatewayv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { fileURLToPath } from "url";
import { dirname } from "path";
import * as fs from "fs";
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Props {
  readonly baseRpcsJson: string;
  readonly mainnetRpcsJson: string;
  readonly domain: [string, string] | string;
  readonly corsAllowedOriginsJson: string;
}

function compile(entrypoint: string, options?: BuildOptions) {
  const outfile = path.join(
    cdk.FileSystem.mkdtemp(path.basename(entrypoint)),
    "index.mjs",
  );
  buildSync({
    entryPoints: [entrypoint],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["aws-sdk", "canvas", "dtrace-provider"],
    inject: [path.join(__dirname, "./esbuild/cjs-shim.ts")],
    sourcemap: true,
    ...options,
  });
  const finalDir = path.dirname(outfile);
  return finalDir;
}

export class ImageLambdas extends Construct {
  declare readonly fameImageThumbLambda: lambda.IFunction;
  declare readonly fameImageMosaicLambda: lambda.IFunction;
  declare readonly flsImageThumbLambda: lambda.IFunction;
  declare readonly flsImageMosaicLambda: lambda.IFunction;
  declare readonly assetStorageBucket: s3.Bucket;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const { baseRpcsJson, mainnetRpcsJson, corsAllowedOriginsJson, domain } =
      props;

    const storageBucket = new s3.Bucket(this, "storage", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const domains = domain instanceof Array ? domain : [domain];
    const domainName = domains.join(".");
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: domain.length === 2 ? domains[1] : domains[0],
    });

    const fameThumbCodeDir = compile(
      path.join(__dirname, "../../src/lambda/fame/thumb.ts"),
    );
    fs.copyFileSync(
      path.resolve(__dirname, "../docker/canvas/Dockerfile"),
      `${fameThumbCodeDir}/Dockerfile`,
    );
    const fameThumbHandler = new lambda.DockerImageFunction(this, "FameThumb", {
      code: lambda.DockerImageCode.fromImageAsset(fameThumbCodeDir, {
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      timeout: cdk.Duration.seconds(5),
      memorySize: 512,
      environment: {
        ASSET_BUCKET: storageBucket.bucketName,
        IMAGE_HOST: domainName,
        BASE_RPCS_JSON: baseRpcsJson,
        LOG_LEVEL: "INFO",
        CORS_ALLOWED_ORIGINS_JSON: corsAllowedOriginsJson,
      },
    });
    storageBucket.grantReadWrite(fameThumbHandler);

    const fameMosaicCodeDir = compile(
      path.join(__dirname, "../../src/lambda/fame/mosaic.ts"),
    );
    fs.copyFileSync(
      path.resolve(__dirname, "../docker/canvas/Dockerfile"),
      `${fameMosaicCodeDir}/Dockerfile`,
    );
    const fameMosaicHandler = new lambda.DockerImageFunction(this, "Mosaic", {
      code: lambda.DockerImageCode.fromImageAsset(fameMosaicCodeDir, {
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      timeout: cdk.Duration.seconds(15),
      memorySize: 1024,
      environment: {
        ASSET_BUCKET: storageBucket.bucketName,
        IMAGE_HOST: domainName,
        BASE_RPCS_JSON: baseRpcsJson,
        LOG_LEVEL: "INFO",
        CORS_ALLOWED_ORIGINS_JSON: corsAllowedOriginsJson,
      },
    });
    storageBucket.grantReadWrite(fameMosaicHandler);

    const flsThumbCodeDir = compile(
      path.join(__dirname, "../../src/lambda/fls-image/thumb.ts"),
    );
    fs.copyFileSync(
      path.resolve(__dirname, "../docker/canvas/Dockerfile"),
      `${flsThumbCodeDir}/Dockerfile`,
    );
    const flsThumbHandler = new lambda.DockerImageFunction(this, "FlsThumb", {
      code: lambda.DockerImageCode.fromImageAsset(flsThumbCodeDir, {
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      timeout: cdk.Duration.seconds(5),
      memorySize: 512,
      environment: {
        ASSET_BUCKET: storageBucket.bucketName,
        IMAGE_HOST: domainName,
        MAINNET_RPCS_JSON: mainnetRpcsJson,
        LOG_LEVEL: "INFO",
        CORS_ALLOWED_ORIGINS_JSON: corsAllowedOriginsJson,
      },
    });
    storageBucket.grantReadWrite(flsThumbHandler);

    const flsMosaicCodeDir = compile(
      path.join(__dirname, "../../src/lambda/fls-image/mosaic.ts"),
    );
    fs.copyFileSync(
      path.resolve(__dirname, "../docker/canvas/Dockerfile"),
      `${flsMosaicCodeDir}/Dockerfile`,
    );
    const flsMosaicHandler = new lambda.DockerImageFunction(this, "FlsMosaic", {
      code: lambda.DockerImageCode.fromImageAsset(flsMosaicCodeDir, {
        platform: ecrAssets.Platform.LINUX_AMD64,
      }),
      timeout: cdk.Duration.seconds(15),
      memorySize: 1024,
      environment: {
        ASSET_BUCKET: storageBucket.bucketName,
        IMAGE_HOST: domainName,
        MAINNET_RPCS_JSON: mainnetRpcsJson,
        LOG_LEVEL: "INFO",
        CORS_ALLOWED_ORIGINS_JSON: corsAllowedOriginsJson,
      },
    });
    storageBucket.grantReadWrite(flsMosaicHandler);

    this.assetStorageBucket = storageBucket;
    this.fameImageThumbLambda = fameThumbHandler;
    this.fameImageMosaicLambda = fameMosaicHandler;
    this.flsImageThumbLambda = flsThumbHandler;
    this.flsImageMosaicLambda = flsMosaicHandler;
  }
}
