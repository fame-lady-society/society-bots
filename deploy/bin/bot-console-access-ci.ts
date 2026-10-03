import * as cdk from "aws-cdk-lib";
import { BotConsoleAccessCiStack } from "../lib/bot-console-access-ci-stack.js";
new BotConsoleAccessCiStack(new cdk.App(), "FlsBotConsoleAccessCi", {
  env: { account: "590183914614", region: "us-east-1" },
});
