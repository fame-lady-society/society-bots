import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import {
  bundleHistoryWorker,
  bundleHistoryReader,
} from "./fame-market-history.js";
import { createLambdaLogGroup } from "./lambda-log-groups.js";
/** Physically isolated resources: no production history ARNs, route or activation permission. */
export class FameHistoryCandidate extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: { rpcParameterName: string },
  ) {
    super(scope, id);
    if (!props.rpcParameterName.startsWith("/"))
      throw new Error("RPC parameter path required");
    const bucket = new s3.Bucket(this, "Archive", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const table = new dynamodb.Table(this, "History", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const worker = new lambda.DockerImageFunction(this, "Worker", {
      code: lambda.DockerImageCode.fromImageAsset(
        bundleHistoryWorker("candidate-lambda.ts"),
        {
          target: "runtime",
          platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64,
        },
      ),
      architecture: lambda.Architecture.X86_64,
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      retryAttempts: 0,
      logGroup: createLambdaLogGroup(this, "WorkerLogs", "baseOperational"),
      environment: {
        FAME_CANDIDATE_TABLE: table.tableName,
        FAME_CANDIDATE_BUCKET: bucket.bucketName,
        FAME_HISTORY_RPC_PARAMETER: props.rpcParameterName,
      },
    });
    table.grantReadWriteData(worker);
    for (const prefix of ["raw/*", "derived/*"]) {
      bucket.grantRead(worker, prefix);
      bucket.grantPut(worker, prefix);
    }
    worker.addToRolePolicy(
      new iam.PolicyStatement({
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
    new events.Rule(this, "Schedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(worker, { retryAttempts: 0 })],
    });
    const reader = new lambda.Function(this, "Reader", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(bundleHistoryReader()),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup: createLambdaLogGroup(this, "ReaderLogs", "baseOperational"),
      environment: { FAME_HISTORY_TABLE: table.tableName },
    });
    reader.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
        ],
        resources: [table.tableArn],
      }),
    );
    // IAM invocation only. The production API route is untouched.
    for (const [name, value] of Object.entries({
      TableName: table.tableName,
      BucketName: bucket.bucketName,
      WorkerName: worker.functionName,
      ReaderName: reader.functionName,
    }))
      new cdk.CfnOutput(this, name, { value }).overrideLogicalId(name);
  }
}
