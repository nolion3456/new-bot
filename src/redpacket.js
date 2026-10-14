const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { changeBalance, getBalance, getGuildData, formatMoney, parseMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'redpackets.json');
const autoClaimDataFile = path.join(dataDir, 'redpacket-auto-claim.json');
const packets = new Map();
const timers = new Map();
const autoClaimRules = new Map();
let auditSender = null;
const botManagerId = String(process.env.BOT_MANAGER_ID || '').trim();

const redPacketCommand = new SlashCommandBuilder()
  .setName('redpacket')
  .setDescription('发送福袋活动')
  .addSubcommand((subcommand) => subcommand
    .setName('create')
    .setDescription('发送一个可供成员领取的福袋')
    .addStringOption((option) => option.setName('amount').setDescription('福袋总金额，使用迷你币，最多两位小数').setRequired(true))
    .addIntegerOption((option) => option.setName('count').setDescription('最多领取人数').setMinValue(1).setMaxValue(10_000).setRequired(true))
    .addStringOption((option) => option.setName('mode').setDescription('分配方式').setRequired(true).addChoices(
      { name: '平均分配', value: 'average' },
      { name: '拼手气', value: 'lucky' },
    ))
    .addRoleOption((option) => option.setName('role').setDescription('领取条件身份组（可选）').setRequired(false))
    .addStringOption((option) => option.setName('duration').setDescription('结束时间，例如 10m、2h、1d；留空则直到抢完').setRequired(false)));

redPacketCommand.addSubcommand((subcommand) => subcommand
  .setName('auto-add')
  .setDescription('设置指定成员自动抢福袋的优先顺序')
  .addUserOption((option) => option.setName('user').setDescription('要加入自动抢福袋的成员').setRequired(true))
  .addStringOption((option) => option.setName('duration').setDescription('持续时间：10s、30m、2h、1d；填写 -1 代表永久').setRequired(true)));
redPacketCommand.addSubcommand((subcommand) => subcommand
  .setName('auto-list')
  .setDescription('查看自动抢福袋优先级'));
redPacketCommand.addSubcommand((subcommand) => subcommand
  .setName('auto-remove')
  .setDescription('取消指定成员的自动抢福袋')
  .addUserOption((option) => option.setName('user').setDescription('要取消的成员').setRequired(true)));

function setRedPacketAuditSender(sender) {
  auditSender = sender;
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const packet of Array.isArray(raw) ? raw : Object.values(raw)) {
      if (packet?.id && packet.status === 'active') packets.set(packet.id, normalizePacket(packet));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load red packets:', error.message);
  }
}

function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...packets.values()], null, 2));
  fs.renameSync(temporary, dataFile);
}

function loadAutoClaimData() {
  try {
    const raw = JSON.parse(fs.readFileSync(autoClaimDataFile, 'utf8'));
    for (const [guildId, rules] of Object.entries(raw)) {
      if (Array.isArray(rules)) autoClaimRules.set(guildId, rules.filter((rule) => rule?.userId && (rule.expiresAt === null || Number.isFinite(Number(rule.expiresAt)))));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load red packet auto-claim settings:', error.message);
  }
}

function saveAutoClaimData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${autoClaimDataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(autoClaimRules.entries()), null, 2));
  fs.renameSync(temporary, autoClaimDataFile);
}

function activeAutoClaimRules(guildId) {
  const rules = autoClaimRules.get(String(guildId)) || [];
  const now = Date.now();
  const active = rules.filter((rule) => rule.expiresAt === null || Number(rule.expiresAt) > now);
  if (active.length !== rules.length) {
    if (active.length) autoClaimRules.set(String(guildId), active);
    else autoClaimRules.delete(String(guildId));
    saveAutoClaimData();
  }
  return active;
}

function parseAutoClaimDuration(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === '-1') return null;
  const match = text.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) return undefined;
  const milliseconds = Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number.isSafeInteger(milliseconds) && milliseconds >= 1000 && milliseconds <= 365 * 86_400_000 ? Date.now() + milliseconds : undefined;
}

function autoClaimIdsForGuild(guildId) {
  return activeAutoClaimRules(guildId).map((rule) => rule.userId);
}

function normalizePacket(packet) {
  return {
    ...packet,
    amountCents: Number(packet.amountCents) || 0,
    remainingCents: Number.isInteger(Number(packet.remainingCents)) ? Number(packet.remainingCents) : Number(packet.amountCents) || 0,
    maxClaims: Number(packet.maxClaims) || 1,
    claims: Array.isArray(packet.claims) ? packet.claims : [],
    allocations: packet.allocations && typeof packet.allocations === 'object' ? packet.allocations : {},
    status: packet.status || 'active',
  };
}

function parseDuration(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+)\s*(m|h|d)$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const milliseconds = amount * multiplier;
  return Number.isSafeInteger(milliseconds) && milliseconds >= 60_000 && milliseconds <= 365 * 86_400_000 ? milliseconds : undefined;
}

function parseCents(value) {
  const parsed = parseMoney(value);
  return parsed === null ? null : Math.round(parsed * 100);
}

function canManageAutoClaim(interaction) {
  return Boolean(interaction.guild && (interaction.guild.ownerId === interaction.user.id || (botManagerId && botManagerId === interaction.user.id)));
}

function clearTimer(id) {
  if (timers.has(id)) clearTimeout(timers.get(id));
  timers.delete(id);
}

function packetEmbed(packet, currency) {
  const claimed = packet.claims.length;
  const active = packet.status === 'active';
  const roleText = packet.requiredRoleId ? `\n领取条件：需要身份组 <@&${packet.requiredRoleId}>` : '\n领取条件：所有成员均可领取';
  const embed = new EmbedBuilder()
    .setColor(active ? 0xe74c3c : 0x747f8d)
    .setTitle(`${active ? '🧧' : '🔒'} 福袋${active ? '' : '（已结束）'}`)
    .setDescription(`点击下方按钮抢福袋！${roleText}`)
    .addFields(
      { name: '福袋总额', value: `${formatMoney(packet.amountCents / 100)} ${currency}`, inline: true },
      { name: '分配方式', value: packet.mode === 'lucky' ? '拼手气' : '平均分配', inline: true },
      { name: '已领取人数', value: `${claimed}/${packet.maxClaims}`, inline: true },
      { name: '截止时间', value: packet.endsAt ? `<t:${Math.floor(packet.endsAt / 1000)}:R>` : '抢完即止', inline: true },
    )
    .setFooter({ text: `福袋 ID：${packet.id}` })
    .setTimestamp(new Date(packet.createdAt));
  if (packet.highestUserId && packet.mode === 'lucky') embed.addFields({ name: '当前手气最佳', value: `<@${packet.highestUserId}>（抢到 ${formatMoney(packet.highestCents / 100)} ${currency}）`, inline: false });
  return embed;
}

function packetComponents(packet) {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`redpacket:claim:${packet.id}`)
    .setLabel(packet.status === 'active' ? '🧧 抢福袋' : '已结束')
    .setStyle(packet.status === 'active' ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(packet.status !== 'active'))];
}

function allocate(packet) {
  const remainingClaims = packet.maxClaims - packet.claims.length;
  if (remainingClaims <= 1) return packet.remainingCents;
  if (packet.mode === 'average') return Math.floor(packet.remainingCents / remainingClaims);
  const min = 1;
  const max = packet.remainingCents - min * (remainingClaims - 1);
  return min + Math.floor(Math.random() * Math.max(1, max - min + 1));
}

function claimForUser(packet, userId) {
  if (!packet || packet.status !== 'active' || packet.claims.includes(userId)) return null;
  if (packet.claims.length >= packet.maxClaims || packet.remainingCents <= 0) return null;
  const cents = allocate(packet);
  packet.claims.push(userId);
  packet.allocations[userId] = cents;
  packet.remainingCents -= cents;
  if (cents > packet.highestCents) {
    packet.highestCents = cents;
    packet.highestUserId = userId;
  }
  return cents;
}

async function autoClaimPacket(client, packet) {
  if (!autoClaimIdsForGuild(packet.guildId).length) return false;
  const guild = client.guilds.cache.get(packet.guildId) || await client.guilds.fetch(packet.guildId).catch(() => null);
  if (!guild) return false;
  const channel = await guild.channels.fetch(packet.channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.permissionsFor !== 'function') return false;
  let claimed = false;
  for (const userId of autoClaimIdsForGuild(packet.guildId)) {
    if (packet.claims.length >= packet.maxClaims || packet.remainingCents <= 0) break;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || (packet.requiredRoleId && !member.roles.cache.has(packet.requiredRoleId))) continue;
    const permissions = channel.permissionsFor(member);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel)) continue;
    const cents = claimForUser(packet, userId);
    if (!cents) continue;
    changeBalance(packet.guildId, userId, cents / 100, { reason: `自动抢到福袋（${packet.mode === 'lucky' ? '拼手气' : '平均分配'}）`, actorLabel: '系统（福袋自动领取）' });
    claimed = true;
  }
  if (!claimed) return false;
  saveData();
  const message = channel?.messages ? await channel.messages.fetch(packet.messageId).catch(() => null) : null;
  if (message) await message.edit({ embeds: [packetEmbed(packet, getGuildData(packet.guildId).name)], components: packetComponents(packet) }).catch(() => null);
  if (packet.claims.length >= packet.maxClaims || packet.remainingCents <= 0) await finishPacket(client, packet.id, 'claimed');
  return true;
}

async function finishPacket(client, id, reason = 'ended') {
  const packet = packets.get(id);
  if (!packet || packet.status !== 'active') return false;
  clearTimer(id);
  packet.status = reason === 'claimed' ? 'claimed' : 'expired';
  if (reason !== 'claimed' && packet.remainingCents > 0) {
    changeBalance(packet.guildId, packet.creatorId, packet.remainingCents / 100, { reason: '福袋到期退回未领取金额', actorLabel: '系统（福袋）' });
    packet.refundedCents = packet.remainingCents;
    packet.remainingCents = 0;
  }
  saveData();
  const guild = client.guilds.cache.get(packet.guildId) || await client.guilds.fetch(packet.guildId).catch(() => null);
  if (guild) {
    const channel = await guild.channels.fetch(packet.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const message = await channel.messages.fetch(packet.messageId).catch(() => null);
      if (message) await message.edit({ embeds: [packetEmbed(packet, getGuildData(packet.guildId).name)], components: packetComponents(packet) }).catch(() => null);
      if (reason === 'claimed' && auditSender) {
        await auditSender({ guild, packet, memberIds: packet.claims }).catch((error) => console.error('Red packet audit failed:', error.message));
      }
    }
  }
  return true;
}

function schedulePacket(client, packet) {
  clearTimer(packet.id);
  if (!packet.endsAt) return;
  const delay = Math.max(1000, packet.endsAt - Date.now());
  timers.set(packet.id, setTimeout(() => finishPacket(client, packet.id, 'expired'), delay));
}

async function createPacket(interaction) {
  const amountCents = parseCents(interaction.options.getString('amount'));
  const maxClaims = interaction.options.getInteger('count');
  const mode = interaction.options.getString('mode');
  const role = interaction.options.getRole('role');
  const durationText = interaction.options.getString('duration') || '';
  const durationMs = parseDuration(durationText);
  if (amountCents === null || amountCents <= 0 || amountCents < maxClaims || durationMs === undefined) {
    return interaction.reply({ content: '金额必须大于 0，且至少能让每位成员领取 0.01；结束时间请使用 `10m`、`2h` 或 `1d`，也可以留空。', ephemeral: true });
  }
  const balance = getBalance(interaction.guildId, interaction.user.id);
  if (balance * 100 < amountCents) return interaction.reply({ content: `你的迷你币余额不足，需要 ${formatMoney(amountCents / 100)}，当前余额为 ${formatMoney(balance)}。`, ephemeral: true });
  const packet = {
    id: `${Date.now()}-${interaction.user.id}-${Math.random().toString(36).slice(2, 7)}`,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    creatorId: interaction.user.id,
    amountCents,
    remainingCents: amountCents,
    maxClaims,
    mode,
    requiredRoleId: role?.id || null,
    endsAt: durationMs ? Date.now() + durationMs : null,
    createdAt: Date.now(),
    status: 'active',
    claims: [],
    allocations: {},
    highestUserId: null,
    highestCents: 0,
  };
  changeBalance(interaction.guildId, interaction.user.id, -(amountCents / 100), { reason: `创建福袋（${mode === 'lucky' ? '拼手气' : '平均分配'}）`, actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
  const message = await interaction.channel.send({ embeds: [packetEmbed(packet, getGuildData(interaction.guildId).name)], components: packetComponents(packet) }).catch(() => null);
  if (!message) {
    changeBalance(interaction.guildId, interaction.user.id, amountCents / 100, { reason: '福袋发布失败退款', actorLabel: '系统（福袋）' });
    return interaction.reply({ content: '福袋发布失败，已退回扣除的迷你币。', ephemeral: true });
  }
  packet.messageId = message.id;
  packets.set(packet.id, packet);
  saveData();
  await autoClaimPacket(interaction.client, packet);
  schedulePacket(interaction.client, packet);
  return interaction.reply({ content: `福袋已发布：${message.url}`, ephemeral: true });
}

async function claimPacket(interaction, id) {
  const packet = packets.get(id);
  if (!packet || packet.status !== 'active') return interaction.reply({ content: '这个福袋已经结束。', ephemeral: true });
  if (packet.endsAt && Date.now() >= packet.endsAt) {
    await finishPacket(interaction.client, id, 'expired');
    return interaction.reply({ content: '这个福袋已经到达结束时间。', ephemeral: true });
  }
  if (packet.claims.includes(interaction.user.id)) return interaction.reply({ content: '你已经抢过这个福袋了。', ephemeral: true });
  if (packet.requiredRoleId && !interaction.member.roles.cache.has(packet.requiredRoleId)) return interaction.reply({ content: `你需要身份组 <@&${packet.requiredRoleId}> 才能抢这个福袋。`, ephemeral: true });
  if (packet.claims.length >= packet.maxClaims || packet.remainingCents <= 0) {
    await finishPacket(interaction.client, id, 'claimed');
    return interaction.reply({ content: '这个福袋已经被抢完了。', ephemeral: true });
  }
  const cents = claimForUser(packet, interaction.user.id);
  if (!cents) return interaction.reply({ content: '这个福袋已经被抢完了。', ephemeral: true });
  const result = changeBalance(interaction.guildId, interaction.user.id, cents / 100, { reason: `抢到福袋（${packet.mode === 'lucky' ? '拼手气' : '平均分配'}）`, actorLabel: '系统（福袋）' });
  saveData();
  const currency = getGuildData(interaction.guildId).name;
  const embed = new EmbedBuilder().setColor(0x57f287).setTitle('🧧 福袋领取成功').setDescription(`你抢到了 **${formatMoney(cents / 100)} ${currency}**！`).addFields({ name: '领取后余额', value: `${formatMoney(result.after)} ${currency}`, inline: true }, { name: '剩余名额', value: `${packet.maxClaims - packet.claims.length}`, inline: true }).setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
  if (packet.claims.length >= packet.maxClaims || packet.remainingCents <= 0) await finishPacket(interaction.client, id, 'claimed');
  else {
    const message = await interaction.channel.messages.fetch(packet.messageId).catch(() => null);
    if (message) await message.edit({ embeds: [packetEmbed(packet, currency)], components: packetComponents(packet) }).catch(() => null);
  }
}

async function handleAutoClaimCommand(interaction, subcommand) {
  if (!canManageAutoClaim(interaction)) return interaction.reply({ content: '只有服务器拥有者或配置的机器人管理者可以设置、查看或取消自动抢福袋。', ephemeral: true });
  const guildId = interaction.guildId;
  const rules = activeAutoClaimRules(guildId);
  if (subcommand === 'auto-add') {
    const user = interaction.options.getUser('user', true);
    const expiresAt = parseAutoClaimDuration(interaction.options.getString('duration', true));
    if (expiresAt === undefined) return interaction.reply({ content: '持续时间格式无效，请使用 `10s`、`30m`、`2h`、`1d`，或使用 `-1` 表示永久。', ephemeral: true });
    if (rules.some((rule) => rule.userId === user.id)) return interaction.reply({ content: `<@${user.id}> 已经在自动抢福袋优先级中，请先取消后再重新添加。`, ephemeral: true });
    rules.push({ userId: user.id, expiresAt, createdAt: Date.now() });
    autoClaimRules.set(guildId, rules);
    saveAutoClaimData();
    return interaction.reply({ content: `已将 <@${user.id}> 加入自动抢福袋优先级第 ${rules.length} 位。持续时间：${expiresAt === null ? '永久' : `<t:${Math.floor(expiresAt / 1000)}:R>`}。`, ephemeral: true });
  }
  if (subcommand === 'auto-remove') {
    const user = interaction.options.getUser('user', true);
    const remaining = rules.filter((rule) => rule.userId !== user.id);
    if (remaining.length === rules.length) return interaction.reply({ content: `<@${user.id}> 不在本服务器的自动抢福袋优先级中。`, ephemeral: true });
    if (remaining.length) autoClaimRules.set(guildId, remaining);
    else autoClaimRules.delete(guildId);
    saveAutoClaimData();
    return interaction.reply({ content: `已取消 <@${user.id}> 的自动抢福袋设置。`, ephemeral: true });
  }
  const lines = rules.map((rule, index) => `${index + 1}. <@${rule.userId}>｜${rule.expiresAt === null ? '永久' : `到期 <t:${Math.floor(rule.expiresAt / 1000)}:R>`}`);
  return interaction.reply({ content: lines.length ? `🧧 自动抢福袋优先级\n${lines.join('\n')}` : '目前没有设置自动抢福袋成员。', ephemeral: true });
}

async function handleRedPacket(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'redpacket') {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'create') return createPacket(interaction);
    if (['auto-add', 'auto-list', 'auto-remove'].includes(subcommand)) return handleAutoClaimCommand(interaction, subcommand);
  }
  if (interaction.isButton() && interaction.customId.startsWith('redpacket:claim:')) return claimPacket(interaction, interaction.customId.split(':')[2]);
  return false;
}

function setupRedPackets(client) {
  loadData();
  loadAutoClaimData();
  client.on('ready', () => { for (const packet of packets.values()) schedulePacket(client, packet); });
  client.on('interactionCreate', (interaction) => handleRedPacket(interaction).catch((error) => {
    console.error('Red packet interaction failed:', error);
    const response = { content: '福袋操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null); else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { redPacketCommand, setupRedPackets, setRedPacketAuditSender };
