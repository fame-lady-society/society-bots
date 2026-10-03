import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

// One-time operator bootstrap. Neither console workflow can modify this stack.
export class BotConsoleAccessCiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const account = "590183914614";
    const execution = new iam.Role(this, "Execution", {
      roleName: "FlsBotConsoleAccessExecution",
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
    });
    execution.addToPolicy(new iam.PolicyStatement({
      actions: [
        "iam:GetRole", "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole",
        "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole",
        "iam:GetRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      ],
      resources: ["FlsBotConsoleExecution", "FlsBotConsoleGitHubDeploy"].map(
        name => `arn:aws:iam::${account}:role/${name}`,
      ),
    }));
    execution.addToPolicy(new iam.PolicyStatement({
      actions: [
        "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy",
        "iam:GetPolicyVersion", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion",
        "iam:ListPolicyVersions", "iam:SetDefaultPolicyVersion", "iam:TagPolicy", "iam:UntagPolicy",
      ],
      resources: [`arn:aws:iam::${account}:policy/FlsBotConsoleRuntimeBoundary`],
    }));
    const deploy = new iam.Role(this, "Deploy", {
      roleName: "FlsBotConsoleAccessGitHubDeploy",
      assumedBy: new iam.FederatedPrincipal(
        `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`,
        { StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub":
            "repo:fame-lady-society/society-bots:environment:bot-console-access-production",
        } },
        "sts:AssumeRoleWithWebIdentity",
      ),
    });
    deploy.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:GetTemplate", "cloudformation:GetTemplateSummary"],
      resources: [`arn:aws:cloudformation:us-east-1:${account}:stack/FlsBotConsoleAccess/*`],
    }));
    deploy.addToPolicy(new iam.PolicyStatement({
      actions: ["cloudformation:CreateChangeSet"],
      resources: [`arn:aws:cloudformation:us-east-1:${account}:stack/FlsBotConsoleAccess/*`],
      conditions: { StringEquals: { "cloudformation:RoleArn": execution.roleArn } },
    }));
    deploy.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:PassRole"], resources: [execution.roleArn],
      conditions: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
    }));
    new cdk.CfnOutput(this, "DeployRoleArn", { value: deploy.roleArn });
    new cdk.CfnOutput(this, "ExecutionRoleArn", { value: execution.roleArn });
  }
}
