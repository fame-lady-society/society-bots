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

test("runtime boundary grants only verifier and exact Wake invocation", () => {
  const t = Template.fromStack(
    new BotConsoleAccessStack(new cdk.App(), "FlsBotConsoleAccess", {
      env: { account: "590183914614", region: "us-east-1" },
    }),
  );
  const boundary = Object.values(t.findResources("AWS::IAM::ManagedPolicy"))[0]
    .Properties.PolicyDocument.Statement;
  const invoke = boundary.find((s: { Action: string | string[] }) =>
    [s.Action].flat().includes("lambda:InvokeFunction"),
  );
  expect(invoke.Resource).toEqual([
    "arn:aws:lambda:us-east-1:590183914614:function:FlsBotConsole-TelegramVerifier*",
    "arn:aws:lambda:us-west-1:590183914614:function:OverclawLeader-console-wake",
  ]);
  expect(JSON.stringify(boundary)).toContain("dynamodb:ConditionCheckItem");
  const policy = Object.entries(t.findResources("AWS::IAM::Policy")).find(
    ([id]) => id.startsWith("ExecutionPolicy"),
  )![1];
  expect(JSON.stringify(policy.Properties.PolicyDocument)).not.toContain(
    "telegram-verifier",
  );
});

test("runtime boundary permits only the exact Overclaw status item in the producer region", () => {
  const t = Template.fromStack(
    new BotConsoleAccessStack(new cdk.App(), "FlsBotConsoleAccess", {
      env: { account: "590183914614", region: "us-east-1" },
    }),
  );
  const statements = Object.values(
    t.findResources("AWS::IAM::ManagedPolicy"),
  )[0].Properties.PolicyDocument.Statement;
  const crossRegion = statements.filter((s: { Resource: unknown }) =>
    JSON.stringify(s.Resource).includes("OverclawLeader-OperatorStatus"),
  );
  expect(crossRegion).toEqual([
    {
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource:
        "arn:aws:dynamodb:us-west-1:590183914614:table/OverclawLeader-OperatorStatus",
      Condition: {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["runtime:overclaw-leader"],
        },
        Null: { "dynamodb:LeadingKeys": "false" },
      },
    },
  ]);
});
