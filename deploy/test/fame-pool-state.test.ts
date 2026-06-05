import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { FamePoolStateDevStack } from "../lib/fame-pool-state-dev-stack.js";
import { FamePoolState } from "../lib/fame-pool-state.js";
import { HttpApi } from "../lib/http-api.js";

function preflight(env: {
  BASE_RPCS_JSON: string;
  FAME_POOL_STATE_SERVICE_TOKEN: string;
}) {
  return spawnSync(
    "bash",
    ["../scripts/validate-fame-pool-state-deploy-config.sh"],
    {
      env: {
        PATH: process.env.PATH ?? "",
        BASE_RPCS_JSON: env.BASE_RPCS_JSON,
        FAME_POOL_STATE_SERVICE_TOKEN: env.FAME_POOL_STATE_SERVICE_TOKEN,
      },
      encoding: "utf8",
    },
  );
}

function importedHandler(stack: cdk.Stack, id: string): lambda.IFunction {
  return lambda.Function.fromFunctionArn(
    stack,
    id,
    `arn:aws:lambda:${stack.region}:123456789012:function:${id}`,
  );
}

function expectOutputMatching(template: Template, logicalIdPart: string) {
  const outputIds = Object.keys(template.findOutputs("*"));
  expect(outputIds.some((outputId) => outputId.includes(logicalIdPart))).toBe(
    true,
  );
}

describe("FamePoolState infrastructure", () => {
  test("synthesizes latest-state table, lambdas, and schedule without a GSI", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    new FamePoolState(stack, "FamePoolState", {
      baseRpcsJson: JSON.stringify(["https://base.example"]),
      serviceToken: "unit-token",
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        {
          AttributeName: "pk",
          KeyType: "HASH",
        },
        {
          AttributeName: "sk",
          KeyType: "RANGE",
        },
      ],
      GlobalSecondaryIndexes: Match.absent(),
      TimeToLiveSpecification: {
        AttributeName: "expiresAt",
        Enabled: true,
      },
    });
    template.resourceCountIs("AWS::Lambda::Function", 3);
    template.resourceCountIs("AWS::Logs::LogGroup", 3);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 7,
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
      State: "ENABLED",
    });
  });

  test("gives the API Lambda service auth and read-only table actions", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    new FamePoolState(stack, "FamePoolState", {
      baseRpcsJson: JSON.stringify(["https://base.example"]),
      serviceToken: "unit-token",
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          FAME_POOL_STATE_SERVICE_TOKEN: "unit-token",
          FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS: "120",
          FAME_POOL_STATE_MAX_BATCH_SIZE: "64",
        }),
      },
      Timeout: 5,
      ReservedConcurrentExecutions: 5,
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "dynamodb:BatchGetItem",
              "dynamodb:GetItem",
            ]),
          }),
        ]),
      },
    });
  });

  test("gives the indexer Base RPC configuration and write table actions", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    new FamePoolState(stack, "FamePoolState", {
      baseRpcsJson: JSON.stringify(["https://base.example"]),
      serviceToken: "unit-token",
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          BASE_RPCS_JSON: JSON.stringify(["https://base.example"]),
          FAME_POOL_STATE_DEFAULT_MAX_FRESHNESS_BLOCKS: "120",
          FAME_POOL_STATE_MAX_BATCH_SIZE: "64",
          FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE: "steady-state",
          FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION: "true",
          FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS: "1000",
        }),
      },
      Timeout: 60,
      ReservedConcurrentExecutions: 1,
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
            ]),
          }),
        ]),
      },
    });
  });

  test("allows explicit CL replay maintenance overrides", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    new FamePoolState(stack, "FamePoolState", {
      baseRpcsJson: JSON.stringify(["https://base.example"]),
      serviceToken: "unit-token",
      clReplayMaintenanceMode: "checkpoint",
      clReplayTrustPromotion: false,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE: "checkpoint",
          FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION: "false",
        }),
      },
    });
  });

  test("captures indexer async failures with passive health alarms", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    new FamePoolState(stack, "FamePoolState", {
      baseRpcsJson: JSON.stringify(["https://base.example"]),
      serviceToken: "unit-token",
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::SQS::Queue", 1);
    template.resourceCountIs("AWS::Lambda::EventInvokeConfig", 1);
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      DestinationConfig: {
        OnFailure: {
          Destination: Match.anyValue(),
        },
      },
    });

    template.hasResourceProperties("AWS::Events::Rule", {
      Targets: Match.arrayWith([
        Match.objectLike({
          DeadLetterConfig: {
            Arn: Match.anyValue(),
          },
          RetryPolicy: {
            MaximumEventAgeInSeconds: 3600,
            MaximumRetryAttempts: 2,
          },
        }),
      ]),
    });

    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Errors",
      Namespace: "AWS/Lambda",
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 0,
      TreatMissingData: "notBreaching",
      AlarmActions: Match.absent(),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Throttles",
      Namespace: "AWS/Lambda",
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 0,
      TreatMissingData: "notBreaching",
      AlarmActions: Match.absent(),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Invocations",
      Namespace: "AWS/Lambda",
      ComparisonOperator: "LessThanThreshold",
      Threshold: 1,
      TreatMissingData: "breaching",
      AlarmActions: Match.absent(),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ApproximateNumberOfMessagesVisible",
      Namespace: "AWS/SQS",
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 0,
      TreatMissingData: "notBreaching",
      AlarmActions: Match.absent(),
    });

    expectOutputMatching(template, "FamePoolStateIndexerFailureQueueName");
    expectOutputMatching(template, "FamePoolStateIndexerErrorsAlarmName");
    expectOutputMatching(template, "FamePoolStateIndexerThrottlesAlarmName");
    expectOutputMatching(
      template,
      "FamePoolStateIndexerMissedInvocationsAlarmName",
    );
    expectOutputMatching(template, "FamePoolStateIndexerFailureQueueAlarmName");
  });

  test("wires the FAME pool-state API routes", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack", {
      env: {
        account: "123456789012",
        region: "us-west-1",
      },
    });
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      stack,
      "HostedZone",
      {
        hostedZoneId: "Z1234567890",
        zoneName: "support",
      },
    );
    const handler = importedHandler(stack, "Handler");
    const authorizerHandler = importedHandler(stack, "AuthorizerHandler");

    new HttpApi(stack, "HttpApi", {
      domain: ["fame", "support"],
      hostedZone,
      fameImageThumbHandler: handler,
      fameImageMosaicHandler: handler,
      flsImageThumbHandler: handler,
      flsImageMosaicHandler: handler,
      discordInteractionHandler: handler,
      famePoolStateAuthorizerHandler: authorizerHandler,
      famePoolStateHandler: handler,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /fame/pool-state",
      AuthorizationType: "CUSTOM",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /fame/pool-quotes",
      AuthorizationType: "CUSTOM",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      IdentitySource: ["$request.header.Authorization"],
    });
  });

  test("synthesizes pool-state-only dev stack without legacy app env", () => {
    const previousBaseRpcsJson = process.env.BASE_RPCS_JSON;
    const previousServiceToken = process.env.FAME_POOL_STATE_DEV_SERVICE_TOKEN;
    const previousMaintenanceMode =
      process.env.FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE;
    const previousTrustPromotion =
      process.env.FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION;
    const previousImageBaseHostJson = process.env.IMAGE_BASE_HOST_JSON;
    const previousDiscordAppId = process.env.DISCORD_APP_ID;
    const previousFarcasterAppId = process.env.FARCASTER_APP_ID;

    process.env.BASE_RPCS_JSON = JSON.stringify(["https://base.example"]);
    process.env.FAME_POOL_STATE_DEV_SERVICE_TOKEN = "unit-token";
    delete process.env.FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE;
    delete process.env.FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION;
    delete process.env.IMAGE_BASE_HOST_JSON;
    delete process.env.DISCORD_APP_ID;
    delete process.env.FARCASTER_APP_ID;

    try {
      const app = new cdk.App();
      const stack = new FamePoolStateDevStack(app, "BotPoolStateDev");
      const template = Template.fromStack(stack);

      template.resourceCountIs("AWS::DynamoDB::Table", 1);
      template.resourceCountIs("AWS::Lambda::Function", 3);
      template.resourceCountIs("AWS::Logs::LogGroup", 3);
      template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "POST /fame/pool-state",
        AuthorizationType: "CUSTOM",
      });
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "POST /fame/pool-quotes",
        AuthorizationType: "CUSTOM",
      });
      template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
        IdentitySource: ["$request.header.Authorization"],
      });
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE: "steady-state",
            FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION: "true",
          }),
        },
      });
      expectOutputMatching(template, "FamePoolApiDevBaseUrl");
      expectOutputMatching(template, "FamePoolStateDevEndpointUrl");
      expectOutputMatching(template, "FamePoolQuotesDevEndpointUrl");
    } finally {
      if (previousBaseRpcsJson === undefined) delete process.env.BASE_RPCS_JSON;
      else process.env.BASE_RPCS_JSON = previousBaseRpcsJson;
      if (previousServiceToken === undefined) {
        delete process.env.FAME_POOL_STATE_DEV_SERVICE_TOKEN;
      } else {
        process.env.FAME_POOL_STATE_DEV_SERVICE_TOKEN = previousServiceToken;
      }
      if (previousMaintenanceMode === undefined) {
        delete process.env.FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE;
      } else {
        process.env.FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE =
          previousMaintenanceMode;
      }
      if (previousTrustPromotion === undefined) {
        delete process.env.FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION;
      } else {
        process.env.FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION =
          previousTrustPromotion;
      }
      if (previousImageBaseHostJson === undefined) {
        delete process.env.IMAGE_BASE_HOST_JSON;
      } else {
        process.env.IMAGE_BASE_HOST_JSON = previousImageBaseHostJson;
      }
      if (previousDiscordAppId === undefined) delete process.env.DISCORD_APP_ID;
      else process.env.DISCORD_APP_ID = previousDiscordAppId;
      if (previousFarcasterAppId === undefined) {
        delete process.env.FARCASTER_APP_ID;
      } else {
        process.env.FARCASTER_APP_ID = previousFarcasterAppId;
      }
    }
  });

  test("deploy preflight fails before CDK when required config is empty", () => {
    const result = preflight({
      BASE_RPCS_JSON: JSON.stringify(["https://base.example"]),
      FAME_POOL_STATE_SERVICE_TOKEN: "",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAME_POOL_STATE_SERVICE_TOKEN");
  });

  test.each([
    ["invalid JSON", "not-json"],
    ["an empty RPC array", "[]"],
    ["a blank RPC URL", JSON.stringify([""])],
  ])("deploy preflight rejects %s", (_name, baseRpcsJson) => {
    const result = preflight({
      BASE_RPCS_JSON: baseRpcsJson,
      FAME_POOL_STATE_SERVICE_TOKEN: "unit-token",
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("BASE_RPCS_JSON");
  });

  test("deploy preflight accepts non-empty required config", () => {
    const result = preflight({
      BASE_RPCS_JSON: JSON.stringify(["https://base.example"]),
      FAME_POOL_STATE_SERVICE_TOKEN: "unit-token",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("fails fast when the service token is not configured", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    expect(
      () =>
        new FamePoolState(stack, "FamePoolState", {
          baseRpcsJson: JSON.stringify(["https://base.example"]),
          serviceToken: "",
        }),
    ).toThrow(/FAME_POOL_STATE_SERVICE_TOKEN must be configured/);
  });

  test("fails fast when Base RPC configuration is not configured", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    expect(
      () =>
        new FamePoolState(stack, "FamePoolState", {
          baseRpcsJson: "",
          serviceToken: "unit-token",
        }),
    ).toThrow(/BASE_RPCS_JSON must be configured/);
  });

  test.each([
    ["invalid JSON", "not-json", /BASE_RPCS_JSON must be valid JSON/],
    [
      "an empty RPC array",
      "[]",
      /BASE_RPCS_JSON must be a non-empty JSON array/,
    ],
    ["a blank RPC URL", JSON.stringify([""]), /BASE_RPCS_JSON\[0\]/],
  ])(
    "fails fast when Base RPC configuration is %s",
    (_name, baseRpcsJson, error) => {
      const app = new cdk.App();
      const stack = new cdk.Stack(app, "TestStack");

      expect(
        () =>
          new FamePoolState(stack, "FamePoolState", {
            baseRpcsJson,
            serviceToken: "unit-token",
          }),
      ).toThrow(error);
    },
  );

  test("keeps PR deploys isolated from the production service token and dev stack", () => {
    const workflow = readFileSync("../.github/workflows/pr-deploy.yml", "utf8");
    const preflightStep = workflow.indexOf(
      "Validate FAME pool-state deploy configuration",
    );
    const bootstrapStep = workflow.indexOf("Bootstrap CDK");

    expect(preflightStep).toBeGreaterThan(-1);
    expect(bootstrapStep).toBeGreaterThan(-1);
    expect(preflightStep).toBeLessThan(bootstrapStep);
    expect(workflow).toContain("FAME_POOL_STATE_PR_SERVICE_TOKEN");
    expect(workflow).toContain("FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE");
    expect(workflow).toContain("FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION");
    expect(workflow).not.toContain(
      "FAME_POOL_STATE_SERVICE_TOKEN: ${{ secrets.FAME_POOL_STATE_SERVICE_TOKEN }}",
    );
    expect(workflow).toContain(
      "STAGE: PR-${{ github.event.pull_request.number }}",
    );
    expect(workflow).toContain("cdk deploy --require-approval never --all");
    expect(workflow).toContain(
      'INFRA_STACK="Bot-PR-${{ github.event.pull_request.number }}"',
    );
    expect(workflow).toContain("aws cloudformation delete-stack");
    expect(workflow).not.toContain("-c stackName=PR-");
  });

  test("provides a PR-labeled dev deploy without using the production trigger", () => {
    const workflow = readFileSync("../.github/workflows/pr-deploy.yml", "utf8");

    expect(workflow).toContain("deploy-dev:");
    expect(workflow).toContain("DEPLOY_DEV");
    expect(workflow).toContain("STAGE: dev");
    expect(workflow).toContain("FAME_POOL_STATE_DEV_SERVICE_TOKEN");
    expect(workflow).toContain("FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE");
    expect(workflow).toContain("FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION");
    expect(workflow).toContain('ENABLE_EVENT_SCHEDULES: "false"');
    expect(workflow).toContain(
      'IMAGE_BASE_HOST_JSON: \'["dev","fame.support"]\'',
    );
    expect(workflow).toContain(
      'IMAGE_CORS_ALLOWED_ORIGINS_JSON: \'["https://dev.fame.support","http://localhost:3000"]\'',
    );
    expect(workflow).toContain("cdk deploy --require-approval never --all");
    expect(workflow).not.toContain("on:\n  push:\n    branches:\n      - main");
  });

  test("provides a pool-state-only dev deploy lane with only pool-state env", () => {
    const workflow = readFileSync("../.github/workflows/pr-deploy.yml", "utf8");
    const jobStart = workflow.indexOf("  deploy-pool-state-dev:");
    const nextJob = workflow.indexOf("\n  deploy:", jobStart);
    const job = workflow.slice(jobStart, nextJob);

    expect(jobStart).toBeGreaterThan(-1);
    expect(job).toContain("DEPLOY_POOL_STATE_DEV");
    expect(job).toContain('POOL_STATE_ONLY: "true"');
    expect(job).toContain("BASE_RPCS_JSON");
    expect(job).toContain("FAME_POOL_STATE_DEV_SERVICE_TOKEN");
    expect(job).toContain("FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE");
    expect(job).toContain("FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION");
    expect(job).toContain("run: cdk bootstrap");
    expect(job).not.toContain("CDK bootstrap already done or failed");
    expect(job).not.toContain("IMAGE_BASE_HOST_JSON");
    expect(job).not.toContain("DISCORD_APP_ID");
    expect(job).not.toContain("FARCASTER_APP_ID");
  });
});
