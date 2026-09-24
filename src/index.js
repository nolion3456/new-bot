const express = require('express');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const port = Number(process.env.PORT || 10000);

if (!token) {
  console.error('Missing DISCORD_TOKEN. Add it to the runtime environment before starting the bot.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('检查机器人是否在线'),
  new SlashCommandBuilder().setName('help').setDescription('查看可用指令'),
].map((command) => command.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const app = express();
app.get('/', (_req, res) => res.status(200).json({ status: 'ok', service: 'discord-bot' }));
app.get('/health', (_req, res) =>
  res.status(client.isReady() ? 200 : 503).json({ status: client.isReady() ? 'ready' : 'starting' }),
);
app.listen(port, '0.0.0.0', () => console.log(`Health server listening on port ${port}`));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(client.user.id, guildId)
    : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} slash commands ${guildId ? `for guild ${guildId}` : 'globally'}.`);
}

client.once('ready', async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Slash-command registration failed:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    return interaction.reply(`Pong！延迟 ${client.ws.ping}ms`);
  }

  if (interaction.commandName === 'help') {
    return interaction.reply({
      ephemeral: true,
      content: [
        '**可用指令**',
        '`/ping` 检查机器人是否在线并显示延迟',
        '`/help` 查看这份帮助信息',
      ].join('\n'),
    });
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
client.login(token);

