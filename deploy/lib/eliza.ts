import * as cdk from "aws-cdk-lib";
import * as path from "path";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { buildSync } from "esbuild";

function compile(entrypoint: string, options?: BuildOptions) {
  const outfile = path.join(
    cdk.FileSystem.mkdtemp(path.basename(entrypoint)),
    "index.mjs",
  );
  buildSync({
    entryPoints: [entrypoint],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["aws-sdk", "canvas"],
    inject: [path.join(__dirname, "./esbuild/cjs-shim.ts")],
    sourcemap: true,
    ...options,
  });
  const finalDir = path.dirname(outfile);
  return finalDir;
}

type Props = {
  fid: number;
};

export class Eliza extends Construct {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id);

    const { fid } = props;

    const stateTable = new dynamodb.Table(this, "ElizaStateTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    });

    // const interactionHandlerCodeDir = compile(
    //   path.join(__dirname, "../../src/eliza/lambda/farcaster.ts")
    // );

    // const lambdaFunction = new lambda.Function(this, "ElizaLambda", {
    //   code: lambda.Code.fromAsset("path/to/your/lambda/code.zip"),
    //   handler: "index.handler",
    //   runtime: lambda.Runtime.NODEJS_18_X,
    // });

    new cdk.CfnOutput(this, "ElizaStateTable", {
      value: stateTable.tableName,
    });
  }
}
