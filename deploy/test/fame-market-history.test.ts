import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import {
  FameMarketHistory,
  bundleHistoryCollector,
} from "../lib/fame-market-history.js";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

test("real bundled Lambda imports its registry and SDK under Node ESM", () => {
  const bundle = bundleHistoryCollector();
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
});

test("history deploy is retained, private, bounded, and independent of bot stacks", () => {
  const stack = new cdk.Stack(new cdk.App(), "HistoryTest");
  new FameMarketHistory(stack, "History", {
    rpcParameterName: "/society/history/rpc",
    startBlock: 100,
    dailyRequests: 1000,
    poolStateTableName: "existing-pool-state",
  });
  const template = Template.fromStack(stack);
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
        FAME_HISTORY_DAILY_REQUESTS: "1000",
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
  template.resourceCountIs("AWS::Lambda::Function", 2);
});

test("deployment rejects an implicit starting point or budget", () => {
  expect(
    () =>
      new FameMarketHistory(
        new cdk.Stack(new cdk.App(), "Invalid"),
        "History",
        {
          rpcParameterName: "/rpc",
          startBlock: 0,
          dailyRequests: 100,
          poolStateTableName: "pool",
        },
      ),
  ).toThrow("startBlock");
});
