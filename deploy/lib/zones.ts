import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface ZonesProps {
  readonly publicZones: string[];
}

export class Zones extends Construct {
  constructor(scope: Construct, id: string, props: ZonesProps) {
    super(scope, id);

    const { publicZones: domains } = props;
    for (const domain of domains) {
      new route53.PublicHostedZone(this, `PublicZone-${domain}`, {
        zoneName: domain,
      });
    }
  }
}
