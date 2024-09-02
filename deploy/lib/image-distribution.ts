import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import { IHttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudfrontorigins from "aws-cdk-lib/aws-cloudfront-origins";
import { ParameterReader } from "@henrist/cdk-cross-region-params";
import { IBucket } from "aws-cdk-lib/aws-s3";

export interface Props {
  readonly domain: [string, string] | string;
  readonly imageHttpApi: IHttpApi;
  readonly assetStorageBucket: IBucket;
}

export class ImageDistribution extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const { domain, imageHttpApi } = props;

    const domains = domain instanceof Array ? domain : [domain];
    const domainName = domains.join(".");
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: domain.length === 2 ? domains[1] : domains[0],
    });

    const certificateReader = new ParameterReader(this, "CertificateArn", {
      parameterName: `CertificateArn-${domainName}`,
      region: "us-west-1",
    });
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "DistributionCert",
      certificateReader.parameterValue
    );

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new cloudfrontorigins.HttpOrigin(
          `${imageHttpApi.apiId}.execute-api.${
            cdk.Stack.of(this).region
          }.amazonaws.com`
        ),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/assets/*": {
          origin: new cloudfrontorigins.S3Origin(props.assetStorageBucket),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      domainNames: [domainName],
      certificate,
    });

    new route53.ARecord(this, "AliasIPv4Record", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
      recordName: domain.length === 2 ? domains[0] : undefined,
    });
    new route53.AaaaRecord(this, "AliasIPv6Record", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution)
      ),
      recordName: domain.length === 2 ? domains[0] : undefined,
    });
  }
}
