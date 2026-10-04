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

test("onboarding isolates credentials and seeds only the verified group before cutover", () => {
  const t = Template.fromStack(
    new BotConsoleStack(new cdk.App(), "FlsBotConsole", config),
  );
  const functions = t.findResources("AWS::Lambda::Function");
  const verifier = Object.values(functions).find(
    (f) => f.Properties.Handler === "verifier.verify",
  )!;
  expect(verifier.Properties.Environment.Variables).toHaveProperty(
    "TELEGRAM_TOKEN_ARN",
  );
  for (const handler of [
    "index.handler",
    "telegram.webhook",
    "telegram.worker",
  ]) {
    const f = Object.values(functions).find(
      (f) =>
        f.Properties.Handler === handler &&
        f.Properties.Environment?.Variables?.GROUP_TABLE,
    )!;
    expect(f.Properties.Environment.Variables).not.toHaveProperty(
      "TELEGRAM_TOKEN_ARN",
    );
    expect(f.Properties.Environment.Variables).toHaveProperty("GROUP_TABLE");
    expect(
      f.DependsOn.some((id: string) => id.startsWith("VerifiedTestGroup")),
    ).toBe(true);
  }
  const policies = Object.values(t.findResources("AWS::IAM::Policy"));
  const tokenPolicies = policies.filter((p) =>
    JSON.stringify(p.Properties.PolicyDocument).includes("telegram-verifier"),
  );
  expect(tokenPolicies).toHaveLength(1);
  expect(JSON.stringify(tokenPolicies[0].Properties.Roles)).toContain(
    "TelegramVerifierServiceRole",
  );
  const invokePolicies = policies.filter((p) =>
    JSON.stringify(p.Properties.PolicyDocument).includes(
      "lambda:InvokeFunction",
    ),
  );
  expect(invokePolicies).toHaveLength(1);
  expect(JSON.stringify(invokePolicies[0].Properties.Roles)).toContain(
    "ApiFunctionServiceRole",
  );
  const seed = Object.values(t.findResources("Custom::AWS")).find((r) =>
    JSON.stringify(r.Properties).includes("verified-fls-cutover"),
  )!;
  expect(JSON.stringify(seed.Properties.Create)).toContain("-1004423197212");
  expect(JSON.stringify(seed.Properties.Create)).toContain(
    "attribute_not_exists(pk)",
  );
  expect(seed.Properties.Update).toBeUndefined();
  expect(seed.Properties.Delete).toBeUndefined();
  t.resourceCountIs("AWS::DynamoDB::Table", 4);
});

test("access policy is retained, owner bootstrap is create-only, and only API gets the registry", () => {
  const t = Template.fromStack(
    new BotConsoleStack(new cdk.App(), "FlsBotConsole", config),
  );
  const tables = t.findResources("AWS::DynamoDB::Table");
  const access = Object.entries(tables).find(([id]) =>
    id.startsWith("Access"),
  )!;
  expect(access[1].DeletionPolicy).toBe("Retain");
  expect(
    access[1].Properties.PointInTimeRecoverySpecification
      .PointInTimeRecoveryEnabled,
  ).toBe(true);
  const resources = t.findResources("Custom::AWS");
  const bootstrap = Object.entries(resources).find(([id]) =>
    id.startsWith("AccessBootstrap"),
  )!;
  expect(JSON.stringify(bootstrap[1].Properties.Create)).toContain(
    "discord:931691901592145930",
  );
  expect(bootstrap[1].Properties.Update).toBeUndefined();
  expect(bootstrap[1].Properties.Delete).toBeUndefined();
  for (const [id, fn] of Object.entries(
    t.findResources("AWS::Lambda::Function"),
  )) {
    if (id.startsWith("ApiFunction"))
      expect(fn.Properties.Environment.Variables.ACCESS_TABLE).toEqual({
        Ref: access[0],
      });
    else
      expect(
        fn.Properties.Environment?.Variables?.ACCESS_TABLE,
      ).toBeUndefined();
  }
});
