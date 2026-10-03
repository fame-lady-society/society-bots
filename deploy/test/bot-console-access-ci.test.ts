import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BotConsoleAccessCiStack } from "../lib/bot-console-access-ci-stack.js";

test("access CI cannot modify its own authority", () => {
  const t = Template.fromStack(new BotConsoleAccessCiStack(new cdk.App(), "FlsBotConsoleAccessCi", {
    env: { account: "590183914614", region: "us-east-1" },
  }));
  const deploy = Object.values(t.findResources("AWS::IAM::Role")).find(r => r.Properties.RoleName === "FlsBotConsoleAccessGitHubDeploy")!;
  expect(deploy.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals).toEqual({
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:fame-lady-society/society-bots:environment:bot-console-access-production",
  });
  const policies = t.findResources("AWS::IAM::Policy");
  const execution = Object.entries(policies).find(([id]) => id.startsWith("Execution"))![1];
  expect(execution.Properties.PolicyDocument.Statement.flatMap((s: {Resource: string | string[]}) => s.Resource).sort()).toEqual([
    "arn:aws:iam::590183914614:policy/FlsBotConsoleRuntimeBoundary",
    "arn:aws:iam::590183914614:role/FlsBotConsoleExecution",
    "arn:aws:iam::590183914614:role/FlsBotConsoleGitHubDeploy",
  ]);
  const policy = Object.entries(policies).find(([id]) => id.startsWith("Deploy"))![1];
  expect(policy.Properties.PolicyDocument.Statement[0].Resource).toBe("arn:aws:cloudformation:us-east-1:590183914614:stack/FlsBotConsoleAccess/*");
  expect(policy.Properties.PolicyDocument.Statement[2].Condition.StringEquals).toEqual({"iam:PassedToService": "cloudformation.amazonaws.com"});
  expect(JSON.stringify(policies)).not.toMatch(/secretsmanager|sts:AssumeRole|iam:\*/);
});
