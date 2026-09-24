const express = require('express');
const {
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const port = Number(process.env.PORT || 10000);
const maxAuditChannels = 3;
const configMarker = 'new-bot-audit-config-v1';
const auditChannelsByGuild = new Map();

if (!token) {
  console.error('Missing DISCORD_TOKEN. Add it to the runtime environment before starting the bot.');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('检查机器人是否在线'),
  new SlashCommandBuilder().setName('help').setDescription('查看可用指令'),
  new SlashCommandBuilder()
    .setName('audit-channel')
    .setDescription('设置服务器审计日志频道（管理员）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('添加一个审计日志频道，最多三个')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('要接收审计日志的文字频道')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('移除一个审计日志频道')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('要移除的审计日志频道')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('查看当前审计日志频道')),
].map((command) => command.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const app = express();
app.get('/', (_req, res) => res.status(200).json({ status: 'ok', service: 'discord-bot' }));
app.get('/health', (_req, res) =>
  res.status(client.isReady() ? 200 : 503).json({ status: client.isReady() ? 'ready' : 'starting' }),
);
app.listen(port, '0.0.0.0', () => console.log(`Health server listening on port ${port}`));

function clip(value, max = 1000) {
  const text = String(value ?? '(无内容)');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function code(value) {
  return '```\n' + clip(value) + '\n```';
}

function isAuditChannel(channelId, guildIdValue) {
  return (auditChannelsByGuild.get(guildIdValue) || []).includes(channelId);
}

function configEmbed(guildIdValue, channelIds) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('后台审计频道配置')
    .setDescription(`当前配置 ${channelIds.length}/${maxAuditChannels} 个频道。请勿删除此配置消息，否则机器人可能无法在重启后恢复设置。`)
    .addFields({ name: '频道', value: channelIds.length ? channelIds.map((id) => `<#${id}>`).join('\n') : '未设置' })
    .setFooter({ text: `${configMarker}:${guildIdValue}:${channelIds.join(',')}` })
    .setTimestamp();
}

async function persistGuildConfig(guild) {
  const channelIds = auditChannelsByGuild.get(guild.id) || [];
  if (!channelIds.length) return;
  const channel = await guild.channels.fetch(channelIds[0]).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [configEmbed(guild.id, channelIds)] }).catch((error) => {
    console.error(`Failed to persist audit configuration for guild ${guild.id}:`, error.message);
  });
}

async function restoreGuildConfig(guild) {
  const candidates = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement,
  );
  let latest = null;
  for (const channel of candidates.values()) {
    const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    if (!messages) continue;
    for (const message of messages.values()) {
      const footer = message.embeds[0]?.footer?.text || '';
      if (!footer.startsWith(`${configMarker}:${guild.id}:`)) continue;
      if (!latest || message.createdTimestamp > latest.createdTimestamp) latest = message;
    }
  }
  if (!latest) return;
  const encoded = latest.embeds[0].footer.text.split(':')[2] || '';
  const ids = encoded.split(',').filter(Boolean).slice(0, maxAuditChannels);
  if (ids.length) auditChannelsByGuild.set(guild.id, ids);
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(client.user.id, guildId)
    : Routes.applicationCommands(client.user.id);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} slash commands ${guildId ? `for guild ${guildId}` : 'globally'}.`);
}

async function sendAudit(guild, embed) {
  const channelIds = auditChannelsByGuild.get(guild.id) || [];
  if (!channelIds.length) return;
  for (const channelId of channelIds) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;
    await channel.send({ embeds: [embed] }).catch((error) => {
      console.error(`Failed to send audit log to ${channelId}:`, error.message);
    });
  }
}

async function findRecentExecutor(guild, type, targetId) {
  const logs = await guild.fetchAuditLogs({ type, limit: 10 }).catch(() => null);
  if (!logs) return null;
  const now = Date.now();
  const entry = logs.entries.find(
    (item) => item.targetId === targetId && now - item.createdTimestamp < 15_000 && item.executor,
  );
  return entry?.executor || null;
}

client.once('ready', async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) await restoreGuildConfig(guild);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Slash-command registration failed:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
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
          '`/audit-channel add` 添加后台审计频道（管理员）',
          '`/audit-channel remove` 移除后台审计频道（管理员）',
          '`/audit-channel list` 查看后台审计频道（管理员）',
        ].join('\n'),
      });
    }

    if (interaction.commandName === 'audit-channel') {
      if (!interaction.inGuild()) return interaction.reply({ content: '此指令只能在服务器内使用。', ephemeral: true });
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
      }

      const channelIds = auditChannelsByGuild.get(interaction.guildId) || [];
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        return interaction.reply({
          ephemeral: true,
          content: channelIds.length
            ? `当前后台审计频道（${channelIds.length}/${maxAuditChannels}）：${channelIds.map((id) => `<#${id}>`).join('、')}`
            : '尚未设置后台审计频道。',
        });
      }

      const channel = interaction.options.getChannel('channel', true);
      if (action === 'add') {
        if (channelIds.includes(channel.id)) return interaction.reply({ content: '这个频道已经在后台列表中。', ephemeral: true });
        if (channelIds.length >= maxAuditChannels) {
          return interaction.reply({ content: `最多只能设置 ${maxAuditChannels} 个后台审计频道。`, ephemeral: true });
        }
        const updated = [...channelIds, channel.id];
        auditChannelsByGuild.set(interaction.guildId, updated);
        await persistGuildConfig(interaction.guild);
        return interaction.reply({ content: `已添加 ${channel}，当前共 ${updated.length}/${maxAuditChannels} 个后台频道。`, ephemeral: true });
      }

      if (action === 'remove') {
        if (!channelIds.includes(channel.id)) return interaction.reply({ content: '这个频道不在后台列表中。', ephemeral: true });
        const updated = channelIds.filter((id) => id !== channel.id);
        if (updated.length) auditChannelsByGuild.set(interaction.guildId, updated);
        else auditChannelsByGuild.delete(interaction.guildId);
        if (updated.length) await persistGuildConfig(interaction.guild);
        return interaction.reply({ content: `已移除 ${channel}，当前共 ${updated.length}/${maxAuditChannels} 个后台频道。`, ephemeral: true });
      }
    }
  } catch (error) {
    console.error(`Command ${interaction.commandName} failed:`, error);
    const message = { content: '执行指令时发生错误，请检查机器人权限与服务器设置。', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(message).catch(() => null);
    else await interaction.reply(message).catch(() => null);
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (!auditChannelsByGuild.has(newMember.guild.id)) return;
  if (oldMember.nickname !== newMember.nickname) {
    const executor = await findRecentExecutor(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('成员昵称变动')
      .addFields(
        { name: '成员', value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: false },
        { name: '修改前', value: clip(oldMember.nickname || '无昵称'), inline: true },
        { name: '修改后', value: clip(newMember.nickname || '无昵称'), inline: true },
        { name: '操作者', value: executor ? `${executor.tag} (<@${executor.id}>)` : '成员本人或无法确认', inline: false },
      )
      .setTimestamp();
    await sendAudit(newMember.guild, embed);
  }

  const added = newMember.roles.cache.filter((role) => !oldMember.roles.cache.has(role.id));
  const removed = oldMember.roles.cache.filter((role) => !newMember.roles.cache.has(role.id));
  if (!added.size && !removed.size) return;
  const executor = await findRecentExecutor(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('成员身份组变动')
    .addFields(
      { name: '成员', value: `${newMember.user.tag} (<@${newMember.id}>)`, inline: false },
      { name: '新增身份组', value: added.size ? added.map((role) => role.name).join('、') : '无', inline: true },
      { name: '移除身份组', value: removed.size ? removed.map((role) => role.name).join('、') : '无', inline: true },
      { name: '操作者', value: executor ? `${executor.tag} (<@${executor.id}>)` : '无法确认', inline: false },
    )
    .setTimestamp();
  await sendAudit(newMember.guild, embed);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot || isAuditChannel(newMessage.channelId, newMessage.guild.id)) return;
  if (!oldMessage.content && !newMessage.content) return;
  if (oldMessage.content === newMessage.content) return;
  const author = newMessage.author || oldMessage.author;
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('消息编辑')
    .addFields(
      { name: '发送者', value: author ? `${author.tag} (<@${author.id}>)` : '无法确认', inline: false },
      { name: '频道', value: `<#${newMessage.channelId}>`, inline: true },
      { name: '消息发送时间', value: `<t:${Math.floor((newMessage.createdTimestamp || Date.now()) / 1000)}:F>`, inline: true },
      { name: '编辑时间', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      { name: '编辑前文字', value: code(oldMessage.content || '(无法取得原文字)') },
      { name: '编辑后文字', value: code(newMessage.content || '(已清空文字)') },
    )
    .setFooter({ text: `Message ID: ${newMessage.id}` });
  await sendAudit(newMessage.guild, embed);
});

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot || isAuditChannel(message.channelId, message.guild.id)) return;
  const deleter = await findRecentExecutor(message.guild, AuditLogEvent.MessageDelete, message.author?.id);
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('消息删除')
    .addFields(
      { name: '发送者', value: message.author ? `${message.author.tag} (<@${message.author.id}>)` : '无法确认', inline: false },
      { name: '删除者', value: deleter ? `${deleter.tag} (<@${deleter.id}>)` : '发送者本人或无法确认', inline: false },
      { name: '频道', value: `<#${message.channelId}>`, inline: true },
      { name: '发送时间', value: `<t:${Math.floor((message.createdTimestamp || Date.now()) / 1000)}:F>`, inline: true },
      { name: '删除时间', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
      { name: '删除前文字', value: code(message.content || '(无法取得文字内容)') },
    )
    .setFooter({ text: `Message ID: ${message.id}` });
  await sendAudit(message.guild, embed);
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
client.login(token);
