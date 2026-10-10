import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { FameHistoryCandidate } from "../lib/fame-history-candidate.js";
test("candidate deployment is physically isolated and cannot serve or write production history", () => {
  const stack = new cdk.Stack(new cdk.App(), "CandidateTest");
  new FameHistoryCandidate(stack, "Candidate", {
    rpcParameterName: "/society-bots/market-history/base-rpc",
  });
  const t = Template.fromStack(stack);
  t.resourceCountIs("AWS::DynamoDB::Table", 1);
  t.resourceCountIs("AWS::S3::Bucket", 1);
  t.resourceCountIs("AWS::Lambda::Function", 2);
  t.resourceCountIs("AWS::ApiGatewayV2::Route", 0);
  t.resourceCountIs("AWS::Lambda::Url", 0);
  t.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  t.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 300,
    ReservedConcurrentExecutions: 1,
    Environment: {
      Variables: Match.objectLike({
        FAME_CANDIDATE_TABLE: Match.anyValue(),
        FAME_CANDIDATE_BUCKET: Match.anyValue(),
      }),
    },
  });
  t.hasResourceProperties("AWS::Events::Rule", {
    ScheduleExpression: "rate(5 minutes)",
  });
  const json = t.toJSON();
  expect(json.Outputs.TableName).toBeDefined();
  expect(json.Outputs.ReaderName).toBeDefined();
  for (const r of Object.values<any>(json.Resources).filter(
    (r) => r.Type === "AWS::IAM::Policy",
  ))
    for (const s of r.Properties.PolicyDocument.Statement) {
      const actions = [s.Action].flat();
      expect(actions).not.toContain("lambda:InvokeFunction");
      if (actions.some((a: string) => a.startsWith("dynamodb:")))
        expect(JSON.stringify(s.Resource)).toContain("CandidateHistory");
      if (actions.some((a: string) => a.startsWith("s3:")))
        expect(JSON.stringify(s.Resource)).toContain("CandidateArchive");
    }
  const reader = Object.values<any>(json.Resources).find(
    (r) =>
      r.Type === "AWS::Lambda::Function" &&
      r.Properties.Runtime === "nodejs24.x",
  );
  expect(
    reader.Properties.Environment.Variables.FAME_CANDIDATE_BUCKET,
  ).toBeUndefined();
  const readerRole = reader.Properties.Role["Fn::GetAtt"][0];
  for (const policy of Object.values<any>(json.Resources).filter(
    (r) =>
      r.Type === "AWS::IAM::Policy" &&
      r.Properties.Roles?.some((role: any) => role.Ref === readerRole),
  ))
    for (const statement of policy.Properties.PolicyDocument.Statement)
      expect(
        [statement.Action]
          .flat()
          .every((a) =>
            [
              "dynamodb:GetItem",
              "dynamodb:BatchGetItem",
              "dynamodb:Query",
            ].includes(a),
          ),
      ).toBe(true);
});
