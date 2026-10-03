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
