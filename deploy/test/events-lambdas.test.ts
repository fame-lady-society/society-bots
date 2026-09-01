import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { EventLambdas } from "../lib/events-lambdas.js";

const props = {
  baseRpcsJson: JSON.stringify(["https://base.example"]),
  sepoliaRpcsJson: JSON.stringify(["https://sepolia.example"]),
  mainnetRpcsJson: JSON.stringify(["https://mainnet.example"]),
  domain: ["events", "example.com"] as [string, string],
  discordChannelId: "discord-channel",
  discordAppId: "discord-app",
  discordBotToken: "discord-token",
  discordPublicKey: "discord-public-key",
};

describe("Event Lambda infrastructure", () => {
  it("serializes the wrapper and profile event worker", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    new EventLambdas(stack, "EventLambdas", { ...props, enableSchedules: false });
    const template = Template.fromStack(stack);

    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 1,
      Environment: {
        Variables: Match.objectLike({
          DYNAMODB_TABLE: Match.anyValue(),
          IMAGE_HOST: "events.example.com",
          MAINNET_RPCS_JSON: props.mainnetRpcsJson,
        }),
      },
    });
  });

  it("is absent unless explicitly enabled", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    new EventLambdas(stack, "EventLambdas", { ...props, enableSchedules: false });
    const template = Template.fromStack(stack);
    expect(JSON.stringify(template.toJSON())).not.toContain("OPENSEA_API_KEY");
    template.resourceCountIs("AWS::DynamoDB::Table", 3);
  });

  it("creates an isolated one-concurrency scheduled worker only when enabled", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");
    new EventLambdas(stack, "EventLambdas", {
      ...props,
      enableSchedules: false,
      enableMetadataRefresh: true,
      openSeaApiKey: "unit-key",
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 1,
      Environment: {
        Variables: Match.objectLike({
          DYNAMODB_FAME_METADATA_REFRESH_TABLE_NAME: Match.anyValue(),
          MAINNET_RPCS_JSON: props.mainnetRpcsJson,
        }),
      },
    });
    template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(4 minutes)" });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FunctionResponseTypes: ["ReportBatchItemFailures"],
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      VisibilityTimeout: 180,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
  });

  it("fails synthesis when metadata refresh is enabled without an OpenSea key", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    expect(() => new EventLambdas(stack, "EventLambdas", {
      ...props,
      enableSchedules: false,
      enableMetadataRefresh: true,
    })).toThrow("OPENSEA_API_KEY is required when metadata refresh is enabled");
  });
});
