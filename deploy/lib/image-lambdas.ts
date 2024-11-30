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
    target: "node20",
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
  declare readonly imageThumbLambda: lambda.IFunction;
  declare readonly imageMosaicLambda: lambda.IFunction;
  declare readonly assetStorageBucket: s3.Bucket;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const { baseRpcsJson, corsAllowedOriginsJson, domain } = props;

    const storageBucket = new s3.Bucket(this, "storage", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const domains = domain instanceof Array ? domain : [domain];
    const domainName = domains.join(".");
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: domain.length === 2 ? domains[1] : domains[0],
    });

    const thumbCodeDir = compile(
      path.join(__dirname, "../../src/lambda/fame/thumb.ts"),
    );
    fs.copyFileSync(
      path.resolve(__dirname, "../docker/canvas/Dockerfile"),
      `${thumbCodeDir}/Dockerfile`,
    );
    const thumbHandler = new lambda.DockerImageFunction(this, "FameThumb", {
      code: lambda.DockerImageCode.fromImageAsset(thumbCodeDir, {
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
    storageBucket.grantReadWrite(thumbHandler);

    const mosaicCodeDir = compile(
      path.join(__dirname, "../../src/lambda/fame/mosaic.ts"),
    );
    fs.copyFileSync(
      path.resolve(__dirname, "../docker/canvas/Dockerfile"),
      `${mosaicCodeDir}/Dockerfile`,
    );
    const mosaicHandler = new lambda.DockerImageFunction(this, "Mosaic", {
      code: lambda.DockerImageCode.fromImageAsset(mosaicCodeDir, {
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
    storageBucket.grantReadWrite(mosaicHandler);

    this.assetStorageBucket = storageBucket;
    this.imageThumbLambda = thumbHandler;
    this.imageMosaicLambda = mosaicHandler;
  }
}
