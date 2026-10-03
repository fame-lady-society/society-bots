import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

// Operator-provisioned separately. The application CI role cannot update this stack.
export class BotConsoleAccessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const account = "590183914614";
    const assetBucket = `arn:aws:s3:::cdk-hnb659fds-assets-${account}-us-east-1`;
    const secret = `arn:aws:secretsmanager:us-east-1:${account}:secret:bot-console/auth-*`;
    const roles = `arn:aws:iam::${account}:role/FlsBotConsole-*`;
    const statement = (
      actions: string[],
      resources: string[],
      conditions?: Record<string, Record<string, unknown>>,
    ) => new iam.PolicyStatement({ actions, resources, conditions });
    const boundary = new iam.ManagedPolicy(this, "RuntimeBoundary", {
      managedPolicyName: "FlsBotConsoleRuntimeBoundary",
      statements: [
        statement(
          ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          [`arn:aws:logs:us-east-1:${account}:log-group:*`],
        ),
        statement(
          [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem",
            "dynamodb:UpdateItem",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:DescribeTable",
            "dynamodb:BatchGetItem",
            "dynamodb:BatchWriteItem",
          ],
          [`arn:aws:dynamodb:us-east-1:${account}:table/FlsBotConsole-*`],
        ),
        statement(
          ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
          [secret],
        ),
        statement(
          [
            "s3:GetObject*",
            "s3:GetBucket*",
            "s3:List*",
            "s3:PutObject",
            "s3:DeleteObject*",
            "s3:Abort*",
          ],
          ["arn:aws:s3:::flsbotconsole-*", "arn:aws:s3:::flsbotconsole-*/*"],
        ),
        statement(["s3:GetObject*"], [`${assetBucket}/bot-console/*`]),
        statement(["s3:GetBucketLocation", "s3:ListBucket"], [assetBucket]),
        statement(
          ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
          [`arn:aws:cloudfront::${account}:distribution/*`],
        ),
      ],
    });
    const execution = new iam.Role(this, "Execution", {
      roleName: "FlsBotConsoleExecution",
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
    });
    const executionStatements = [
      statement(
        ["s3:*"],
        ["arn:aws:s3:::flsbotconsole-*", "arn:aws:s3:::flsbotconsole-*/*"],
      ),
      statement(["s3:GetObject*"], [`${assetBucket}/bot-console/*`]),
      statement(["s3:GetBucketLocation", "s3:ListBucket"], [assetBucket]),
      statement(
        ["lambda:*"],
        [
          `arn:aws:lambda:us-east-1:${account}:function:FlsBotConsole-*`,
          `arn:aws:lambda:us-east-1:${account}:layer:FlsBotConsole-*`,
        ],
      ),
      statement(
        ["dynamodb:*"],
        [`arn:aws:dynamodb:us-east-1:${account}:table/FlsBotConsole-*`],
      ),
      statement(
        ["logs:*"],
        [
          `arn:aws:logs:us-east-1:${account}:log-group:FlsBotConsole-*`,
          `arn:aws:logs:us-east-1:${account}:log-group:/aws/lambda/FlsBotConsole-*`,
        ],
      ),
      statement(
        ["apigateway:*"],
        [
          "arn:aws:apigateway:us-east-1::/apis",
          "arn:aws:apigateway:us-east-1::/apis/*",
        ],
      ),
      statement(
        [
          "cloudfront:CreateDistribution",
          "cloudfront:CreateDistributionWithTags",
          "cloudfront:GetDistribution",
          "cloudfront:GetDistributionConfig",
          "cloudfront:UpdateDistribution",
          "cloudfront:DeleteDistribution",
          "cloudfront:CreateFunction",
          "cloudfront:DescribeFunction",
          "cloudfront:GetFunction",
          "cloudfront:UpdateFunction",
          "cloudfront:PublishFunction",
          "cloudfront:DeleteFunction",
          "cloudfront:CreateOriginAccessControl",
          "cloudfront:GetOriginAccessControl",
          "cloudfront:UpdateOriginAccessControl",
          "cloudfront:DeleteOriginAccessControl",
          "cloudfront:CreateResponseHeadersPolicy",
          "cloudfront:GetResponseHeadersPolicy",
          "cloudfront:UpdateResponseHeadersPolicy",
          "cloudfront:DeleteResponseHeadersPolicy",
          "cloudfront:TagResource",
          "cloudfront:UntagResource",
          "cloudfront:ListTagsForResource",
        ],
        ["*"],
      ),
      statement(
        [
          "acm:RequestCertificate",
          "acm:DescribeCertificate",
          "acm:DeleteCertificate",
          "acm:AddTagsToCertificate",
          "acm:RemoveTagsFromCertificate",
          "acm:ListTagsForCertificate",
        ],
        ["*"],
      ),
      statement(
        ["route53:GetHostedZone"],
        ["arn:aws:route53:::hostedzone/Z034031717ABI6HYEJD9J"],
      ),
      statement(["route53:GetChange"], ["arn:aws:route53:::change/*"]),
      statement(
        ["route53:ChangeResourceRecordSets"],
        ["arn:aws:route53:::hostedzone/Z034031717ABI6HYEJD9J"],
        {
          "ForAllValues:StringLike": {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames": [
              "bot.fame.support",
              "_*.bot.fame.support",
            ],
          },
        },
      ),
      statement(["secretsmanager:DescribeSecret"], [secret]),
      statement(["iam:CreateRole", "iam:PutRolePermissionsBoundary"], [roles], {
        StringEquals: { "iam:PermissionsBoundary": boundary.managedPolicyArn },
      }),
      statement(
        [
          "iam:GetRole",
          "iam:DeleteRole",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:GetRolePolicy",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
        ],
        [roles],
      ),
      statement(["iam:PassRole"], [roles], {
        StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" },
      }),
      statement(["iam:AttachRolePolicy", "iam:DetachRolePolicy"], [roles], {
        ArnEquals: {
          "iam:PolicyARN":
            "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        },
      }),
      statement(
        ["iam:GetPolicy", "iam:GetPolicyVersion"],
        [boundary.managedPolicyArn],
      ),
    ];
    new iam.Policy(this, "ExecutionPolicy", {
      roles: [execution],
      statements: executionStatements,
    });
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHub",
      `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const ci = new iam.Role(this, "Deploy", {
      roleName: "FlsBotConsoleGitHubDeploy",
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub":
            "repo:fame-lady-society/society-bots:environment:bot-console-production",
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    new iam.Policy(this, "DeployPolicy", {
      roles: [ci],
      statements: [
        statement(
          [
            "cloudformation:CreateStack",
            "cloudformation:UpdateStack",
            "cloudformation:DescribeStacks",
            "cloudformation:DescribeStackEvents",
            "cloudformation:GetTemplate",
            "cloudformation:CreateChangeSet",
            "cloudformation:DescribeChangeSet",
            "cloudformation:ExecuteChangeSet",
            "cloudformation:DeleteChangeSet",
            "cloudformation:GetTemplateSummary",
            "cloudformation:ListStackResources",
            "cloudformation:ContinueUpdateRollback",
          ],
          [`arn:aws:cloudformation:us-east-1:${account}:stack/FlsBotConsole/*`],
        ),
        statement(["cloudformation:ValidateTemplate"], ["*"]),
        statement(["iam:PassRole"], [execution.roleArn], {
          StringEquals: {
            "iam:PassedToService": "cloudformation.amazonaws.com",
          },
        }),
        statement(
          ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
          [`${assetBucket}/bot-console/*`],
        ),
        statement(["s3:GetBucketLocation", "s3:ListBucket"], [assetBucket]),
        statement(["secretsmanager:DescribeSecret"], [secret]),
        statement(["s3:GetEncryptionConfiguration"], [assetBucket]),
        statement(
          ["ssm:GetParameter"],
          [
            `arn:aws:ssm:us-east-1:${account}:parameter/cdk-bootstrap/hnb659fds/version`,
          ],
        ),
      ],
    });
    new cdk.CfnOutput(this, "DeployRoleArn", { value: ci.roleArn });
  }
}
