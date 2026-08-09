import { beforeAll, describe, expect, it, jest } from "@jest/globals";

let getNotifications: typeof import("./discord-guilds-notifications.ts").getNotifications;

beforeAll(async () => {
  process.env.DYNAMODB_FAME_INDEX_TABLE_NAME = "fame-index";
  process.env.DYNAMODB_DISCORD_NOTIFICATION_TABLE_NAME = "notifications";
  process.env.DYNAMODB_REGION = "us-east-1";
  process.env.DISCORD_MESSAGE_TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:discord";
  ({ getNotifications } = await import("./discord-guilds-notifications.ts"));
});

describe("Discord notification persistence", () => {
  it("ignores retired mint and burn subscriptions", async () => {
    const send = jest.fn(async () => ({
      Items: [
        { pk: "guild:1:channel:2:notification:fame-buy", sk: "notifications", guildId: "1", channelId: "2", notification: "fame-buy" },
        { pk: "guild:1:channel:2:notification:fame-sell", sk: "notifications", guildId: "1", channelId: "2", notification: "fame-sell" },
        { pk: "guild:1:channel:2:notification:fame-nft-mint", sk: "notifications", guildId: "1", channelId: "2", notification: "fame-nft-mint" },
        { pk: "guild:1:channel:2:notification:fame-nft-burn", sk: "notifications", guildId: "1", channelId: "2", notification: "fame-nft-burn" },
      ],
    }));

    await expect(getNotifications({ db: { send } as never, tableName: "notifications" })).resolves.toEqual([
      expect.objectContaining({ notification: "fame-buy" }),
      expect.objectContaining({ notification: "fame-sell" }),
    ]);
  });
});
