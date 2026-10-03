import * as cdk from "aws-cdk-lib";
import { FameMarketHistory } from "../lib/fame-market-history.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const app = new cdk.App();
const stack = new cdk.Stack(app, "FameMarketHistory", {
  env: {
    account: required("CDK_DEFAULT_ACCOUNT"),
    region: required("CDK_DEFAULT_REGION"),
  },
});
new FameMarketHistory(stack, "History", {
  rpcParameterName: required("FAME_HISTORY_RPC_PARAMETER"),
  startBlock: Number(required("FAME_HISTORY_START_BLOCK")),
  dailyRequests: Number(required("FAME_HISTORY_DAILY_REQUESTS")),
  poolStateTableName: required("FAME_HISTORY_POOL_STATE_TABLE"),
});
