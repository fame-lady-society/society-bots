import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { readdirSync, readFileSync } from "fs";
import { EventLambdas } from "../lib/events-lambdas.js";
import { FamePoolState } from "../lib/fame-pool-state.js";
import { ImageLambdas } from "../lib/image-lambdas.js";
import { createLambdaLogGroup } from "../lib/lambda-log-groups.js";

interface CfnResource {
  readonly DeletionPolicy?: string;
  readonly Properties?: Record<string, unknown>;
  readonly UpdateReplacePolicy?: string;
}

function resources(template: Template, type: string): CfnResource[] {
  return Object.values(template.findResources(type)) as CfnResource[];
}

function logGroups(template: Template): CfnResource[] {
  return resources(template, "AWS::Logs::LogGroup");
}

function lambdaFunctions(template: Template): CfnResource[] {
  return resources(template, "AWS::Lambda::Function");
}

function assertManagedLogGroups(
  template: Template,
  expectedRetentionDays: readonly number[],
): void {
  const groups = logGroups(template);
  expect(groups).toHaveLength(expectedRetentionDays.length);
  expect(
    groups.map((group) => group.Properties?.RetentionInDays).sort(),
  ).toEqual([...expectedRetentionDays].sort());

  for (const group of groups) {
    expect(group.DeletionPolicy).toBe("Delete");
    expect(group.UpdateReplacePolicy).toBe("Delete");
  }
}

function assertEveryLambdaUsesManagedLogGroup(template: Template): void {
  for (const resource of lambdaFunctions(template)) {
    expect(resource.Properties).toEqual(
      expect.objectContaining({
        LoggingConfig: expect.objectContaining({
          LogGroup: expect.anything(),
        }),
      }),
    );
  }
}

function activeLambdaConstructorLines(source: string): number[] {
  return source.split("\n").flatMap((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return [];
    return line.includes("new lambda.Function(") ||
      line.includes("new lambda.DockerImageFunction(")
      ? [index]
      : [];
  });
}

describe("Lambda CloudWatch log retention", () => {
  test("helper creates managed log groups with explicit retention and deletion behavior", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    createLambdaLogGroup(stack, "ReplayTickLogGroup", "replayTick");
    createLambdaLogGroup(stack, "AppAuditLogGroup", "appAudit");

    assertManagedLogGroups(Template.fromStack(stack), [7, 30]);
  });

  test("FAME pool-state Lambdas use replay-tick seven-day log groups", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    new FamePoolState(stack, "FamePoolState", {
      baseRpcsJson: JSON.stringify(["https://base.example"]),
      serviceToken: "unit-token",
    });

    const template = Template.fromStack(stack);
    expect(lambdaFunctions(template)).toHaveLength(3);
    assertManagedLogGroups(template, [7, 7, 7]);
    assertEveryLambdaUsesManagedLogGroup(template);
  });

  test("image Lambdas use Base seven-day and Ethereum thirty-day log groups", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    new ImageLambdas(stack, "ImageLambdas", {
      baseRpcsJson: JSON.stringify(["https://base.example"]),
      mainnetRpcsJson: JSON.stringify(["https://mainnet.example"]),
      domain: ["images", "example.com"],
      corsAllowedOriginsJson: JSON.stringify(["https://example.com"]),
    });

    const template = Template.fromStack(stack);
    expect(lambdaFunctions(template)).toHaveLength(4);
    assertManagedLogGroups(template, [7, 7, 30, 30]);
    assertEveryLambdaUsesManagedLogGroup(template);
  });

  test("event Lambdas use app-audit, mixed-chain, and Ethereum thirty-day log groups", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "TestStack");

    new EventLambdas(stack, "EventLambdas", {
      baseRpcsJson: JSON.stringify(["https://base.example"]),
      sepoliaRpcsJson: JSON.stringify(["https://sepolia.example"]),
      mainnetRpcsJson: JSON.stringify(["https://mainnet.example"]),
      domain: ["events", "example.com"],
      discordChannelId: "discord-channel",
      discordAppId: "discord-app",
      discordBotToken: "discord-token",
      discordPublicKey: "discord-public-key",
      enableSchedules: false,
    });

    const template = Template.fromStack(stack);
    expect(lambdaFunctions(template)).toHaveLength(4);
    assertManagedLogGroups(template, [30, 30, 30, 30]);
    assertEveryLambdaUsesManagedLogGroup(template);
  });

  test("inactive Alchemy webhook construct keeps an explicit mixed-chain retention decision", () => {
    const source = readFileSync("lib/alchemy-webhook.ts", "utf8");

    expect(source).toContain("SwapSchwingLogGroup");
    expect(source).toContain("mixedEthereumBase");
  });

  test("active Lambda constructor blocks in deploy/lib declare an explicit log group", () => {
    const files = readdirSync("lib")
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => file !== "lambda-log-groups.ts");

    for (const file of files) {
      const lines = readFileSync(`lib/${file}`, "utf8").split("\n");
      for (const lineIndex of activeLambdaConstructorLines(lines.join("\n"))) {
        const constructorBlock = lines
          .slice(lineIndex, lineIndex + 40)
          .join("\n");
        expect(constructorBlock).toContain("logGroup:");
      }
    }
  });
});
