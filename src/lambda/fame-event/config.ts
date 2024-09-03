if (!process.env.DYNAMODB_FAME_INDEX_TABLE_NAME) {
  throw new Error("DYNAMODB_FAME_INDEX_TABLE_NAME is not defined");
}
export const DYNAMODB_FAME_INDEX_TABLE_NAME =
  process.env.DYNAMODB_FAME_INDEX_TABLE_NAME;

if (!process.env.DYNAMODB_REGION) {
  throw new Error("DYNAMODB_REGION is not defined");
}
export const DYNAMODB_REGION = process.env.DYNAMODB_REGION;

if (!process.env.DISCORD_CHANNEL_ID) {
  throw new Error("DISCORD_CHANNEL_ID not set");
}

export const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

if (!process.env.DISCORD_MESSAGE_TOPIC_ARN) {
  throw new Error("DISCORD_MESSAGE_TOPIC_ARN not set");
}

export const DISCORD_MESSAGE_TOPIC_ARN = process.env.DISCORD_MESSAGE_TOPIC_ARN;
