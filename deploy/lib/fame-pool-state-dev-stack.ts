import * as cdk from "aws-cdk-lib";
import * as apigw2 from "aws-cdk-lib/aws-apigatewayv2";
import {
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { FamePoolState } from "./fame-pool-state.js";

export class FamePoolStateDevStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const poolState = new FamePoolState(this, "FamePoolState", {
      baseRpcsJson: process.env.BASE_RPCS_JSON,
      serviceToken: process.env.FAME_POOL_STATE_DEV_SERVICE_TOKEN ?? "",
      clReplayMaintenanceMode:
        process.env.FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE === "steady-state" ||
        process.env.FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE === "repair"
          ? process.env.FAME_POOL_STATE_CL_REPLAY_MAINTENANCE_MODE
          : "checkpoint",
      clReplayTrustPromotion:
        process.env.FAME_POOL_STATE_CL_REPLAY_TRUST_PROMOTION === "true",
      clReplayMaxRangeBlocks: Number(
        process.env.FAME_POOL_STATE_CL_REPLAY_MAX_RANGE_BLOCKS ?? "1000",
      ),
    });

    const httpApi = new apigw2.HttpApi(this, "FamePoolStateDevApi", {
      description: "FAME pool-state dev API",
    });
    const authorizer = new HttpLambdaAuthorizer(
      "FamePoolStateDevAuthorizer",
      poolState.apiAuthorizerLambda,
      {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        identitySource: ["$request.header.Authorization"],
      },
    );

    httpApi.addRoutes({
      path: "/fame/pool-state",
      methods: [apigw2.HttpMethod.POST],
      integration: new HttpLambdaIntegration(
        "fame-pool-state-dev",
        poolState.apiLambda,
      ),
      authorizer,
    });

    httpApi.addRoutes({
      path: "/fame/pool-quotes",
      methods: [apigw2.HttpMethod.POST],
      integration: new HttpLambdaIntegration(
        "fame-pool-quotes-dev",
        poolState.apiLambda,
      ),
      authorizer,
    });

    new cdk.CfnOutput(this, "FamePoolApiDevBaseUrl", {
      value: httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, "FamePoolStateDevEndpointUrl", {
      value: cdk.Fn.join("", [httpApi.apiEndpoint, "/fame/pool-state"]),
    });
    new cdk.CfnOutput(this, "FamePoolQuotesDevEndpointUrl", {
      value: cdk.Fn.join("", [httpApi.apiEndpoint, "/fame/pool-quotes"]),
    });
  }
}
