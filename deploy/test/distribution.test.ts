import { runInNewContext } from "node:vm";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as apigw2 from "aws-cdk-lib/aws-apigatewayv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  Distribution,
  FAME_LANDING_SNAPSHOT_CACHE_POLICY_MAX_TTL_SECONDS,
  FAME_LANDING_SNAPSHOT_VIEWER_REQUEST_CODE,
  ZERO_TTL_ERROR_STATUSES,
} from "../lib/distribution.js";

function viewerRequest(event: unknown): unknown {
  return runInNewContext(
    `${FAME_LANDING_SNAPSHOT_VIEWER_REQUEST_CODE}; handler(event)`,
    { event },
  );
}

describe("FAME landing snapshot viewer request", () => {
  test("defines zero cache retention for public and infrastructure errors", () => {
    expect(ZERO_TTL_ERROR_STATUSES).toEqual([
      400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504,
    ]);
  });

  test("retains the snapshot for its full fresh and stale cache window", () => {
    expect(FAME_LANDING_SNAPSHOT_CACHE_POLICY_MAX_TTL_SECONDS).toBe(180);
  });

  test("wires the bounded cache policy to the landing snapshot behavior", () => {
    const account = "111111111111";
    const region = "us-east-1";
    const app = new cdk.App({
      context: {
        [`hosted-zone:account=${account}:domainName=example.com:region=${region}`]:
          {
            Id: "/hostedzone/Z1111111111111",
            Name: "example.com.",
          },
      },
    });
    const stack = new cdk.Stack(app, "DistributionStack", {
      env: { account, region },
    });
    const httpApi = apigw2.HttpApi.fromHttpApiAttributes(stack, "HttpApi", {
      httpApiId: "api-id",
      apiEndpoint: `https://api-id.execute-api.${region}.amazonaws.com`,
    });
    const assetStorageBucket = s3.Bucket.fromBucketName(
      stack,
      "AssetStorage",
      "asset-storage-example",
    );
    new Distribution(stack, "Distribution", {
      domain: ["api", "example.com"],
      httpApi,
      assetStorageBucket,
    });

    const template = Template.fromStack(stack);
    const cachePolicies = template.findResources(
      "AWS::CloudFront::CachePolicy",
    );
    const cachePolicyEntry = Object.entries(cachePolicies).find(
      ([, resource]) =>
        resource.Properties.CachePolicyConfig.MaxTTL ===
        FAME_LANDING_SNAPSHOT_CACHE_POLICY_MAX_TTL_SECONDS,
    );
    expect(cachePolicyEntry).toBeDefined();

    const distributions = template.findResources(
      "AWS::CloudFront::Distribution",
    );
    const distribution = Object.values(distributions)[0];
    const landingBehavior =
      distribution.Properties.DistributionConfig.CacheBehaviors.find(
        (behavior: { PathPattern?: string }) =>
          behavior.PathPattern === "/fame/landing-defi-snapshot",
      );
    expect(landingBehavior.CachePolicyId).toEqual({
      Ref: cachePolicyEntry?.[0],
    });
  });

  test("passes the fixed path request without cache-key variation", () => {
    const request = {
      method: "GET",
      uri: "/fame/landing-defi-snapshot",
      querystring: {},
      cookies: {},
    };

    expect(viewerRequest({ request })).toEqual(request);
  });

  test.each([
    ["query", { querystring: { amount: { value: "1" } }, cookies: {} }],
    ["cookie", { querystring: {}, cookies: { session: { value: "x" } } }],
    ["HEAD", { method: "HEAD", querystring: {}, cookies: {} }],
    ["OPTIONS", { method: "OPTIONS", querystring: {}, cookies: {} }],
  ])(
    "rejects %s variation before a cached response can be served",
    (_, input) => {
      expect(
        viewerRequest({
          request: {
            method: "GET",
            uri: "/fame/landing-defi-snapshot",
            ...input,
          },
        }),
      ).toEqual({
        statusCode: 400,
        statusDescription: "Bad Request",
        headers: {
          "cache-control": { value: "no-store" },
          "content-type": { value: "application/json" },
        },
        body: '{"error":"invalid-request"}',
      });
    },
  );
});
