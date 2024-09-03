import * as cdk from "aws-cdk-lib";
import * as path from "path";
import { buildSync, type BuildOptions } from "esbuild";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as eventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as events from "aws-cdk-lib/aws-events";
import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Props {
  readonly baseRpcsJson: string;
  readonly sepoliaRpcsJson: string;
  readonly discordChannelId: string;
  readonly domain: [string, string] | string;
  readonly discordAppId: string;
  readonly discordPublicKey: string;
  readonly discordBotToken: string;
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

export class EventLambdas extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const {
      baseRpcsJson,
      sepoliaRpcsJson,
      domain,
      discordChannelId,
      discordAppId,
      discordBotToken,
      discordPublicKey,
    } = props;
    const domains = domain instanceof Array ? domain : [domain];
    const domainName = domains.join(".");

    const deferredMessageQueue = new sqs.Queue(this, "DeferredMessageQueue", {
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(1),
    });
    const deferredMessageTopic = new sns.Topic(this, "DeferredMessageTopic");

    const lastEventBlock = new dynamodb.Table(this, "LastFameEventBlock", {
      partitionKey: { name: "key", type: dynamodb.AttributeType.STRING },
      tableClass: dynamodb.TableClass.STANDARD,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const deferredMessageCodeDir = compile(
      path.join(__dirname, "../../src/discord/lambda/deferred.ts")
    );
    new lambda.Function(this, "deferredMessage", {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(deferredMessageCodeDir),
      handler: "index.handler",
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DISCORD_APPLICATION_ID: discordAppId,
        DISCORD_PUBLIC_KEY: discordPublicKey,
        DISCORD_BOT_TOKEN: discordBotToken,
        LOG_LEVEL: "debug",
      },
      events: [
        new eventSources.SqsEventSource(deferredMessageQueue, {
          batchSize: 10,
        }),
      ],
    });

    const fameEventCodeDir = compile(
      path.join(__dirname, "../../src/lambda/fame-event/index.ts")
    );
    const fameEventHandler = new lambda.Function(this, "FameEvent", {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(fameEventCodeDir),
      handler: "index.handler",
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        IMAGE_HOST: domainName,
        BASE_RPCS_JSON: baseRpcsJson,
        SEPOLIA_RPCS_JSON: sepoliaRpcsJson,
        LOG_LEVEL: "INFO",
        DISCORD_APPLICATION_ID: discordAppId,
        DISCORD_PUBLIC_KEY: discordPublicKey,
        DISCORD_BOT_TOKEN: discordBotToken,
        DISCORD_CHANNEL_ID: discordChannelId,
        DISCORD_MESSAGE_TOPIC_ARN: deferredMessageTopic.topicArn,
        DYNAMODB_FAME_INDEX_TABLE_NAME: lastEventBlock.tableName,
        DYNAMODB_REGION: cdk.Stack.of(this).region,
      },
    });
    lastEventBlock.grantReadWriteData(fameEventHandler);
    deferredMessageTopic.grantPublish(fameEventHandler);
    const fameEventScheduleRule = new events.Rule(
      this,
      "fameEventScheduleRule",
      {
        schedule: events.Schedule.rate(cdk.Duration.minutes(4)),
      }
    );
    fameEventScheduleRule.addTarget(
      new eventTargets.LambdaFunction(fameEventHandler)
    );
  }
}
