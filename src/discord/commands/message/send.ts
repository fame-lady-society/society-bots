import { RESTPostAPIChannelMessageJSONBody } from "discord-api-types/v10";
import { sendChannelMessage } from "../../service/discord.ts";

export async function handle(
  channelId: string,
  message: RESTPostAPIChannelMessageJSONBody
) {
  await sendChannelMessage(channelId, message);
}
