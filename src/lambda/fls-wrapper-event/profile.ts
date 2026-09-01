import { SNS } from "@aws-sdk/client-sns";
import type { APIEmbed } from "discord-api-types/v10";

import { sendDiscordMessage } from "@/discord/pubsub/send.ts";

export type SocietyProfile = {
  name: string;
  primaryTokenId: bigint;
};

const PROFILE_BASE_URL = "https://www.fameladysociety.com/mainnet/~";
const DISCORD_MARKDOWN_CHARACTERS = new Set("\\`*_{}[]()<>#+-.!|~>");

function escapeDiscordMarkdown(value: string) {
  return Array.from(value, (character) =>
    DISCORD_MARKDOWN_CHARACTERS.has(character) ? `\\${character}` : character,
  ).join("");
}

export function societyProfileUrl(name: string) {
  return `${PROFILE_BASE_URL}/${encodeURIComponent(name)}`;
}

export function societyProfileEmbed(
  profile: SocietyProfile,
  imageHost: string,
): APIEmbed {
  return {
    title: "New Society Profile",
    description: `**${escapeDiscordMarkdown(profile.name)}** created a Society profile.`,
    url: societyProfileUrl(profile.name),
    fields: [
      {
        name: "Fame Lady",
        value: `#${profile.primaryTokenId}`,
        inline: true,
      },
    ],
    image: {
      url: `https://${imageHost}/fls/thumb/${profile.primaryTokenId}`,
    },
  };
}

export async function notifyDiscordSocietyProfile({
  profile,
  imageHost,
  channelId,
  topicArn,
  sns,
}: {
  profile: SocietyProfile;
  imageHost: string;
  channelId: string;
  topicArn: string;
  sns: SNS;
}) {
  await sendDiscordMessage({
    channelId,
    topicArn,
    sns,
    message: {
      allowed_mentions: { parse: [] },
      embeds: [societyProfileEmbed(profile, imageHost)],
    },
  });
}
