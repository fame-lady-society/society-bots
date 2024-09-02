import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { ParameterResource } from "@henrist/cdk-cross-region-params";

export interface CertificatesProps {
  readonly domains: string[];
}

export class Certificates extends Construct {
  readonly certificates: Map<string, acm.ICertificate> = new Map();
  constructor(scope: Construct, id: string, props: CertificatesProps) {
    super(scope, id);

    const { domains } = props;
    for (const domain of domains) {
      const certificate = new acm.Certificate(this, `Certificate-${domain}`, {
        domainName: domain,
        validation: acm.CertificateValidation.fromDns(),
      });
      this.certificates.set(domain, certificate);
      new cdk.CfnOutput(this, `CertificateArn-${domain}`, {
        value: certificate.certificateArn,
      });
      new ParameterResource(this, `CertificateArn-${domain}-Parameter`, {
        parameterName: `CertificateArn-${domain}`,
        referenceToResource(scope, id, reference) {
          return acm.Certificate.fromCertificateArn(scope, id, reference);
        },
        resourceToReference(resource) {
          return resource.certificateArn;
        },
        regions: ["us-west-1"],
        resource: certificate,
      });
    }
  }
}
