import { SNS } from "@aws-sdk/client-sns";
import { afterEach, describe, expect, it, jest } from "@jest/globals";

import { vaultDonatorAddress } from "@/wagmi.generated.ts";
import { notifyDiscordSingleWrappedAndDonated } from "./discord.ts";

const donor = "0x0000000000000000000000000000000000000001" as const;
const transactionHash = `0x${"11".repeat(32)}` as `0x${string}`;

describe("wrap-and-donate Discord notifications", () => {
  const originalImageHost = process.env.IMAGE_HOST;

  afterEach(() => {
    process.env.IMAGE_HOST = originalImageHost;
    jest.restoreAllMocks();
  });

  it("watches the current mainnet donation contract", () => {
    expect(vaultDonatorAddress[1]).toBe(
      "0x582097Da47E57FD6DBBc5261560CC087631f4FcD",
    );
  });

  it("publishes a correctly attributed single-donation card with artwork", async () => {
    process.env.IMAGE_HOST = "fame.support";
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const publish = jest.fn(
      async (_request: { Message: string; TopicArn: string }) => ({}),
    );
    const sns = { publish } as unknown as SNS;
    const client = {
      getEnsName: jest.fn(async () => "donor.eth"),
    };

    await notifyDiscordSingleWrappedAndDonated({
      tokenId: 42n,
      wrappedCount: 1_234n,
      fromAddress: donor,
      channelId: "fls-channel",
      client: client as never,
      discordMessageTopicArn: "discord-topic",
      sns,
      totalDonatedCount: 12n,
      blockExplorerUrl: "https://etherscan.io",
      txHash: transactionHash,
    });

    const request = publish.mock.calls[0][0];
    const event = JSON.parse(request.Message);
    expect(request.TopicArn).toBe("discord-topic");
    expect(event.channelId).toBe("fls-channel");
    expect(event.message.embeds[0]).toMatchObject({
      title: "#donate",
      description: "A new Fame Lady Society was donated to the vault!",
      image: { url: "https://fame.support/fls/thumb/42" },
      url: `https://etherscan.io/tx/${transactionHash}`,
      fields: expect.arrayContaining([
        { name: "by", value: "donor.eth", inline: true },
        { name: "total donated", value: "12", inline: true },
        { name: "total wrapped", value: "1234", inline: true },
      ]),
    });
  });
});
