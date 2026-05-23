import * as cdk from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export type LambdaLogRetentionClass =
  | "appAudit"
  | "baseOperational"
  | "ethereum"
  | "mixedEthereumBase"
  | "replayTick";

const retentionDaysByClass: Record<
  LambdaLogRetentionClass,
  logs.RetentionDays
> = {
  appAudit: logs.RetentionDays.ONE_MONTH,
  baseOperational: logs.RetentionDays.ONE_WEEK,
  ethereum: logs.RetentionDays.ONE_MONTH,
  mixedEthereumBase: logs.RetentionDays.ONE_MONTH,
  replayTick: logs.RetentionDays.ONE_WEEK,
};

export function retentionDaysForClass(
  retentionClass: LambdaLogRetentionClass,
): logs.RetentionDays {
  return retentionDaysByClass[retentionClass];
}

export function createLambdaLogGroup(
  scope: Construct,
  id: string,
  retentionClass: LambdaLogRetentionClass,
): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    retention: retentionDaysForClass(retentionClass),
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}
