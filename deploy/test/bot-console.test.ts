import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "node:path";
import { BotConsoleStack } from "../lib/bot-console-stack.js";
const config = {
  env: { account: "590183914614", region: "us-east-1" },
  authSecretArn:
    "arn:aws:secretsmanager:us-east-1:590183914614:secret:bot-console/auth-AbCdEf",
  appDirectory: path.resolve("../apps/bot-console"),
};
test("isolated static console has private storage and uncached authenticated API", () => {
  const t = Template.fromStack(
    new BotConsoleStack(new cdk.App(), "Test", config),
  );
  t.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  t.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs24.x",
    ReservedConcurrentExecutions: 5,
    Environment: {
      Variables: Match.objectLike({ AUTH_SECRET_ARN: config.authSecretArn }),
    },
  });
  t.hasResourceProperties("AWS::Route53::RecordSet", {
    Name: "bot.fame.support.",
    HostedZoneId: "Z034031717ABI6HYEJD9J",
  });
  t.hasResourceProperties("AWS::DynamoDB::Table", {
    TimeToLiveSpecification: { AttributeName: "expires", Enabled: true },
  });
  t.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: {
      CacheBehaviors: Match.arrayWith([
        Match.objectLike({
          PathPattern: "/api/*",
          CachePolicyId:
            cdk.aws_cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
        }),
      ]),
    },
  });
  const template = JSON.stringify(t.toJSON());
  expect(template).not.toContain("DISCORD_BOT_TOKEN");
  expect(template).not.toContain("TELEGRAM_BOT_TOKEN");
});
test("rejects auth secret from another account or service", () => {
  expect(
    () =>
      new BotConsoleStack(new cdk.App(), "Bad", {
        ...config,
        authSecretArn:
          "arn:aws:secretsmanager:us-east-1:167146046754:secret:other-AbCdEf",
      }),
  ).toThrow("dedicated FLS");
});

test("every generated application role has the console runtime boundary", () => {
  const t = Template.fromStack(
    new BotConsoleStack(new cdk.App(), "FlsBotConsole", config),
  );
  const roles = t.findResources("AWS::IAM::Role");
  expect(Object.keys(roles).length).toBeGreaterThan(0);
  for (const role of Object.values(roles)) {
    expect(role.Properties.PermissionsBoundary).toBe(
      "arn:aws:iam::590183914614:policy/FlsBotConsoleRuntimeBoundary",
    );
  }
});

test("Telegram receiver is separate from operator auth and persists through a recovery queue", () => {
  const t = Template.fromStack(
    new BotConsoleStack(new cdk.App(), "FlsBotConsole", config),
  );
  t.resourceCountIs("AWS::SQS::Queue", 2);
  t.hasResourceProperties("AWS::SecretsManager::Secret", {
    Name: "bot-console/telegram-receiver",
    GenerateSecretString: Match.objectLike({
      GenerateStringKey: "webhookSecret",
    }),
  });
  t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
    RouteKey: "POST /api/telegram/webhook",
  });
  t.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
    FunctionResponseTypes: ["ReportBatchItemFailures"],
  });
  t.hasResourceProperties("AWS::DynamoDB::Table", {
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  });
  const functions = Object.values(t.findResources("AWS::Lambda::Function"));
  for (const handler of ["telegram.webhook", "telegram.worker"]) {
    const f = functions.find((f) => f.Properties.Handler === handler)!;
    expect(f.Properties.Environment.Variables).not.toHaveProperty(
      "AUTH_SECRET_ARN",
    );
    expect(f.Properties.Environment.Variables).not.toHaveProperty(
      "TELEGRAM_BOT_TOKEN",
    );
  }
});
