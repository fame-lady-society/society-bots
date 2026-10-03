import * as cdk from "aws-cdk-lib";
import { BotConsoleAccessStack } from "../lib/bot-console-access-stack.js";
new BotConsoleAccessStack(new cdk.App(), "FlsBotConsoleAccess", {
  env: { account: "590183914614", region: "us-east-1" },
});
