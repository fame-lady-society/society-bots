import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { buildSync } from "esbuild";
import { copyFileSync, readFileSync } from "node:fs";
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

export function bundleHistoryWorker(): string {
  const bundle = cdk.FileSystem.mkdtemp("fame-history-worker-");
  const app = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const runtime = JSON.parse(
    readFileSync(
      path.join(root, "deploy/docker/market-history/package.json"),
      "utf8",
    ),
  );
  if (
    app.dependencies["@duckdb/node-api"] !==
    runtime.dependencies["@duckdb/node-api"]
  )
    throw new Error("DuckDB worker dependency differs from application lock");
  buildSync({
    entryPoints: [path.join(root, "src/fame-market-history/worker-lambda.ts")],
    outfile: path.join(bundle, "index.mjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external: ["@duckdb/node-api"],
    inject: [path.join(root, "deploy/lib/esbuild/cjs-shim.ts")],
  });
  for (const file of ["Dockerfile", "package.json", "package-lock.json"])
    copyFileSync(
      path.join(root, "deploy/docker/market-history", file),
      path.join(bundle, file),
    );
  copyFileSync(
    path.join(root, "src/fame-market-history/token-metadata.json"),
    path.join(bundle, "token-metadata.json"),
  );
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
      poolStateTableName: string;
    },
  ) {
    super(scope, id);
    if (!Number.isSafeInteger(props.startBlock) || props.startBlock <= 0)
      throw new Error("startBlock must be a positive safe integer");
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
    const worker = new lambda.DockerImageFunction(this, "Aggregator", {
      code: lambda.DockerImageCode.fromImageAsset(bundleHistoryWorker(), {
        target: "runtime",
        platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      onFailure: new destinations.SqsDestination(failures),
      logGroup: createLambdaLogGroup(this, "AggregatorLogs", "baseOperational"),
      environment: {
        FAME_HISTORY_TABLE: table.tableName,
        FAME_HISTORY_BUCKET: bucket.bucketName,
        FAME_HISTORY_START_BLOCK: String(props.startBlock),
      },
    });
    table.grantReadWriteData(worker);
    bucket.grantRead(worker, "raw/*");
    bucket.grantRead(worker, "derived/*");
    bucket.grantPut(worker, "derived/*");
    new events.Rule(this, "AggregationSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(worker, { retryAttempts: 0 })],
    });
    new cdk.CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "CollectorName", { value: collector.functionName });
    new cdk.CfnOutput(this, "AggregatorName", { value: worker.functionName });
  }
}
