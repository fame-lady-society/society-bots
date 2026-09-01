import { SNS } from "@aws-sdk/client-sns";
import { describe, expect, it, jest } from "@jest/globals";

import {
  notifyDiscordSocietyProfile,
  societyProfileEmbed,
  societyProfileUrl,
} from "./profile.ts";

describe("Society profile Discord notification", () => {
  it("projects a profile card with an encoded public URL and Fame Lady portrait", () => {
    const profile = {
      name: "purple/lioness💜",
      primaryTokenId: 2_264n,
    };

    expect(societyProfileUrl(profile.name)).toBe(
      "https://www.fameladysociety.com/mainnet/~/purple%2Flioness%F0%9F%92%9C",
    );
    expect(societyProfileEmbed(profile, "fame.support")).toEqual({
      title: "New Society Profile",
      description: "**purple/lioness💜** created a Society profile.",
      url: societyProfileUrl(profile.name),
      fields: [{ name: "Fame Lady", value: "#2264", inline: true }],
      image: { url: "https://fame.support/fls/thumb/2264" },
    });
  });

  it("publishes without exposing a wallet or allowing mentions", async () => {
    const publish = jest.fn(
      async (_request: { Message: string; TopicArn: string }) => ({}),
    );
    const sns = { publish } as unknown as SNS;

    await notifyDiscordSocietyProfile({
      profile: { name: "flick", primaryTokenId: 6_929n },
      imageHost: "fame.support",
      channelId: "fls-channel",
      topicArn: "discord-topic",
      sns,
    });

    const request = publish.mock.calls[0][0];
    const event = JSON.parse(request.Message);
    expect(request.TopicArn).toBe("discord-topic");
    expect(event.channelId).toBe("fls-channel");
    expect(event.message.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(event)).not.toContain("0x");
    expect(JSON.stringify(event)).not.toContain("etherscan");
  });

  it("renders claimed names as text instead of Discord markdown", () => {
    const embed = societyProfileEmbed(
      {
        name: "[Verify wallet](https://attacker.example)",
        primaryTokenId: 2_264n,
      },
      "fame.support",
    );

    expect(embed.description).toBe(
      "**\\[Verify wallet\\]\\(https://attacker\\.example\\)** created a Society profile.",
    );
    expect(embed.url).toBe(
      "https://www.fameladysociety.com/mainnet/~/%5BVerify%20wallet%5D(https%3A%2F%2Fattacker.example)",
    );
  });
});
