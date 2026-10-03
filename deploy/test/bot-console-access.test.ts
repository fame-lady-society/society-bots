import * as cdk from "aws-cdk-lib";
import * as path from "node:path";
import { BotConsoleStack } from "../lib/bot-console-stack.js";
import { Template } from "aws-cdk-lib/assertions";
import { BotConsoleAccessStack } from "../lib/bot-console-access-stack.js";

test("CI cannot read credentials, manage IAM, or deploy its access stack", () => {
  const t = Template.fromStack(
    new BotConsoleAccessStack(new cdk.App(), "FlsBotConsoleAccess", {
      env: { account: "590183914614", region: "us-east-1" },
    }),
  );
  const roles = Object.values(t.findResources("AWS::IAM::Role"));
  const deploy = roles.find(
    (r) => r.Properties.RoleName === "FlsBotConsoleGitHubDeploy",
  )!;
  expect(
    deploy.Properties.AssumeRolePolicyDocument.Statement[0].Condition
      .StringEquals,
  ).toEqual({
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub":
      "repo:fame-lady-society/society-bots:environment:bot-console-production",
  });
  const policies = t.findResources("AWS::IAM::Policy");
  const policy = Object.entries(policies).find(([id]) =>
    id.startsWith("DeployPolicy"),
  )![1];
  const json = JSON.stringify(policy.Properties.PolicyDocument);
  expect(json).not.toContain("GetSecretValue");
  expect(json).not.toContain("iam:Create");
  expect(json).not.toContain("sts:AssumeRole");
  expect(json).toContain("stack/FlsBotConsole/*");
  expect(json).not.toContain("stack/FlsBotConsoleAccess");
});

test("execution policy allows CDK's unprefixed publishing layer only", () => {
  const t = Template.fromStack(
    new BotConsoleAccessStack(new cdk.App(), "FlsBotConsoleAccess", {
      env: { account: "590183914614", region: "us-east-1" },
    }),
  );
  const policies = t.findResources("AWS::IAM::Policy");
  const policy = Object.entries(policies).find(([id]) =>
    id.startsWith("ExecutionPolicy"),
  )![1];
  const layer = policy.Properties.PolicyDocument.Statement.find(
    (s: { Action: string[] }) =>
      s.Action.includes("lambda:PublishLayerVersion"),
  );
  const application = Template.fromStack(
    new BotConsoleStack(new cdk.App(), "FlsBotConsole", {
      env: { account: "590183914614", region: "us-east-1" },
      authSecretArn:
        "arn:aws:secretsmanager:us-east-1:590183914614:secret:bot-console/auth-AbCdEf",
      appDirectory: path.resolve("../apps/bot-console"),
    }),
  );
  const layers = Object.entries(
    application.findResources("AWS::Lambda::LayerVersion"),
  );
  expect(layers).toHaveLength(1);
  const [logicalId, resource] = layers[0];
  const name = resource.Properties.LayerName ?? logicalId;
  expect(layer.Resource).toEqual([
    `arn:aws:lambda:us-east-1:590183914614:layer:${name}`,
    `arn:aws:lambda:us-east-1:590183914614:layer:${name}:*`,
  ]);
});
