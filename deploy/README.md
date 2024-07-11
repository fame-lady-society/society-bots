# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

- `npm run build` compile typescript to js
- `npm run watch` watch for changes and compile
- `npm run test` perform the jest unit tests
- `npx cdk deploy` deploy this stack to your default AWS account/region
- `npx cdk diff` compare deployed stack with current state
- `npx cdk synth` emits the synthesized CloudFormation template

## Creating an alchemy webhook

from: https://docs.alchemy.com/reference/custom-webhooks-faq

```
curl --request POST \
     --url https://dashboard.alchemy.com/api/create-webhook \
     --header 'X-Alchemy-Token: ${WEBHOOK_AUTH_TOKEN}' \
     --header 'accept: application/json' \
     --header 'content-type: application/json' \
     --data '
{
  "network": "BASE_MAINNET",
  "webhook_type": "GRAPHQL",
  "graphql_query": {
    "skip_empty_messages": true,
    "query": "{   block {     logs(filter: {addresses: [\"0x04b41Fe46e8685719Ac40101fc6478682256Bc6F\",\"0x6Dbf04dbFEDC9Aaf4Eba14Bab51e9a4298340c01\"], topics: []}) {       data       topics       transaction {         hash         from {           address         }         to {           address         }         logs {           account {             address           }           data           topics         }         type         status       }     }   } }"
  },
  "webhook_url": "${WEBHOOK_ENDPOINT}"
}
'
```
