import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import {
  FameMarketHistory,
  bundleHistoryCollector,
  bundleHistoryReader,
} from "../lib/fame-market-history.js";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

test.each([bundleHistoryCollector, bundleHistoryReader])(
  "real bundled Lambda imports its registry and SDK under Node ESM",
  (bundleFunction) => {
    const bundle = bundleFunction();
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {handler}=await import(${JSON.stringify(pathToFileURL(path.join(bundle, "index.mjs")).href)}); if(typeof handler !== 'function') process.exit(1);`,
      ],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  },
);

test("history deploy is retained, private, bounded, and independent of bot stacks", () => {
  const stack = new cdk.Stack(new cdk.App(), "HistoryTest");
  new FameMarketHistory(stack, "History", {
    rpcParameterName: "/society/history/rpc",
    startBlock: 100,
    poolStateTableName: "existing-pool-state",
    apiId: "existing-api",
    authorizerId: "existing-authorizer",
  });
  const template = Template.fromStack(stack);
  const startOutput = Object.entries(template.toJSON().Outputs).find(([id]) =>
    id.includes("StartBlock"),
  )?.[1];
  expect(startOutput).toEqual({ Value: "100" });
  template.hasResource("AWS::S3::Bucket", {
    DeletionPolicy: "Retain",
    Properties: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    },
  });
  template.hasResource("AWS::DynamoDB::Table", {
    DeletionPolicy: "Retain",
    Properties: { BillingMode: "PAY_PER_REQUEST" },
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 300,
    MemorySize: 512,
    ReservedConcurrentExecutions: 1,
    Environment: {
      Variables: Match.objectLike({
        FAME_HISTORY_START_BLOCK: "100",
        FAME_HISTORY_RPC_PARAMETER: "/society/history/rpc",
      }),
    },
  });
  template.hasResourceProperties("AWS::Events::Rule", {
    ScheduleExpression: "rate(5 minutes)",
  });
  template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
    MaximumRetryAttempts: 0,
  });
  template.resourceCountIs("AWS::EC2::NatGateway", 0);
  template.hasResourceProperties("AWS::Lambda::Function", {
    PackageType: "Image",
    Timeout: 120,
    MemorySize: 512,
    ReservedConcurrentExecutions: 1,
  });
  template.hasResourceProperties("AWS::Events::Rule", {
    ScheduleExpression: "rate(1 minute)",
  });
  template.resourceCountIs("AWS::Lambda::Function", 3);
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    ApiId: "existing-api",
    RouteKey: "GET /fame/history",
    AuthorizationType: "CUSTOM",
    AuthorizerId: "existing-authorizer",
  });
  template.resourceCountIs("AWS::ApiGatewayV2::Stage", 0);
  template.resourceCountIs("AWS::Lambda::Url", 0);
  const functions = template.findResources("AWS::Lambda::Function");
  const [readerId, reader] = Object.entries(functions).find(([id]) =>
    id.includes("Reader"),
  )!;
  const roleId = reader.Properties.Role["Fn::GetAtt"][0];
  const [tableId] = Object.keys(template.findResources("AWS::DynamoDB::Table"));
  const policies = Object.values(
    template.findResources("AWS::IAM::Policy"),
  ).filter((p) =>
    p.Properties.Roles.some((r: { Ref: string }) => r.Ref === roleId),
  );
  const statements = policies.flatMap(
    (p) => p.Properties.PolicyDocument.Statement,
  );
  const dataStatements = statements.filter((s) =>
    JSON.stringify(s.Action).includes("dynamodb:"),
  );
  expect(dataStatements).toEqual([
    {
      Action: "dynamodb:Query",
      Effect: "Allow",
      Resource: { "Fn::GetAtt": [tableId, "Arn"] },
    },
    {
      Action: "dynamodb:GetItem",
      Effect: "Allow",
      Resource: { "Fn::GetAtt": [tableId, "Arn"] },
      Condition: {
        StringEquals: { "dynamodb:EnclosingOperation": "TransactGetItems" },
      },
    },
  ]);
  expect(
    statements.every((s) =>
      [s.Action]
        .flat()
        .every(
          (a: string) => a.startsWith("dynamodb:") || a.startsWith("logs:"),
        ),
    ),
  ).toBe(true);
  const permission = Object.values(
    template.findResources("AWS::Lambda::Permission"),
  ).find((p) => p.Properties.FunctionName?.["Fn::GetAtt"]?.[0] === readerId)!;
  expect(permission.Properties.Principal).toBe("apigateway.amazonaws.com");
  expect(permission.Properties.SourceArn).toEqual({
    "Fn::Join": [
      "",
      [
        "arn:",
        { Ref: "AWS::Partition" },
        ":execute-api:",
        { Ref: "AWS::Region" },
        ":",
        { Ref: "AWS::AccountId" },
        ":existing-api/*/GET/fame/history",
      ],
    ],
  });
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: "dynamodb:GetItem",
          Condition: {
            StringEquals: { "dynamodb:EnclosingOperation": "TransactGetItems" },
          },
        }),
      ]),
    },
  });
  template.resourceCountIs("AWS::CloudWatch::Dashboard", 0);
  template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  template.resourceCountIs("AWS::Logs::MetricFilter", 0);
  expect(JSON.stringify(template.toJSON())).not.toContain(
    "FAME_HISTORY_DAILY_REQUESTS",
  );
});

test("deployment rejects an implicit starting point", () => {
  expect(
    () =>
      new FameMarketHistory(
        new cdk.Stack(new cdk.App(), "Invalid"),
        "History",
        {
          rpcParameterName: "/rpc",
          startBlock: 0,
          poolStateTableName: "pool",
          apiId: "api",
          authorizerId: "auth",
        },
      ),
  ).toThrow("startBlock");
});
