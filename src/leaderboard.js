const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { formatMoney, getGuildData, getMiniLeaderboard } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'leaderboards.json');
const panels = new Map();
let refreshTimer = null;
let refreshInterval = null;

const leaderboardCommand = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('发布或刷新本服务器的迷你币排行榜');

function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(panels.entries()), null, 2));
  fs.renameSync(temporary, dataFile);
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [guildId, value] of Object.entries(raw)) {
      if (value?.channelId && value?.messageId) panels.set(guildId, { channelId: value.channelId, messageId: value.messageId });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load leaderboard data:', error.message);
  }
}

function leaderboardEmbed(guildId, entries, refreshedAt = Date.now()) {
  const currency = getGuildData(guildId).name;
  const lines = entries.length
    ? entries.map((entry, index) => {
      const medal = ['🥇', '🥈', '🥉'][index] || `**${index + 1}.**`;
      return `${medal} <@${entry.userId}>　**${formatMoney(entry.amount)} ${currency}**`;
    }).join('\n')
    : '目前还没有迷你币余额记录。';
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 迷你币排行榜')
    .setDescription(lines)
    .addFields(
      { name: '统计范围', value: '本服务器成员', inline: true },
      { name: '更新时间', value: new Date(refreshedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), inline: true },
    )
    .setFooter({ text: '每小时的 00 分和 30 分自动刷新｜排名按迷你币余额由高到低' })
    .setTimestamp(refreshedAt);
}

async function refreshGuildLeaderboard(client, guildId, panel = panels.get(guildId)) {
  if (!panel) return false;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;
  const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
  const message = channel?.messages ? await channel.messages.fetch(panel.messageId).catch(() => null) : null;
  if (!message) return false;
  const entries = getMiniLeaderboard(guildId, 10);
  await message.edit({ embeds: [leaderboardEmbed(guildId, entries)] });
  return true;
}

async function refreshAll(client) {
  let changed = false;
  for (const [guildId, panel] of panels.entries()) {
    const refreshed = await refreshGuildLeaderboard(client, guildId, panel);
    if (!refreshed) {
      panels.delete(guildId);
      changed = true;
    }
  }
  if (changed) saveData();
}

function millisecondsToNextHalfHour() {
  const now = Date.now();
  const localNow = new Date(now + 8 * 60 * 60 * 1000);
  const minutes = localNow.getUTCMinutes();
  const seconds = localNow.getUTCSeconds();
  const milliseconds = localNow.getUTCMilliseconds();
  const minutesToNext = minutes < 30 ? 30 - minutes : 60 - minutes;
  return minutesToNext * 60 * 1000 - seconds * 1000 - milliseconds;
}

function startRefreshSchedule(client) {
  if (refreshTimer || refreshInterval) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await refreshAll(client);
    refreshInterval = setInterval(() => refreshAll(client).catch((error) => console.error('Leaderboard refresh failed:', error.message)), 30 * 60 * 1000);
  }, millisecondsToNextHalfHour());
}

async function handleLeaderboardInteraction(interaction, client) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'leaderboard') return false;
  if (!interaction.guild) return interaction.reply({ content: '此指令只能在服务器内使用。', ephemeral: true });
  await interaction.deferReply();
  const entries = getMiniLeaderboard(interaction.guildId, 10);
  const message = await interaction.editReply({ embeds: [leaderboardEmbed(interaction.guildId, entries)] });
  panels.set(interaction.guildId, { channelId: interaction.channelId, messageId: message.id });
  saveData();
  return true;
}

function setupLeaderboard(client) {
  loadData();
  client.on('interactionCreate', (interaction) => handleLeaderboardInteraction(interaction, client).catch((error) => {
    console.error('Leaderboard interaction failed:', error);
    const response = { content: '排行榜操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
  client.once('ready', () => {
    refreshAll(client).catch((error) => console.error('Initial leaderboard refresh failed:', error.message));
    startRefreshSchedule(client);
  });
}

module.exports = { leaderboardCommand, setupLeaderboard };
