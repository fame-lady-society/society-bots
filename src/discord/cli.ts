import { SlashCommandBuilder } from "@discordjs/builders";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v9";
import { Command } from "commander";

const program = new Command();

const commandCommand = program
  .command("commands")
  .description("List all commands");

commandCommand
  .command("create")
  .description("Creates slash commands for a guild")
  .option("--client_id <client_id>", "Client ID")
  .option("--guild_id <guild_id>", "Guild ID")
  .option("--discord-token <token>", "Token")
  .option("--exclude <exclude>", "Exclude commands")
  .option("--global", "Create global commands")
  .action(
    async ({
      client_id: clientId,
      guild_id: guildId,
      discordToken: token,
      exclude,
      global,
    }) => {
      if (guildId) {
        console.log(`Creating commands for guild ${guildId}`);
      } else {
        console.log(`Creating global commands`);
      }
      exclude = exclude || "";
      exclude = exclude.split(",").map((x: string) => x.trim());
      const commands = (
        [
          //   [
          //     "ping",
          //     new SlashCommandBuilder()
          //       .setName("ping")
          //       .setDescription("Replies with pong!"),
          //   ],
          [
            "fame",
            new SlashCommandBuilder()
              .setName("fame")
              .setDescription("Beep boop, I am the SocietyBot!")
              .addSubcommand((subcommand) =>
                subcommand
                  .setName("announce")
                  .setDescription("Announce $FAME events")
                  .addStringOption((option) =>
                    option
                      .setName("notification")
                      .setDescription("Notification type to add")
                      .setRequired(true)
                      .addChoices([
                        { name: "$FAME Buy", value: "fame-buy" },
                        { name: "$FAME Sell", value: "fame-sell" },
                        { name: "$FAME NFT Mint", value: "fame-nft-mint" },
                        { name: "$FAME NFT Burn", value: "fame-nft-burn" },
                      ])
                  )
              )
              .addSubcommand((subcommand) =>
                subcommand
                  .setName("silence")
                  .setDescription("Silence notifications")
                  .addStringOption((option) =>
                    option
                      .setName("notification")
                      .setDescription("Notification type to remove")
                      .setRequired(true)
                      .addChoices([
                        { name: "$FAME Buy", value: "fame-buy" },
                        { name: "$FAME Sell", value: "fame-sell" },
                        { name: "$FAME NFT Mint", value: "fame-nft-mint" },
                        { name: "$FAME NFT Burn", value: "fame-nft-burn" },
                      ])
                  )
              ),
          ],
        ] as [string, SlashCommandBuilder][]
      )
        .filter(([name, _]) => !exclude.includes(name))
        .map(([_, command]) => command.toJSON());

      const rest = new REST({ version: "9" }).setToken(token);

      rest
        .put(
          global
            ? Routes.applicationCommands(clientId)
            : Routes.applicationGuildCommands(clientId, guildId),
          {
            body: commands,
          }
        )
        .then(() =>
          console.log("Successfully registered application commands.")
        )
        .catch(console.error);
    }
  );

program.parse(process.argv);
