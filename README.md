# 0xflick lambdas

This repo contains serverless cloud functions

## Setup

The following tools are required:

- NodeJS 16+ ([nvm](https://github.com/nvm-sh/nvm) preferred for installing)
- yarn (`npm i -g yarn`)

For deployments, an AWS account is required. In addition:

- [sops](https://github.com/mozilla/sops/releases) - For managing secrets (approved team members only)

## Contribution

Lambda functions reside in [src/lambda](src/lambda).

## Building

To build the metadata function:

```
yarn metadata:build
```

To build the image resizer function(s):

```
yarn image:build
```

## Tests

Are needed

## Depoyments

See [Deployment README](deploy/README.md)
