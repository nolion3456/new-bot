const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'giveaways.json');
const giveaways = new Map();
const timers = new Map();
const drafts = new Map();

const giveawayCommand = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('管理服务器抽奖活动')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
  .addSubcommand((subcommand) => subcommand
    .setName('create')
    .setDescription('创建抽奖并打开发布前私密设置面板')
    .addStringOption((option) => option.setName('duration').setDescription('持续时间，例如 1d、1h、10m').setRequired(true))
    .addIntegerOption((option) => option.setName('winners').setDescription('获奖人数').setMinValue(1).setMaxValue(50).setRequired(true))
    .addStringOption((option) => option.setName('prize').setDescription('奖品').setMaxLength(256).setRequired(true))
    .addChannelOption((option) => option.setName('channel').setDescription('抽奖频道').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('end').setDescription('提前结束抽奖并抽取获奖者').addStringOption((option) => option.setName('message_id').setDescription('抽奖消息 ID').setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('reroll').setDescription('重新抽取获奖者').addStringOption((option) => option.setName('message_id').setDescription('已结束抽奖消息 ID').setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('list').setDescription('列出服务器正在进行的抽奖'))
  .addSubcommand((subcommand) => subcommand.setName('delete').setDescription('删除抽奖').addStringOption((option) => option.setName('message_id').setDescription('抽奖消息 ID').setRequired(true)));

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const item of raw) giveaways.set(item.id, item);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load giveaways:', error.message);
  }
}

function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...giveaways.values()], null, 2));
  fs.renameSync(temporary, dataFile);
}

function parseDuration(value) {
  const match = String(value).trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d|w)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  const milliseconds = amount * multiplier;
  return milliseconds >= 10_000 && milliseconds <= 365 * 86_400_000 ? milliseconds : null;
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(value / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [days ? `${days}天` : '', hours ? `${hours}小时` : '', minutes ? `${minutes}分` : '', remaining ? `${remaining}秒` : ''].filter(Boolean).join(' ') || '即将结束';
}

function statusText(giveaway) {
  if (giveaway.status === 'active') return `<t:${Math.floor(giveaway.endsAt / 1000)}:R>`;
  return '已结束';
}

function giveawayEmbed(giveaway) {
  const entries = giveaway.entries.length;
  const embed = new EmbedBuilder()
    .setColor(giveaway.status === 'active' ? 0xffc107 : 0x747f8d)
    .setTitle('🎉 抽奖活动 🎉')
    .setDescription(`**奖品**\n${giveaway.prize}\n\n点击下方 🎉 按钮参加抽奖！`)
    .addFields(
      { name: '获奖人数', value: String(giveaway.winners), inline: true },
      { name: '参加人数', value: String(entries), inline: true },
      { name: '剩余时间', value: statusText(giveaway), inline: true },
    )
    .setFooter({ text: giveaway.extraRoleId ? '需要指定身份组才能参加' : '所有成员均可参加' })
    .setTimestamp(new Date(giveaway.createdAt));
  if (giveaway.winnersList?.length) embed.addFields({ name: '获奖者', value: giveaway.winnersList.map((id) => `<@${id}>`).join('、') });
  return embed;
}

function giveawayComponents(giveaway) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway:enter:${giveaway.id}`)
      .setLabel(giveaway.status === 'active' ? '🎉 参加抽奖' : '抽奖已结束')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(giveaway.status !== 'active'),
  )];
}

function previewEmbed(draft) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎉 抽奖发布设置')
    .setDescription('这是只有你能看到的发布前设置面板。选择额外入场身份组后，在操作菜单选择“发布抽奖”。')
    .addFields(
      { name: '奖品', value: draft.prize, inline: false },
      { name: '获奖人数', value: String(draft.winners), inline: true },
      { name: '持续时间', value: formatDuration(draft.durationMs), inline: true },
      { name: '抽奖频道', value: `<#${draft.channelId}>`, inline: true },
      { name: '额外入场身份组', value: draft.extraRoleId ? `<@&${draft.extraRoleId}>` : '不限制身份组', inline: false },
    );
}

function previewComponents(draft) {
  const roleSelect = new RoleSelectMenuBuilder().setCustomId('giveaway:draft-role').setPlaceholder('可选：选择额外入场身份组').setMinValues(1).setMaxValues(1);
  const actionSelect = new StringSelectMenuBuilder().setCustomId('giveaway:draft-action').setPlaceholder('选择发布操作').addOptions(
    new StringSelectMenuOptionBuilder().setLabel('发布抽奖').setValue('publish').setDescription('发送抽奖面板到指定频道'),
    new StringSelectMenuOptionBuilder().setLabel('取消').setValue('cancel').setDescription('取消这次抽奖设置'),
  );
  return [new ActionRowBuilder().addComponents(roleSelect), new ActionRowBuilder().addComponents(actionSelect)];
}

function pickWinners(entries, count, excluded = []) {
  const pool = entries.filter((id) => !excluded.includes(id));
  const source = pool.length >= count ? pool : entries;
  const copy = [...new Set(source)];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = crypto.randomInt(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy.slice(0, count);
}

async function fetchMessage(client, giveaway) {
  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  return channel.messages.fetch(giveaway.messageId).catch(() => null);
}

async function refreshMessage(client, giveaway) {
  const message = await fetchMessage(client, giveaway);
  if (!message) return;
  await message.edit({ embeds: [giveawayEmbed(giveaway)], components: giveawayComponents(giveaway) }).catch(() => null);
}

function scheduleGiveaway(client, giveaway) {
  if (timers.has(giveaway.id)) clearTimeout(timers.get(giveaway.id));
  if (giveaway.status !== 'active') return;
  const remaining = giveaway.endsAt - Date.now();
  if (remaining <= 0) {
    endGiveaway(client, giveaway, false).catch((error) => console.error('Automatic giveaway end failed:', error));
    return;
  }
  timers.set(giveaway.id, setTimeout(() => endGiveaway(client, giveaway, false).catch((error) => console.error('Automatic giveaway end failed:', error)), remaining));
  refreshMessage(client, giveaway).catch(() => null);
}

async function endGiveaway(client, giveaway, manual) {
  if (giveaway.status !== 'active') return false;
  giveaway.status = 'ended';
  giveaway.endedAt = Date.now();
  giveaway.winnersList = pickWinners(giveaway.entries, giveaway.winners);
  saveData();
  if (timers.has(giveaway.id)) clearTimeout(timers.get(giveaway.id));
  const message = await fetchMessage(client, giveaway);
  if (message) {
    await message.edit({ embeds: [giveawayEmbed(giveaway)], components: giveawayComponents(giveaway) }).catch(() => null);
    const channel = message.channel;
    const announcement = giveaway.winnersList.length
      ? `🎉 抽奖结束！恭喜 ${giveaway.winnersList.map((id) => `<@${id}>`).join('、')} 获得 **${giveaway.prize}**！`
      : `🎉 抽奖结束，但没有符合条件的参加者。奖品：**${giveaway.prize}**`;
    await channel.send({ content: announcement }).catch(() => null);
  }
  return true;
}

async function rerollGiveaway(client, giveaway) {
  if (giveaway.status !== 'ended') return false;
  const previous = giveaway.winnersList || [];
  giveaway.winnersList = pickWinners(giveaway.entries, giveaway.winners, previous);
  saveData();
  const message = await fetchMessage(client, giveaway);
  if (message) {
    await message.edit({ embeds: [giveawayEmbed(giveaway)], components: giveawayComponents(giveaway) }).catch(() => null);
    await message.channel.send({ content: giveaway.winnersList.length ? `🎉 重新抽奖结果：${giveaway.winnersList.map((id) => `<@${id}>`).join('、')} 获得 **${giveaway.prize}**！` : '没有可重新抽取的参加者。' }).catch(() => null);
  }
  return true;
}

function isManager(interaction) {
  return interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function draftKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

async function handleGiveawayInteraction(client, interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'giveaway') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'create') {
      const durationMs = parseDuration(interaction.options.getString('duration'));
      if (!durationMs) return interaction.reply({ content: '持续时间格式无效。请使用例如 `10m`、`1h`、`1d`，范围为 10 秒至 365 天。', ephemeral: true });
      const channel = interaction.options.getChannel('channel');
      if (!channel?.isTextBased()) return interaction.reply({ content: '请选择文字频道。', ephemeral: true });
      const draft = {
        guildId: interaction.guildId,
        creatorId: interaction.user.id,
        channelId: channel.id,
        durationMs,
        winners: interaction.options.getInteger('winners'),
        prize: interaction.options.getString('prize'),
        extraRoleId: null,
      };
      drafts.set(draftKey(interaction), draft);
      return interaction.reply({ content: '请检查设置并选择额外入场身份组，然后在操作菜单发布。', embeds: [previewEmbed(draft)], components: previewComponents(draft), ephemeral: true });
    }
    const messageId = interaction.options.getString('message_id');
    if (subcommand === 'list') {
      const active = [...giveaways.values()].filter((item) => item.guildId === interaction.guildId && item.status === 'active');
      return interaction.reply({ ephemeral: true, content: active.length ? active.map((item) => `• [${item.prize}](https://discord.com/channels/${item.guildId}/${item.channelId}/${item.messageId}) — ${item.winners} 位获奖者，结束 ${statusText(item)}，参加人数 ${item.entries.length}`).join('\n') : '目前没有进行中的抽奖。' });
    }
    const giveaway = giveaways.get(messageId);
    if (!giveaway || giveaway.guildId !== interaction.guildId) return interaction.reply({ content: '找不到这个服务器中的抽奖。请确认 message_id。', ephemeral: true });
    if (subcommand === 'end') {
      if (giveaway.status !== 'active') return interaction.reply({ content: '这个抽奖已经结束。', ephemeral: true });
      await endGiveaway(client, giveaway, true);
      return interaction.reply({ content: '已提前结束抽奖并抽取获奖者。', ephemeral: true });
    }
    if (subcommand === 'reroll') {
      if (giveaway.status !== 'ended') return interaction.reply({ content: '只能重新抽取已经结束的抽奖。', ephemeral: true });
      await rerollGiveaway(client, giveaway);
      return interaction.reply({ content: '已重新抽取获奖者。', ephemeral: true });
    }
    if (subcommand === 'delete') {
      const message = await fetchMessage(client, giveaway);
      await message?.delete().catch(() => null);
      giveaways.delete(giveaway.id);
      saveData();
      return interaction.reply({ content: '已删除抽奖和保存的数据。', ephemeral: true });
    }
  }

  if (interaction.isRoleSelectMenu() && interaction.customId === 'giveaway:draft-role') {
    const draft = drafts.get(draftKey(interaction));
    if (!draft) return interaction.reply({ content: '这个抽奖设置面板已过期，请重新使用 `/giveaway create`。', ephemeral: true });
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    draft.extraRoleId = interaction.values[0];
    return interaction.update({ content: '已设置额外入场身份组。现在请在操作菜单选择“发布抽奖”。', embeds: [previewEmbed(draft)], components: previewComponents(draft) });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'giveaway:draft-action') {
    const draft = drafts.get(draftKey(interaction));
    if (!draft) return interaction.reply({ content: '这个抽奖设置面板已过期，请重新使用 `/giveaway create`。', ephemeral: true });
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    if (interaction.values[0] === 'cancel') {
      drafts.delete(draftKey(interaction));
      return interaction.update({ content: '已取消抽奖创建。', embeds: [], components: [] });
    }
    const giveaway = {
      id: crypto.randomUUID(),
      guildId: draft.guildId,
      channelId: draft.channelId,
      messageId: null,
      prize: draft.prize,
      winners: draft.winners,
      durationMs: draft.durationMs,
      createdAt: Date.now(),
      endsAt: Date.now() + draft.durationMs,
      creatorId: draft.creatorId,
      extraRoleId: draft.extraRoleId,
      entries: [],
      winnersList: [],
      status: 'active',
    };
    const channel = await client.channels.fetch(draft.channelId).catch(() => null);
    if (!channel?.isTextBased()) return interaction.reply({ content: '无法访问指定抽奖频道，请检查 Bot 的频道权限。', ephemeral: true });
    const message = await channel.send({ embeds: [giveawayEmbed(giveaway)], components: giveawayComponents(giveaway) }).catch(() => null);
    if (!message) return interaction.reply({ content: '发布抽奖失败，请检查 Bot 是否有发送消息、嵌入链接和使用按钮权限。', ephemeral: true });
    giveaway.messageId = message.id;
    giveaways.set(giveaway.id, giveaway);
    saveData();
    drafts.delete(draftKey(interaction));
    scheduleGiveaway(client, giveaway);
    return interaction.update({ content: `抽奖已发布到 <#${draft.channelId}>。消息 ID：\`${message.id}\``, embeds: [], components: [] });
  }

  if (interaction.isButton() && interaction.customId.startsWith('giveaway:enter:')) {
    const giveawayId = interaction.customId.split(':')[2];
    const giveaway = giveaways.get(giveawayId);
    if (!giveaway || giveaway.status !== 'active') return interaction.reply({ content: '这个抽奖已经结束或不存在。', ephemeral: true });
    if (giveaway.extraRoleId && !interaction.member.roles.cache.has(giveaway.extraRoleId)) return interaction.reply({ content: `你需要身份组 <@&${giveaway.extraRoleId}> 才能参加这个抽奖。`, ephemeral: true });
    if (giveaway.entries.includes(interaction.user.id)) return interaction.reply({ content: '你已经参加这个抽奖了。', ephemeral: true });
    giveaway.entries.push(interaction.user.id);
    saveData();
    await interaction.update({ embeds: [giveawayEmbed(giveaway)], components: giveawayComponents(giveaway) });
    return;
  }
  return false;
}

function setupGiveaways(client) {
  loadData();
  client.on('ready', () => {
    for (const giveaway of giveaways.values()) if (giveaway.status === 'active') scheduleGiveaway(client, giveaway);
  });
  client.on('interactionCreate', (interaction) => handleGiveawayInteraction(client, interaction).catch((error) => {
    console.error('Giveaway interaction failed:', error);
    const response = { content: '抽奖操作失败，请检查 Bot 权限和配置。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { giveawayCommand, setupGiveaways };
