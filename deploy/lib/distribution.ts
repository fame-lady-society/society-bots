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
  readonly httpApi: IHttpApi;
  readonly assetStorageBucket: IBucket;
}

export const FAME_LANDING_SNAPSHOT_VIEWER_REQUEST_CODE = `function handler(event) {
  var request = event.request;
  var hasQuery = Object.keys(request.querystring || {}).length > 0;
  var hasCookies = Object.keys(request.cookies || {}).length > 0;
  if (request.method !== "GET" || hasQuery || hasCookies) {
    return {
      statusCode: 400,
      statusDescription: "Bad Request",
      headers: {
        "cache-control": { value: "no-store" },
        "content-type": { value: "application/json" }
      },
      body: "{\\\"error\\\":\\\"invalid-request\\\"}"
    };
  }
  return request;
}`;

export const FAME_LANDING_SNAPSHOT_CACHE_POLICY_MAX_TTL_SECONDS = 180;

export const ZERO_TTL_ERROR_STATUSES = [
  400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504,
] as const;

export class Distribution extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const { domain, httpApi } = props;

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
      certificateReader.parameterValue,
    );
    const landingSnapshotCachePolicy = new cloudfront.CachePolicy(
      this,
      "FameLandingSnapshotCachePolicy",
      {
        minTtl: cdk.Duration.seconds(0),
        defaultTtl: cdk.Duration.seconds(0),
        maxTtl: cdk.Duration.seconds(
          FAME_LANDING_SNAPSHOT_CACHE_POLICY_MAX_TTL_SECONDS,
        ),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
        headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      },
    );
    const landingSnapshotViewerRequest = new cloudfront.Function(
      this,
      "FameLandingSnapshotViewerRequest",
      {
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        code: cloudfront.FunctionCode.fromInline(
          FAME_LANDING_SNAPSHOT_VIEWER_REQUEST_CODE,
        ),
      },
    );

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new cloudfrontorigins.HttpOrigin(
          `${httpApi.apiId}.execute-api.${
            cdk.Stack.of(this).region
          }.amazonaws.com`,
        ),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/fame/landing-defi-snapshot": {
          origin: new cloudfrontorigins.HttpOrigin(
            `${httpApi.apiId}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com`,
          ),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: landingSnapshotCachePolicy,
          functionAssociations: [
            {
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
              function: landingSnapshotViewerRequest,
            },
          ],
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        "/assets/*": {
          origin: new cloudfrontorigins.S3Origin(props.assetStorageBucket),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        "/fameus/*": {
          origin: new cloudfrontorigins.S3Origin(props.assetStorageBucket),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      domainNames: [domainName],
      certificate,
      errorResponses: ZERO_TTL_ERROR_STATUSES.map((httpStatus) => ({
        httpStatus,
        ttl: cdk.Duration.seconds(0),
      })),
    });

    new route53.ARecord(this, "AliasIPv4Record", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
      recordName: domain.length === 2 ? domains[0] : undefined,
    });
    new route53.AaaaRecord(this, "AliasIPv6Record", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
      recordName: domain.length === 2 ? domains[0] : undefined,
    });
  }
}
