import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigw2 from "aws-cdk-lib/aws-apigatewayv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";

export interface Props {
  readonly domain: [string, string] | string;
  readonly fameImageThumbHandler: lambda.IFunction;
  readonly fameImageMosaicHandler: lambda.IFunction;
  readonly flsImageThumbHandler: lambda.IFunction;
  readonly flsImageMosaicHandler: lambda.IFunction;
  readonly discordInteractionHandler: lambda.IFunction;
}

export class HttpApi extends Construct {
  declare readonly httpApi: apigw2.HttpApi;
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const {
      domain,
      fameImageThumbHandler,
      fameImageMosaicHandler,
      flsImageThumbHandler,
      flsImageMosaicHandler,
      discordInteractionHandler,
    } = props;

    const domains = domain instanceof Array ? domain : [domain];
    const domainName = domains.join(".");
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: domain.length === 2 ? domains[1] : domains[0],
    });

    const apiDomainName = new apigw2.DomainName(this, "DomainName", {
      domainName: `api.${domainName}`,
      certificate: new acm.Certificate(this, "certificate", {
        domainName: `api.${domainName}`,
        validation: acm.CertificateValidation.fromDns(hostedZone),
      }),
    });

    const httpApi = new apigw2.HttpApi(this, "SocietyBot", {
      description: "Society-bot REST API",
      defaultDomainMapping: {
        domainName: apiDomainName,
      },
    });
    httpApi.addRoutes({
      path: "/thumb/{tokenId}",
      methods: [apigw2.HttpMethod.GET, apigw2.HttpMethod.OPTIONS],
      integration: new HttpLambdaIntegration("thumb", fameImageThumbHandler),
    });

    httpApi.addRoutes({
      path: "/mosaic/{tokenId}",
      methods: [apigw2.HttpMethod.GET, apigw2.HttpMethod.OPTIONS],
      integration: new HttpLambdaIntegration("mosaic", fameImageMosaicHandler),
    });

    httpApi.addRoutes({
      path: "/fls/thumb/{tokenId}",
      methods: [apigw2.HttpMethod.GET, apigw2.HttpMethod.OPTIONS],
      integration: new HttpLambdaIntegration("fls-thumb", flsImageThumbHandler),
    });

    httpApi.addRoutes({
      path: "/fls/mosaic/{tokenId}",
      methods: [apigw2.HttpMethod.GET, apigw2.HttpMethod.OPTIONS],
      integration: new HttpLambdaIntegration(
        "fls-mosaic",
        flsImageMosaicHandler,
      ),
    });

    httpApi.addRoutes({
      path: "/discord/interaction",
      methods: [apigw2.HttpMethod.POST],
      integration: new HttpLambdaIntegration(
        "discord",
        discordInteractionHandler,
      ),
    });

    new route53.ARecord(this, "AliasIPv4Record", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          apiDomainName.regionalDomainName,
          apiDomainName.regionalHostedZoneId,
        ),
      ),
      recordName: domains.length > 1 ? `api.${domains[0]}` : "api",
    });
    new route53.AaaaRecord(this, "AliasIPv6Record", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          apiDomainName.regionalDomainName,
          apiDomainName.regionalHostedZoneId,
        ),
      ),
      recordName: domains.length > 1 ? `api.${domains[0]}` : "api",
    });

    const apiUrl = cdk.Fn.select(1, cdk.Fn.split("//", httpApi.apiEndpoint));
    new cdk.CfnOutput(this, "ApiUrl", {
      value: apiUrl,
    });

    this.httpApi = httpApi;
  }
}
