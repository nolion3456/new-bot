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
const { canManageGuild } = require('./permissions');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'redpackets.json');
const packets = new Map();
const timers = new Map();
let auditSender = null;

const redPacketCommand = new SlashCommandBuilder()
  .setName('redpacket')
  .setDescription('管理员发送福袋活动')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
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
  if (!active && packet.highestUserId && packet.mode === 'lucky') embed.addFields({ name: '手气最佳', value: `<@${packet.highestUserId}>（${formatMoney(packet.highestCents / 100)} ${currency}）`, inline: false });
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
  const cents = allocate(packet);
  packet.claims.push(interaction.user.id);
  packet.allocations[interaction.user.id] = cents;
  packet.remainingCents -= cents;
  const result = changeBalance(interaction.guildId, interaction.user.id, cents / 100, { reason: `抢到福袋（${packet.mode === 'lucky' ? '拼手气' : '平均分配'}）`, actorLabel: '系统（福袋）' });
  if (cents > packet.highestCents) { packet.highestCents = cents; packet.highestUserId = interaction.user.id; }
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

async function handleRedPacket(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'redpacket') {
    if (!canManageGuild(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    if (interaction.options.getSubcommand() === 'create') return createPacket(interaction);
  }
  if (interaction.isButton() && interaction.customId.startsWith('redpacket:claim:')) return claimPacket(interaction, interaction.customId.split(':')[2]);
  return false;
}

function setupRedPackets(client) {
  loadData();
  client.on('ready', () => { for (const packet of packets.values()) schedulePacket(client, packet); });
  client.on('interactionCreate', (interaction) => handleRedPacket(interaction).catch((error) => {
    console.error('Red packet interaction failed:', error);
    const response = { content: '福袋操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null); else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { redPacketCommand, setupRedPackets, setRedPacketAuditSender };
