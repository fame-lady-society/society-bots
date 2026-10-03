import * as cdk from "aws-cdk-lib";
import * as path from "node:path";
import { BotConsoleStack } from "../lib/bot-console-stack.js";
const authSecretArn = process.env.BOT_CONSOLE_AUTH_SECRET_ARN;
if (!authSecretArn)
  throw new Error(
    "Set BOT_CONSOLE_AUTH_SECRET_ARN to the dedicated auth secret; no credentials in CDK context.",
  );
new BotConsoleStack(new cdk.App(), "FlsBotConsole", {
  env: { account: "590183914614", region: "us-east-1" },
  synthesizer: new cdk.DefaultStackSynthesizer({
    deployRoleArn: "",
    fileAssetPublishingRoleArn: "",
    lookupRoleArn: "",
    cloudFormationExecutionRole:
      "arn:aws:iam::590183914614:role/FlsBotConsoleExecution",
    bucketPrefix: "bot-console/",
    generateBootstrapVersionRule: false,
    useLookupRoleForStackOperations: false,
  }),
  authSecretArn,
  appDirectory: path.resolve("../apps/bot-console"),
});
