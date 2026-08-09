import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as eventTargets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaDestinations from "aws-cdk-lib/aws-lambda-destinations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as fs from "fs";
import { buildSync, type BuildOptions } from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";
import { Construct } from "constructs";
import { createLambdaLogGroup } from "./lambda-log-groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface FamePoolStateProps {
  readonly indexerBaseRpcsJson: string | undefined;
  readonly serviceToken: string | undefined;
  readonly apiReservedConcurrency?: number;
  readonly defaultMaxFreshnessBlocks?: number;
  readonly maxBatchSize?: number;
  readonly clReplayMaintenanceMode?: "checkpoint" | "steady-state" | "repair";
  readonly clReplayTrustPromotion?: boolean;
  readonly clReplayMaxRangeBlocks?: number;
  readonly rpcGetLogsBlockRange?: number;
  readonly schedule?: cdk.Duration;
  readonly landingSnapshotMaxAgeSeconds?: number;
  readonly landingSnapshotCacheSeconds?: number;
  readonly landingSnapshotStaleWhileRevalidateSeconds?: number;
  readonly landingSnapshotFutureToleranceSeconds?: number;
  readonly landingSnapshotRunTimeoutMs?: number;
  readonly landingSnapshotLeafTimeoutMs?: number;
  readonly landingSnapshotTtlSeconds?: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

export function famePoolStateClReplayMaintenanceModeFromEnv(
  value: string | undefined,
): "checkpoint" | "steady-state" | "repair" {
  if (!value || value.trim().length === 0) return "steady-state";
  if (
    value === "checkpoint" ||
    value === "steady-state" ||
    value === "repair"
  ) {
    return value;
  }
  throw new Error(
    "FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE must be checkpoint, steady-state, or repair.",
  );
}

export function famePoolStateClReplayTrustPromotionFromEnv(
  value: string | undefined,
): boolean {
  if (!value || value.trim().length === 0) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    "FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION must be true or false.",
  );
}

function bundlePoolStateLambda(entrypoint: string, options?: BuildOptions) {
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
  const outputDirectory = path.dirname(outfile);
  const landingFixtureDirectory = path.join(outputDirectory, "fixtures");
  fs.mkdirSync(landingFixtureDirectory);
  fs.copyFileSync(
    path.join(
      __dirname,
      "../../src/fame-swap-pool-state/registry/base-v1-pools.json",
    ),
    path.join(outputDirectory, "base-v1-pools.json"),
  );
  fs.copyFileSync(
    path.join(
      __dirname,
      "../../src/fame-swap-pool-state/fixtures/fame-landing-defi-authority-v1.json",
    ),
    path.join(landingFixtureDirectory, "fame-landing-defi-authority-v1.json"),
  );
  return outputDirectory;
}

function requiredNonEmpty(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} must be configured for FAME pool-state indexing.`);
  }
  return value;
}

function requiredBaseRpcsJson(value: string | undefined, name: string): string {
  const trimmed = requiredNonEmpty(value, name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${name} must be a non-empty JSON array of non-empty RPC URLs.`,
    );
  }

  const rpcs = parsed.map((rpc, index) => {
    if (typeof rpc !== "string" || rpc.trim().length === 0) {
      throw new Error(
        `${name}[${index.toString()}] must be a non-empty RPC URL.`,
      );
    }
    return rpc.trim();
  });

  return JSON.stringify(rpcs);
}

export class FamePoolState extends Construct {
  public readonly apiAuthorizerLambda: lambda.Function;
  public readonly apiLambda: lambda.Function;
  public readonly indexerFailureQueue: sqs.Queue;
  public readonly indexerLambda: lambda.Function;
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: FamePoolStateProps) {
    super(scope, id);

    const indexerBaseRpcsJson = requiredBaseRpcsJson(
      props.indexerBaseRpcsJson,
      "FAME_POOL_STATE_INDEXER_BASE_RPCS_JSON",
    );
    const serviceToken = requiredNonEmpty(
      props.serviceToken,
      "FAME_POOL_STATE_SERVICE_TOKEN",
    );
    const defaultMaxFreshnessBlocks =
      props.defaultMaxFreshnessBlocks?.toString() ?? "120";
    const maxBatchSize = props.maxBatchSize?.toString() ?? "64";
    const clReplayMaintenanceMode =
      props.clReplayMaintenanceMode ?? "steady-state";
    const clReplayTrustPromotion =
      (props.clReplayTrustPromotion ?? true) ? "true" : "false";
    const clReplayMaxRangeBlocks =
      props.clReplayMaxRangeBlocks?.toString() ?? "1000";
    const rpcGetLogsBlockRange =
      props.rpcGetLogsBlockRange?.toString() ?? "500";
    const landingSnapshotMaxAgeSeconds = positiveSafeInteger(
      props.landingSnapshotMaxAgeSeconds ?? 300,
      "landingSnapshotMaxAgeSeconds",
    );
    const landingSnapshotCacheSeconds = positiveSafeInteger(
      props.landingSnapshotCacheSeconds ?? 60,
      "landingSnapshotCacheSeconds",
    );
    const landingSnapshotStaleWhileRevalidateSeconds = positiveSafeInteger(
      props.landingSnapshotStaleWhileRevalidateSeconds ?? 120,
      "landingSnapshotStaleWhileRevalidateSeconds",
    );
    const landingSnapshotFutureToleranceSeconds = positiveSafeInteger(
      props.landingSnapshotFutureToleranceSeconds ?? 30,
      "landingSnapshotFutureToleranceSeconds",
    );
    const landingSnapshotRunTimeoutMs = positiveSafeInteger(
      props.landingSnapshotRunTimeoutMs ?? 10_000,
      "landingSnapshotRunTimeoutMs",
    );
    const landingSnapshotLeafTimeoutMs = positiveSafeInteger(
      props.landingSnapshotLeafTimeoutMs ?? 1_500,
      "landingSnapshotLeafTimeoutMs",
    );
    const landingSnapshotTtlSeconds = positiveSafeInteger(
      props.landingSnapshotTtlSeconds ?? 86_400,
      "landingSnapshotTtlSeconds",
    );
    if (landingSnapshotCacheSeconds > landingSnapshotMaxAgeSeconds) {
      throw new Error(
        "landing snapshot cache lifetime must not exceed max age.",
      );
    }
    if (landingSnapshotLeafTimeoutMs > landingSnapshotRunTimeoutMs) {
      throw new Error(
        "landing snapshot leaf timeout must not exceed run timeout.",
      );
    }
    if (
      landingSnapshotTtlSeconds <=
      landingSnapshotMaxAgeSeconds + landingSnapshotStaleWhileRevalidateSeconds
    ) {
      throw new Error(
        "landing snapshot TTL must exceed max age plus revalidation margin.",
      );
    }
    if (landingSnapshotRunTimeoutMs > 55_000) {
      throw new Error(
        "landing snapshot run timeout must leave the indexer Lambda shutdown margin.",
      );
    }

    const table = new dynamodb.Table(this, "FamePoolState", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      tableClass: dynamodb.TableClass.STANDARD,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
    });

    const commonEnvironment = {
      DYNAMODB_REGION: cdk.Stack.of(this).region,
      FAME_POOL_STATE_TABLE_NAME: table.tableName,
      FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS: defaultMaxFreshnessBlocks,
      FAME_POOL_STATE_MAX_BATCH_SIZE: maxBatchSize,
      FAME_LANDING_SNAPSHOT_MAX_AGE_SECONDS:
        landingSnapshotMaxAgeSeconds.toString(),
      FAME_LANDING_SNAPSHOT_CACHE_SECONDS:
        landingSnapshotCacheSeconds.toString(),
      FAME_LANDING_SNAPSHOT_STALE_WHILE_REVALIDATE_SECONDS:
        landingSnapshotStaleWhileRevalidateSeconds.toString(),
      FAME_LANDING_SNAPSHOT_FUTURE_TOLERANCE_SECONDS:
        landingSnapshotFutureToleranceSeconds.toString(),
      FAME_LANDING_SNAPSHOT_RUN_TIMEOUT_MS:
        landingSnapshotRunTimeoutMs.toString(),
      FAME_LANDING_SNAPSHOT_LEAF_TIMEOUT_MS:
        landingSnapshotLeafTimeoutMs.toString(),
      FAME_LANDING_SNAPSHOT_TTL_SECONDS: landingSnapshotTtlSeconds.toString(),
      LOG_LEVEL: "INFO",
    };

    const indexerCodeDir = bundlePoolStateLambda(
      path.join(__dirname, "../../src/fame-swap-pool-state/lambdas/indexer.ts"),
    );
    const indexerLambda = new lambda.Function(this, "FamePoolStateIndexer", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(indexerCodeDir),
      handler: "index.handler",
      logGroup: createLambdaLogGroup(
        this,
        "FamePoolStateIndexerLogGroup",
        "replayTick",
      ),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      reservedConcurrentExecutions: 1,
      environment: {
        ...commonEnvironment,
        BASE_RPCS_JSON: indexerBaseRpcsJson,
        FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE: clReplayMaintenanceMode,
        FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION: clReplayTrustPromotion,
        FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS: clReplayMaxRangeBlocks,
        FAME_POOL_STATE_RPC_GET_LOGS_BLOCK_RANGE: rpcGetLogsBlockRange,
      },
    });
    indexerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:BatchGetItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ],
        resources: [table.tableArn],
      }),
    );

    const indexerFailureQueue = new sqs.Queue(
      this,
      "FamePoolStateIndexerFailureQueue",
      {
        retentionPeriod: cdk.Duration.days(7),
      },
    );
    new lambda.EventInvokeConfig(this, "FamePoolStateIndexerInvokeConfig", {
      function: indexerLambda,
      onFailure: new lambdaDestinations.SqsDestination(indexerFailureQueue),
      retryAttempts: 2,
    });

    const alarmPeriod = cdk.Duration.minutes(5);
    const indexerErrorsAlarm = new cloudwatch.Alarm(
      this,
      "FamePoolStateIndexerErrorsAlarm",
      {
        metric: indexerLambda.metricErrors({
          period: alarmPeriod,
          statistic: "sum",
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    const indexerThrottlesAlarm = new cloudwatch.Alarm(
      this,
      "FamePoolStateIndexerThrottlesAlarm",
      {
        metric: indexerLambda.metricThrottles({
          period: alarmPeriod,
          statistic: "sum",
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    const indexerMissedInvocationsAlarm = new cloudwatch.Alarm(
      this,
      "FamePoolStateIndexerMissedInvocationsAlarm",
      {
        metric: indexerLambda.metricInvocations({
          period: alarmPeriod,
          statistic: "sum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
    const indexerFailureQueueAlarm = new cloudwatch.Alarm(
      this,
      "FamePoolStateIndexerFailureQueueAlarm",
      {
        metric: indexerFailureQueue.metricApproximateNumberOfMessagesVisible({
          period: alarmPeriod,
          statistic: "maximum",
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );

    const apiCodeDir = bundlePoolStateLambda(
      path.join(__dirname, "../../src/fame-swap-pool-state/lambdas/api.ts"),
    );
    const apiAuthorizerCodeDir = bundlePoolStateLambda(
      path.join(
        __dirname,
        "../../src/fame-swap-pool-state/lambdas/authorizer.ts",
      ),
    );
    const apiAuthorizerLambda = new lambda.Function(
      this,
      "FamePoolStateApiAuthorizer",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        code: lambda.Code.fromAsset(apiAuthorizerCodeDir),
        handler: "index.handler",
        logGroup: createLambdaLogGroup(
          this,
          "FamePoolStateApiAuthorizerLogGroup",
          "replayTick",
        ),
        timeout: cdk.Duration.seconds(5),
        memorySize: 128,
        environment: {
          FAME_POOL_STATE_SERVICE_TOKEN: serviceToken,
          LOG_LEVEL: "INFO",
        },
      },
    );

    const apiLambda = new lambda.Function(this, "FamePoolStateApi", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(apiCodeDir),
      handler: "index.handler",
      logGroup: createLambdaLogGroup(
        this,
        "FamePoolStateApiLogGroup",
        "replayTick",
      ),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
      reservedConcurrentExecutions: props.apiReservedConcurrency ?? 5,
      environment: {
        ...commonEnvironment,
        FAME_POOL_STATE_SERVICE_TOKEN: serviceToken,
      },
    });
    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:BatchGetItem", "dynamodb:GetItem"],
        resources: [table.tableArn],
      }),
    );

    const scheduleRule = new events.Rule(this, "FamePoolStateScheduleRule", {
      schedule: events.Schedule.rate(props.schedule ?? cdk.Duration.minutes(1)),
    });
    scheduleRule.addTarget(
      new eventTargets.LambdaFunction(indexerLambda, {
        deadLetterQueue: indexerFailureQueue,
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(1),
      }),
    );

    new cdk.CfnOutput(this, "FamePoolStateTableName", {
      value: table.tableName,
    });
    new cdk.CfnOutput(this, "FamePoolStateIndexerFunctionName", {
      value: indexerLambda.functionName,
    });
    new cdk.CfnOutput(this, "FamePoolStateIndexerFailureQueueName", {
      value: indexerFailureQueue.queueName,
    });
    new cdk.CfnOutput(this, "FamePoolStateIndexerErrorsAlarmName", {
      value: indexerErrorsAlarm.alarmName,
    });
    new cdk.CfnOutput(this, "FamePoolStateIndexerThrottlesAlarmName", {
      value: indexerThrottlesAlarm.alarmName,
    });
    new cdk.CfnOutput(this, "FamePoolStateIndexerMissedInvocationsAlarmName", {
      value: indexerMissedInvocationsAlarm.alarmName,
    });
    new cdk.CfnOutput(this, "FamePoolStateIndexerFailureQueueAlarmName", {
      value: indexerFailureQueueAlarm.alarmName,
    });
    new cdk.CfnOutput(this, "FamePoolStateApiFunctionName", {
      value: apiLambda.functionName,
    });
    new cdk.CfnOutput(this, "FamePoolStateApiAuthorizerFunctionName", {
      value: apiAuthorizerLambda.functionName,
    });

    this.table = table;
    this.indexerFailureQueue = indexerFailureQueue;
    this.indexerLambda = indexerLambda;
    this.apiLambda = apiLambda;
    this.apiAuthorizerLambda = apiAuthorizerLambda;
  }
}
