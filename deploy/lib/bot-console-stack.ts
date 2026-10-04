import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as distribution from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as deployment from "aws-cdk-lib/aws-s3-deployment";
import * as path from "node:path";
import * as iam from "aws-cdk-lib/aws-iam";
import * as custom from "aws-cdk-lib/custom-resources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
export interface BotConsoleProps extends cdk.StackProps {
  authSecretArn: string;
  appDirectory: string;
}
export class BotConsoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BotConsoleProps) {
    super(scope, id, props);
    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyArn(
        this,
        "RuntimeBoundary",
        "arn:aws:iam::590183914614:policy/FlsBotConsoleRuntimeBoundary",
      ),
    );
    if (
      !/^arn:aws:secretsmanager:us-east-1:590183914614:secret:bot-console\//.test(
        props.authSecretArn,
      )
    )
      throw new Error(
        "Bot console requires its dedicated FLS us-east-1 auth secret",
      );
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: "Z034031717ABI6HYEJD9J",
      zoneName: "fame.support",
    });
    const cert = new acm.Certificate(this, "Certificate", {
      domainName: "bot.fame.support",
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const bucket = new s3.Bucket(this, "Web", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const sessions = new dynamodb.Table(this, "Sessions", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires",
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const access = new dynamodb.Table(this, "Access", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    const accessSeed = new custom.AwsCustomResource(this, "AccessBootstrap", {
      installLatestAwsSdk: false,
      onCreate: {
        service: "DynamoDB",
        action: "putItem",
        parameters: {
          TableName: access.tableName,
          Item: {
            pk: { S: "policy" },
            sk: { S: "current" },
            version: { N: "0" },
            value: {
              M: {
                version: { N: "0" },
                principals: {
                  L: [
                    {
                      M: {
                        id: { S: "discord:931691901592145930" },
                        kind: { S: "human" },
                        name: { S: "Flick" },
                        enabled: { BOOL: true },
                        sessionVersion: { N: "0" },
                        grants: {
                          L: [
                            { M: { role: { S: "owner" }, scope: { S: "*" } } },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
        physicalResourceId: custom.PhysicalResourceId.of(
          "portal-owner-bootstrap",
        ),
        ignoreErrorCodesMatching: "ConditionalCheckFailedException",
      },
      policy: custom.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem"],
          resources: [access.tableArn],
        }),
      ]),
    });
    const auth = secrets.Secret.fromSecretCompleteArn(
      this,
      "Auth",
      props.authSecretArn,
    );
    const apiFunction = new lambda.Function(this, "ApiFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(props.appDirectory, "dist-api")),
      handler: "index.handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(20),
      reservedConcurrentExecutions: 5,
      environment: {
        SESSION_TABLE: sessions.tableName,
        ACCESS_TABLE: access.tableName,
        AUTH_SECRET_ARN: auth.secretArn,
        OPERATOR_STATUS_TABLE: "OverclawLeader-OperatorStatus",
        OPERATOR_STATUS_REGION: "us-west-1",
        RUNTIME_WAKE_ARN:
          "arn:aws:lambda:us-west-1:590183914614:function:OverclawLeader-console-wake",
      },
      logGroup: new logs.LogGroup(this, "ApiLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    access.grantReadWriteData(apiFunction);
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [
          "arn:aws:dynamodb:us-west-1:590183914614:table/OverclawLeader-OperatorStatus",
        ],
        conditions: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": ["runtime:overclaw-leader"],
          },
          Null: { "dynamodb:LeadingKeys": "false" },
        },
      }),
    );
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          "arn:aws:lambda:us-west-1:590183914614:function:OverclawLeader-console-wake",
        ],
      }),
    );
    apiFunction.node.addDependency(accessSeed);
    sessions.grantReadWriteData(apiFunction);
    auth.grantRead(apiFunction);
    const api = new apigw.HttpApi(this, "Api", {
      defaultIntegration: new HttpLambdaIntegration("ConsoleApi", apiFunction),
    });
    const messages = new dynamodb.Table(this, "Messages", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    const groups = new dynamodb.Table(this, "TelegramGroups", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    // Explicit cutover seed for the operator-verified test group. Create-only:
    // future deploys and rollback never reactivate a disconnected group.
    const seed = new custom.AwsCustomResource(this, "VerifiedTestGroup", {
      installLatestAwsSdk: false,
      onCreate: {
        service: "DynamoDB",
        action: "putItem",
        parameters: {
          TableName: groups.tableName,
          Item: {
            pk: { S: "groups" },
            sk: { S: "-1004423197212" },
            id: { S: "-1004423197212" },
            name: { S: "FLS Bot" },
            state: { S: "active" },
            requestId: { S: "verified-fls-cutover" },
            requestedBy: { S: "5835157950" },
            createdBy: { S: "931691901592145930" },
            updatedBy: { S: "931691901592145930" },
            requestedAt: { N: "1791055329" },
            updatedAt: { N: "1791055329" },
            activatedAt: { N: "0" },
            associationId: { S: "verified-fls-cutover" },
            hasHistory: { BOOL: true },
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
        physicalResourceId: custom.PhysicalResourceId.of(
          "verified-fls-cutover",
        ),
        ignoreErrorCodesMatching: "ConditionalCheckFailedException",
      },
      policy: custom.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ["dynamodb:PutItem"],
          resources: [groups.tableArn],
        }),
      ]),
    });
    const token = secrets.Secret.fromSecretNameV2(
      this,
      "TelegramVerifierToken",
      "bot-console/telegram-verifier",
    );
    const verifier = new lambda.Function(this, "TelegramVerifier", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(props.appDirectory, "dist-api")),
      handler: "verifier.verify",
      timeout: cdk.Duration.seconds(12),
      memorySize: 256,
      reservedConcurrentExecutions: 2,
      environment: { TELEGRAM_TOKEN_ARN: token.secretArn },
      logGroup: new logs.LogGroup(this, "TelegramVerifierLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    });
    token.grantRead(verifier);
    verifier.grantInvoke(apiFunction);
    apiFunction.addEnvironment("TELEGRAM_VERIFIER_ARN", verifier.functionArn);
    apiFunction.addEnvironment("GROUP_TABLE", groups.tableName);
    groups.grantReadWriteData(apiFunction);
    apiFunction.node.addDependency(seed);
    const telegram = new secrets.Secret(this, "TelegramConfig", {
      secretName: "bot-console/telegram-receiver",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          botId: "7393738833",
          username: "famesocietybot",
          // Keep this creation template stable: changing it rotates the live webhook secret.
          // Group authorization now lives exclusively in TelegramGroups.
          chats: [],
        }),
        generateStringKey: "webhookSecret",
        passwordLength: 48,
        excludePunctuation: true,
      },
    });
    const failed = new sqs.Queue(this, "TelegramFailed", {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const incoming = new sqs.Queue(this, "TelegramIncoming", {
      visibilityTimeout: cdk.Duration.seconds(120),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: failed, maxReceiveCount: 5 },
    });
    const receiver = new lambda.Function(this, "TelegramReceiver", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(props.appDirectory, "dist-api")),
      handler: "telegram.webhook",
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        TELEGRAM_CONFIG_ARN: telegram.secretArn,
        INGEST_QUEUE_URL: incoming.queueUrl,
        GROUP_TABLE: groups.tableName,
      },
      logGroup: new logs.LogGroup(this, "TelegramReceiverLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    });
    const worker = new lambda.Function(this, "TelegramWriter", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(path.join(props.appDirectory, "dist-api")),
      handler: "telegram.worker",
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
      environment: {
        GROUP_TABLE: groups.tableName,
        MESSAGE_TABLE: messages.tableName,
      },
      logGroup: new logs.LogGroup(this, "TelegramWriterLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    });
    worker.addEventSource(
      new SqsEventSource(incoming, {
        batchSize: 5,
        reportBatchItemFailures: true,
      }),
    );
    telegram.grantRead(receiver);
    groups.grantReadWriteData(receiver);
    groups.grantReadData(worker);
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:ConditionCheckItem"],
        resources: [groups.tableArn],
      }),
    );
    receiver.node.addDependency(seed);
    worker.node.addDependency(seed);
    telegram.grantRead(apiFunction);
    incoming.grantSendMessages(receiver);
    messages.grantWriteData(worker);
    messages.grantReadData(apiFunction);
    apiFunction.addEnvironment("MESSAGE_TABLE", messages.tableName);
    apiFunction.addEnvironment("TELEGRAM_CONFIG_ARN", telegram.secretArn);
    apiFunction.addEnvironment("INGEST_QUEUE_URL", incoming.queueUrl);
    apiFunction.addEnvironment("DEAD_LETTER_QUEUE_URL", failed.queueUrl);
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:GetQueueAttributes"],
        resources: [incoming.queueArn, failed.queueArn],
      }),
    );
    api.addRoutes({
      path: "/api/telegram/webhook",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("TelegramWebhook", receiver),
    });
    const defaultStage = api.defaultStage?.node.defaultChild as apigw.CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10,
    };
    const paths = new distribution.Function(this, "SpaPaths", {
      code: distribution.FunctionCode.fromInline(
        'function handler(event) { var r = event.request; if (r.uri.indexOf(".") === -1) r.uri = "/index.html"; return r; }',
      ),
    });
    const headers = new distribution.ResponseHeadersPolicy(this, "Headers", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy:
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: distribution.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: distribution.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: false,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "X-Robots-Tag",
            value: "noindex, nofollow",
            override: true,
          },
        ],
      },
    });
    const cdn = new distribution.Distribution(this, "Distribution", {
      domainNames: ["bot.fame.support"],
      certificate: cert,
      defaultRootObject: "index.html",
      minimumProtocolVersion: distribution.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy:
          distribution.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: distribution.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: headers,
        functionAssociations: [
          {
            function: paths,
            eventType: distribution.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(
            cdk.Fn.select(2, cdk.Fn.split("/", api.apiEndpoint)),
          ),
          allowedMethods: distribution.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: distribution.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: distribution.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            distribution.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    });
    new route53.ARecord(this, "Dns", {
      zone,
      recordName: "bot",
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(cdn)),
    });
    new deployment.BucketDeployment(this, "Publish", {
      sources: [deployment.Source.asset(path.join(props.appDirectory, "dist"))],
      destinationBucket: bucket,
      distribution: cdn,
      distributionPaths: ["/*"],
      prune: true,
    });
    new cdk.CfnOutput(this, "TelegramGroupTable", { value: groups.tableName });
    new cdk.CfnOutput(this, "Url", { value: "https://bot.fame.support" });
  }
}
