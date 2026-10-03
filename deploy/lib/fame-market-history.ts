import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { buildSync } from "esbuild";
import { copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLambdaLogGroup } from "./lambda-log-groups.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function bundleHistoryCollector(): string {
  const bundle = cdk.FileSystem.mkdtemp("fame-market-history-");
  buildSync({
    entryPoints: [path.join(root, "src/fame-market-history/lambda.ts")],
    outfile: path.join(bundle, "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    inject: [path.join(root, "deploy/lib/esbuild/cjs-shim.ts")],
  });
  copyFileSync(
    path.join(root, "src/fame-swap-pool-state/registry/base-v1-pools.json"),
    path.join(bundle, "base-v1-pools.json"),
  );
  return bundle;
}

/** Separate stack entrypoint: deploying unrelated bot work cannot start history. */
export class FameMarketHistory extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: {
      rpcParameterName: string;
      startBlock: number;
      dailyRequests: number;
      poolStateTableName: string;
    },
  ) {
    super(scope, id);
    for (const [key, value] of Object.entries({
      startBlock: props.startBlock,
      dailyRequests: props.dailyRequests,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${key} must be a positive safe integer`);
    }
    if (!props.rpcParameterName.startsWith("/"))
      throw new Error("RPC SecureString parameter path required");
    if (!props.poolStateTableName)
      throw new Error("Pool-state table name required");
    const bucket = new s3.Bucket(this, "Archive", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
    });
    const table = new dynamodb.Table(this, "History", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const poolState = dynamodb.Table.fromTableName(
      this,
      "PoolState",
      props.poolStateTableName,
    );
    const bundle = bundleHistoryCollector();
    const failures = new sqs.Queue(this, "Failures", {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const collector = new lambda.Function(this, "Collector", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(bundle),
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      onFailure: new destinations.SqsDestination(failures),
      logGroup: createLambdaLogGroup(this, "Logs", "baseOperational"),
      environment: {
        FAME_HISTORY_RPC_PARAMETER: props.rpcParameterName,
        FAME_HISTORY_TABLE: table.tableName,
        FAME_HISTORY_BUCKET: bucket.bucketName,
        FAME_HISTORY_POOL_STATE_TABLE: poolState.tableName,
        FAME_HISTORY_START_BLOCK: String(props.startBlock),
        FAME_HISTORY_DAILY_REQUESTS: String(props.dailyRequests),
      },
    });
    // Read the secret at runtime, rather than embedding it in synthesized templates.
    collector.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: props.rpcParameterName.slice(1),
          }),
        ],
      }),
    );
    table.grantReadWriteData(collector);
    poolState.grantReadData(collector);
    bucket.grantPut(collector, "raw/*");
    bucket.grantRead(collector, "raw/*");
    new events.Rule(this, "Schedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(collector, { retryAttempts: 0 })],
    });
    for (const [name, metric] of [
      ["Errors", collector.metricErrors()],
      ["Throttles", collector.metricThrottles()],
      ["Failures", failures.metricApproximateNumberOfMessagesVisible()],
    ] as const) {
      new cloudwatch.Alarm(this, `${name}Alarm`, {
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }
    new cloudwatch.Alarm(this, "CoverageLagAlarm", {
      metric: new cloudwatch.Metric({
        namespace: "Society/FameMarketHistory",
        metricName: "CoverageLagBlocks",
        statistic: "Maximum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5000,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "MissedInvocationsAlarm", {
      metric: collector.metricInvocations({
        period: cdk.Duration.minutes(15),
        statistic: "Sum",
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "CollectorName", { value: collector.functionName });
  }
}
