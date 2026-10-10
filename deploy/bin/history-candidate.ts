import * as cdk from "aws-cdk-lib";
import { FameHistoryCandidate } from "../lib/fame-history-candidate.js";
const required = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key}`);
  return v;
};
const app = new cdk.App();
const stack = new cdk.Stack(app, "FameHistoryCandidate", {
  env: {
    account: required("CDK_DEFAULT_ACCOUNT"),
    region: required("CDK_DEFAULT_REGION"),
  },
});
new FameHistoryCandidate(stack, "Candidate", {
  rpcParameterName: required("FAME_HISTORY_RPC_PARAMETER"),
});
