const express = require('express');
const {
  AuditLogEvent,
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { giveawayCommand, setupGiveaways } = require('./giveaways');

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const port = Number(process.env.PORT || 3000);
const maxAuditChannels = 3;
const configMarker = 'new-bot-audit-config-v2';
const auditEventOptions = [
  { value: 'roleChange', label: '身份组变动', description: '成员身份组新增或移除' },
  { value: 'nicknameChange', label: '昵称变动', description: '成员昵称修改前后' },
  { value: 'messageEdit', label: '编辑文字', description: '消息编辑前后文字与时间' },
  { value: 'messageDelete', label: '删除文字', description: '消息发送与删除信息' },
  { value: 'memberJoin', label: '成员加入', description: '成员加入与帐号创建时间' },
  { value: 'memberLeave', label: '成员离开', description: '成员离开与帐号创建时间' },
];
const defaultAuditEvents = new Set(auditEventOptions.map((option) => option.value));
const auditChannelsByGuild = new Map();
const enabledAuditEventsByGuild = new Map();
const selectedAuditChannelByUser = new Map();
const recentAuditDeliveries = new Map();

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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()),
  giveawayCommand,
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
app.get('/', (_req, res) => res.status(200).send('Bot is alive'));
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

function enabledAuditEvents(guildIdValue) {
  return enabledAuditEventsByGuild.get(guildIdValue) || defaultAuditEvents;
}

function configEmbed(guildIdValue, channelIds) {
  const enabled = enabledAuditEvents(guildIdValue);
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('后台审计频道配置')
    .setDescription(`当前配置 ${channelIds.length}/${maxAuditChannels} 个频道。请勿删除此配置消息，否则机器人可能无法在重启后恢复设置。`)
    .addFields(
      { name: '频道', value: channelIds.length ? channelIds.map((id) => `<#${id}>`).join('\n') : '未设置' },
      { name: '已开启日志', value: auditEventOptions.filter((option) => enabled.has(option.value)).map((option) => option.label).join('、') || '无' },
    )
    .setFooter({ text: `${configMarker}:${guildIdValue}:${channelIds.join(',')}:${[...enabled].join(',')}` })
    .setTimestamp();
}

async function persistGuildConfig(guild, fallbackChannelId = null) {
  const channelIds = auditChannelsByGuild.get(guild.id) || [];
  const targetChannelId = channelIds[0] || fallbackChannelId;
  if (!targetChannelId) return;
  const channel = await guild.channels.fetch(targetChannelId).catch(() => null);
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
  const encodedParts = latest.embeds[0].footer.text.split(':');
  const encoded = encodedParts[2] || '';
  const ids = encoded.split(',').filter(Boolean).slice(0, maxAuditChannels);
  if (ids.length) auditChannelsByGuild.set(guild.id, ids);
  else auditChannelsByGuild.delete(guild.id);
  const savedEvents = (encodedParts[3] || '').split(',').filter((value) => defaultAuditEvents.has(value));
  enabledAuditEventsByGuild.set(guild.id, new Set(savedEvents.length ? savedEvents : defaultAuditEvents));
}

function auditPanelPayload(guildIdValue, userId, notice = null) {
  const channelIds = auditChannelsByGuild.get(guildIdValue) || [];
  const selectedId = selectedAuditChannelByUser.get(`${guildIdValue}:${userId}`);
  const select = new ChannelSelectMenuBuilder()
    .setCustomId('audit-channel-select')
    .setPlaceholder(selectedId ? `已选择 <#${selectedId}>` : '先选择一个文字频道')
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  const enabled = enabledAuditEvents(guildIdValue);
  const eventOptions = auditEventOptions.map((option) => new StringSelectMenuOptionBuilder()
    .setLabel(option.label)
    .setValue(option.value)
    .setDescription(option.description)
    .setDefault(enabled.has(option.value)));
  if (!enabled.size) eventOptions.push(new StringSelectMenuOptionBuilder().setLabel('关闭所有日志').setValue('none').setDescription('不发送任何审计事件').setDefault(true));
  const eventSelect = new StringSelectMenuBuilder()
    .setCustomId('audit-event-select')
    .setPlaceholder('选择要显示的日志类型（可多选）')
    .setMinValues(1)
    .setMaxValues(auditEventOptions.length)
    .addOptions(eventOptions);
  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId('audit-action-select')
    .setPlaceholder('选择后台频道操作')
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('添加选中的频道').setValue('add').setDescription('将频道加入后台，最多三个'),
      new StringSelectMenuOptionBuilder().setLabel('移除选中的频道').setValue('remove').setDescription('从后台列表移除频道'),
      new StringSelectMenuOptionBuilder().setLabel('刷新当前配置').setValue('list').setDescription('查看当前后台频道'),
    );
  return {
    content: notice || '这是私密的后台审计频道面板。请使用三个下拉菜单选择日志类型、频道和操作。',
    embeds: [configEmbed(guildIdValue, channelIds)],
    components: [new ActionRowBuilder().addComponents(eventSelect), new ActionRowBuilder().addComponents(select), new ActionRowBuilder().addComponents(actionSelect)],
  };
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const commandNames = new Set(commands.map((command) => command.name));
  const globalRoute = Routes.applicationCommands(client.user.id);
  const globalCommands = await rest.get(globalRoute);
  if (guildId) {
    for (const command of globalCommands) {
      if (commandNames.has(command.name)) await rest.delete(`${globalRoute}/${command.id}`);
    }
  } else {
    for (const guild of client.guilds.cache.values()) {
      const guildRoute = Routes.applicationGuildCommands(client.user.id, guild.id);
      const guildCommands = await rest.get(guildRoute);
      for (const command of guildCommands) {
        if (commandNames.has(command.name)) await rest.delete(`${guildRoute}/${command.id}`);
      }
    }
  }
  const route = guildId ? Routes.applicationGuildCommands(client.user.id, guildId) : globalRoute;
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} slash commands ${guildId ? `for guild ${guildId} (old global copies removed)` : 'globally (old guild copies removed)'}.`);
}

async function sendAudit(guild, embed, eventKey = null) {
  const channelIds = [...new Set(auditChannelsByGuild.get(guild.id) || [])];
  if (!channelIds.length) return;
  const embedData = embed.toJSON();
  const fingerprint = eventKey || JSON.stringify({
    title: embedData.title,
    description: embedData.description,
    fields: embedData.fields,
    footer: embedData.footer,
  });
  const now = Date.now();
  for (const channelId of channelIds) {
    const deliveryKey = `${guild.id}:${channelId}:${fingerprint}`;
    const previousDelivery = recentAuditDeliveries.get(deliveryKey);
    if (previousDelivery && now - previousDelivery < 30_000) continue;
    recentAuditDeliveries.set(deliveryKey, now);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) continue;
    await channel.send({ embeds: [embed] }).catch((error) => {
      console.error(`Failed to send audit log to ${channelId}:`, error.message);
    });
  }
  for (const [key, timestamp] of recentAuditDeliveries) {
    if (now - timestamp > 30_000) recentAuditDeliveries.delete(key);
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
  if ((interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu?.()) && interaction.customId.startsWith('giveaway:')) return;
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isChannelSelectMenu() && !interaction.isStringSelectMenu()) return;

  try {
    if (interaction.isButton() || interaction.isChannelSelectMenu() || interaction.isStringSelectMenu()) {
      if (!interaction.inGuild()) return interaction.reply({ content: '此面板只能在服务器内使用。', ephemeral: true });
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '你需要“管理服务器”权限才能操作这个后台面板。', ephemeral: true });
      }

      const selectionKey = `${interaction.guildId}:${interaction.user.id}`;
      if (interaction.isStringSelectMenu() && interaction.customId === 'audit-event-select') {
        const selectedEvents = interaction.values.includes('none') ? [] : interaction.values;
        enabledAuditEventsByGuild.set(interaction.guildId, new Set(selectedEvents));
        await interaction.deferUpdate();
        await persistGuildConfig(interaction.guild);
        const labels = auditEventOptions.filter((option) => selectedEvents.includes(option.value)).map((option) => option.label);
        return interaction.editReply(auditPanelPayload(interaction.guildId, interaction.user.id, `已更新后台显示内容：${labels.length ? labels.join('、') : '不显示任何事件'}。`));
      }

      if (interaction.isChannelSelectMenu()) {
        selectedAuditChannelByUser.set(selectionKey, interaction.values[0]);
        return interaction.update(auditPanelPayload(interaction.guildId, interaction.user.id, `已选择 <#${interaction.values[0]}>。现在可以在操作下拉菜单中选择添加、移除或刷新。`));
      }

      if (interaction.isStringSelectMenu() && interaction.customId === 'audit-action-select') {
        const action = interaction.values[0];
        if (action === 'list') {
          const ids = auditChannelsByGuild.get(interaction.guildId) || [];
          const summary = ids.length ? `当前后台审计频道（${ids.length}/${maxAuditChannels}）：${ids.map((id) => `<#${id}>`).join('、')}` : '尚未设置后台审计频道。';
          return interaction.update(auditPanelPayload(interaction.guildId, interaction.user.id, summary));
        }
        const selectedId = selectedAuditChannelByUser.get(selectionKey);
        if (!selectedId) return interaction.reply({ content: '请先在频道下拉菜单中选择一个文字频道。', ephemeral: true });
        const channelIds = auditChannelsByGuild.get(interaction.guildId) || [];
        await interaction.deferUpdate();
        if (action === 'add') {
          if (channelIds.includes(selectedId)) return interaction.editReply(auditPanelPayload(interaction.guildId, interaction.user.id, '这个频道已经在后台列表中。'));
          if (channelIds.length >= maxAuditChannels) return interaction.editReply(auditPanelPayload(interaction.guildId, interaction.user.id, `最多只能设置 ${maxAuditChannels} 个后台审计频道。`));
          auditChannelsByGuild.set(interaction.guildId, [...channelIds, selectedId]);
          await persistGuildConfig(interaction.guild);
          return interaction.editReply(auditPanelPayload(interaction.guildId, interaction.user.id, `已添加 <#${selectedId}>。`));
        }
        if (!channelIds.includes(selectedId)) return interaction.editReply(auditPanelPayload(interaction.guildId, interaction.user.id, '这个频道不在后台列表中。'));
        const updated = channelIds.filter((id) => id !== selectedId);
        if (updated.length) auditChannelsByGuild.set(interaction.guildId, updated);
        else auditChannelsByGuild.delete(interaction.guildId);
        await persistGuildConfig(interaction.guild, selectedId);
        return interaction.editReply(auditPanelPayload(interaction.guildId, interaction.user.id, `已移除 <#${selectedId}>。`));
      }

      if (interaction.customId === 'audit-channel-list') {
        const ids = auditChannelsByGuild.get(interaction.guildId) || [];
        const summary = ids.length ? `当前后台审计频道（${ids.length}/${maxAuditChannels}）：${ids.map((id) => `<#${id}>`).join('、')}` : '尚未设置后台审计频道。';
        return interaction.update(auditPanelPayload(interaction.guildId, interaction.user.id, summary));
      }

      const selectedId = selectedAuditChannelByUser.get(selectionKey);
      if (!selectedId) return interaction.reply({ content: '请先在面板中选择一个文字频道。', ephemeral: true });
      const channelIds = auditChannelsByGuild.get(interaction.guildId) || [];

      if (interaction.customId === 'audit-channel-add') {
        if (channelIds.includes(selectedId)) return interaction.update(auditPanelPayload(interaction.guildId, interaction.user.id, '这个频道已经在后台列表中。'));
        if (channelIds.length >= maxAuditChannels) return interaction.update(auditPanelPayload(interaction.guildId, interaction.user.id, `最多只能设置 ${maxAuditChannels} 个后台审计频道。`));
        const updated = [...channelIds, selectedId];
        auditChannelsByGuild.set(interaction.guildId, updated);
        await persistGuildConfig(interaction.guild);
        return interaction.update(auditPanelPayload(interaction.guildId, interaction.user.id, `已添加 <#${selectedId}>，当前共 ${updated.length}/${maxAuditChannels} 个后台频道。`));
      }

      if (interaction.customId === 'audit-channel-remove') {
        if (!channelIds.includes(selectedId)) return interaction.update(auditPanelPayload(interaction.guildId, interaction.user.id, '这个频道不在后台列表中。'));
        const updated = channelIds.filter((id) => id !== selectedId);
        if (updated.length) auditChannelsByGuild.set(interaction.guildId, updated);
        else auditChannelsByGuild.delete(interaction.guildId);
        await persistGuildConfig(interaction.guild, selectedId);
        return interaction.update(auditPanelPayload(interaction.guildId, interaction.user.id, `已移除 <#${selectedId}>，当前共 ${updated.length}/${maxAuditChannels} 个后台频道。`));
      }
      return;
    }

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
          '`/audit-channel` 打开管理服务器权限专用的私密后台管理面板',
          '`/giveaway create` 创建抽奖并打开发布前私密设置面板',
          '`/giveaway end|reroll|list|delete` 管理抽奖活动',
          '审计面板可用下拉菜单切换日志类型，并管理最多 3 个后台频道',
        ].join('\n'),
      });
    }

    if (interaction.commandName === 'audit-channel') {
      if (!interaction.inGuild()) return interaction.reply({ content: '此指令只能在服务器内使用。', ephemeral: true });
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '你需要“管理服务器”权限才能打开这个后台面板。', ephemeral: true });
      }

      return interaction.reply({ ...auditPanelPayload(interaction.guildId, interaction.user.id), ephemeral: true });
    }
  } catch (error) {
    console.error(`Interaction ${interaction.commandName || interaction.customId || 'unknown'} failed:`, error);
    const message = { content: '执行指令时发生错误，请检查机器人权限与服务器设置。', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(message).catch(() => null);
    else await interaction.reply(message).catch(() => null);
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (!auditChannelsByGuild.has(newMember.guild.id)) return;
  const enabled = enabledAuditEvents(newMember.guild.id);
  if (enabled.has('nicknameChange') && oldMember.nickname !== newMember.nickname) {
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
    await sendAudit(newMember.guild, embed, `nickname:${newMember.id}:${oldMember.nickname || ''}:${newMember.nickname || ''}`);
  }

  if (!enabled.has('roleChange')) return;
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
  await sendAudit(newMember.guild, embed, `roles:${newMember.id}:${added.map((role) => role.id).sort().join(',')}:${removed.map((role) => role.id).sort().join(',')}`);
});

client.on('guildMemberAdd', async (member) => {
  if (!auditChannelsByGuild.has(member.guild.id) || !enabledAuditEvents(member.guild.id).has('memberJoin')) return;
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('成员加入服务器')
    .addFields(
      { name: '成员', value: `${member.user.tag} (<@${member.id}>)`, inline: false },
      { name: '帐号创建时间', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`, inline: true },
      { name: '加入时间', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
    )
    .setTimestamp();
  await sendAudit(member.guild, embed, `member-join:${member.id}`);
});

client.on('guildMemberRemove', async (member) => {
  if (!auditChannelsByGuild.has(member.guild.id) || !enabledAuditEvents(member.guild.id).has('memberLeave')) return;
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('成员离开服务器')
    .addFields(
      { name: '成员', value: `${member.user.tag} (<@${member.id}>)`, inline: false },
      { name: '帐号创建时间', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`, inline: true },
      { name: '离开时间', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
    )
    .setTimestamp();
  await sendAudit(member.guild, embed, `member-leave:${member.id}`);
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || !enabledAuditEvents(newMessage.guild.id).has('messageEdit') || newMessage.author?.bot || isAuditChannel(newMessage.channelId, newMessage.guild.id)) return;
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
  await sendAudit(newMessage.guild, embed, `message-edit:${newMessage.id}:${oldMessage.content || ''}:${newMessage.content || ''}`);
});

client.on('messageDelete', async (message) => {
  if (!message.guild || !enabledAuditEvents(message.guild.id).has('messageDelete') || message.author?.bot || isAuditChannel(message.channelId, message.guild.id)) return;
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
  await sendAudit(message.guild, embed, `message-delete:${message.id}`);
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
setupGiveaways(client);
client.login(token);
