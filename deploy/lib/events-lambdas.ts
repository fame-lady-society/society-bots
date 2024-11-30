import * as cdk from "aws-cdk-lib";
import * as path from "path";
import { buildSync, type BuildOptions } from "esbuild";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
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
  readonly mainnetRpcsJson: string;
  readonly discordChannelId: string;
  readonly domain: [string, string] | string;
  readonly discordAppId: string;
  readonly discordPublicKey: string;
  readonly discordBotToken: string;
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

export class EventLambdas extends Construct {
  public readonly notificationLambda: lambda.Function;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const {
      baseRpcsJson,
      sepoliaRpcsJson,
      mainnetRpcsJson,
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
    deferredMessageTopic.addSubscription(
      new subs.SqsSubscription(deferredMessageQueue),
    );

    const logHandlerQueue = new sqs.Queue(this, "LogHandlerQueue", {
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(1),
    });
    const logHandlerTopic = new sns.Topic(this, "LogHandlerTopic");
    logHandlerTopic.addSubscription(new subs.SqsSubscription(logHandlerQueue));

    const lastEventBlock = new dynamodb.Table(this, "LastFameEventBlock", {
      partitionKey: { name: "key", type: dynamodb.AttributeType.STRING },
      tableClass: dynamodb.TableClass.STANDARD,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const lastWrapperEventBlock = new dynamodb.Table(
      this,
      "LastWrapperEventBlock",
      {
        partitionKey: { name: "key", type: dynamodb.AttributeType.STRING },
        tableClass: dynamodb.TableClass.STANDARD,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      },
    );

    const discordNotificationsTable = new dynamodb.Table(
      this,
      "DiscordNotifications",
      {
        partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
        tableClass: dynamodb.TableClass.STANDARD,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      },
    );
    discordNotificationsTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "sk", type: dynamodb.AttributeType.STRING },
    });

    const interactionHandlerCodeDir = compile(
      path.join(__dirname, "../../src/discord/lambda/interaction.ts"),
    );
    const interactionHandler = new lambda.Function(this, "interactionHandler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(interactionHandlerCodeDir),
      handler: "index.handler",
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      environment: {
        DISCORD_APPLICATION_ID: discordAppId,
        DISCORD_PUBLIC_KEY: discordPublicKey,
        DISCORD_BOT_TOKEN: discordBotToken,
        LOG_LEVEL: "debug",
        DISCORD_MESSAGE_TOPIC_ARN: deferredMessageTopic.topicArn,
        DYNAMODB_REGION: cdk.Stack.of(this).region,
        DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME:
          discordNotificationsTable.tableName,
        DYNAMODB_FAME_INDEX_TABLE_NAME: lastEventBlock.tableName,
      },
    });
    discordNotificationsTable.grantReadWriteData(interactionHandler);
    deferredMessageTopic.grantPublish(interactionHandler);

    const deferredMessageCodeDir = compile(
      path.join(__dirname, "../../src/discord/lambda/deferred.ts"),
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
      path.join(__dirname, "../../src/fame-event/lambdas/messaging/index.ts"),
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
        MAINNET_RPCS_JSON: mainnetRpcsJson,
        LOG_LEVEL: "INFO",
        DISCORD_APPLICATION_ID: discordAppId,
        DISCORD_PUBLIC_KEY: discordPublicKey,
        DISCORD_BOT_TOKEN: discordBotToken,
        DISCORD_CHANNEL_ID: discordChannelId,
        DISCORD_MESSAGE_TOPIC_ARN: deferredMessageTopic.topicArn,
        DYNAMODB_FAME_INDEX_TABLE_NAME: lastEventBlock.tableName,
        DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME:
          discordNotificationsTable.tableName,
        DYNAMODB_REGION: cdk.Stack.of(this).region,
      },
    });
    lastEventBlock.grantReadWriteData(fameEventHandler);
    discordNotificationsTable.grantReadWriteData(fameEventHandler);
    deferredMessageTopic.grantPublish(fameEventHandler);

    const wrapEventCodeDir = compile(
      path.join(__dirname, "../../src/lambda/fls-wrapper-event/index.ts"),
    );

    const wrapEventHandler = new lambda.Function(this, "WrapEvent", {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(wrapEventCodeDir),
      handler: "index.handler",
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        DISCORD_CHANNEL_ID: discordChannelId,
        DISCORD_MESSAGE_TOPIC_ARN: deferredMessageTopic.topicArn,
        DYNAMODB_REGION: cdk.Stack.of(this).region,
        DYNAMODB_TABLE: lastWrapperEventBlock.tableName,
        LOG_LEVEL: "debug",
        DISCORD_APPLICATION_ID: discordAppId,
        DISCORD_PUBLIC_KEY: discordPublicKey,
        DISCORD_BOT_TOKEN: discordBotToken,
        SEPOLIA_RPCS_JSON: sepoliaRpcsJson,
        MAINNET_RPCS_JSON: mainnetRpcsJson,
      },
    });
    lastWrapperEventBlock.grantReadWriteData(wrapEventHandler);
    deferredMessageTopic.grantPublish(wrapEventHandler);

    const fameEventScheduleRule = new events.Rule(
      this,
      "fameEventScheduleRule",
      {
        schedule: events.Schedule.rate(cdk.Duration.minutes(4)),
      },
    );
    fameEventScheduleRule.addTarget(
      new eventTargets.LambdaFunction(fameEventHandler),
    );

    const wrapEventScheduleRule = new events.Rule(
      this,
      "wrapEventScheduleRule",
      {
        schedule: events.Schedule.rate(cdk.Duration.minutes(6)),
      },
    );
    wrapEventScheduleRule.addTarget(
      new eventTargets.LambdaFunction(wrapEventHandler),
    );

    new cdk.CfnOutput(this, "LogHandlerQueueArn", {
      value: logHandlerQueue.queueArn,
    });

    new cdk.CfnOutput(this, "MessageTopicArn", {
      value: deferredMessageTopic.topicArn,
    });

    new cdk.CfnOutput(this, "LastEventBlockTableName", {
      value: lastEventBlock.tableName,
    });

    new cdk.CfnOutput(this, "DiscordNotificationsTableName", {
      value: discordNotificationsTable.tableName,
    });

    new cdk.CfnOutput(this, "LastWrapperEventBlockTableName", {
      value: lastWrapperEventBlock.tableName,
    });

    this.notificationLambda = interactionHandler;
  }
}
