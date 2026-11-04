const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'global-blacklist.json');
const ownerId = String(process.env.BOT_OWNER_ID || process.env.DISCORD_OWNER_ID || '').trim();
const entries = new Map();
let auditSender = null;

const blacklistCommand = new SlashCommandBuilder()
  .setName('blacklist')
  .setDescription('机器人拥有者管理全局黑名单')
  // Discord API values: UserInstall = 1; BotDM = 1; PrivateChannel = 2.
  .setIntegrationTypes(1)
  .setContexts(1, 2)
  .addStringOption((option) => option.setName('action').setDescription('操作').setRequired(true).addChoices(
    { name: '加入黑名单并处理现有服务器', value: 'add' },
    { name: 'ban：加入黑名单并预设自动封禁', value: 'ban' },
    { name: '移除黑名单', value: 'remove' },
    { name: '查看黑名单', value: 'list' },
  ))
  .addStringOption((option) => option.setName('user_id').setDescription('目标 Discord 用户 ID；加入或移除时必填').setRequired(false))
  .addStringOption((option) => option.setName('reason').setDescription('加入黑名单原因；加入时必填').setRequired(false).setMaxLength(500));

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [userId, entry] of Object.entries(raw)) {
      if (/^\d{15,25}$/.test(userId) && entry?.reason) entries.set(userId, {
        reason: String(entry.reason).slice(0, 500),
        createdAt: Number(entry.createdAt) || Date.now(),
        createdBy: String(entry.createdBy || ownerId),
      });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load global blacklist:', error.message);
  }
}

function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries.entries()), null, 2));
  fs.renameSync(temporary, dataFile);
}

function setBlacklistAuditSender(sender) {
  auditSender = sender;
}

function isBlacklisted(userId) {
  return entries.has(String(userId));
}

function getBlacklistEntry(userId) {
  return entries.get(String(userId)) || null;
}

function ownerOnly(interaction) {
  return Boolean(ownerId && interaction.user?.id === ownerId);
}

function validUserId(value) {
  return /^\d{15,25}$/.test(String(value || '').trim());
}

function blacklistEmbed(userId, entry, title = '全局黑名单') {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`🚫 ${title}`)
    .addFields(
      { name: '成员 ID', value: String(userId), inline: false },
      { name: '原因', value: String(entry.reason || '未提供原因'), inline: false },
      { name: '加入时间', value: `<t:${Math.floor((entry.createdAt || Date.now()) / 1000)}:F>`, inline: true },
    )
    .setTimestamp();
}

async function sendOwnerNotice(guild, userId, reason, action, canBan, errorText = '') {
  const owner = await guild.fetchOwner().catch(() => null);
  if (!owner) return;
  await owner.send({
    embeds: [new EmbedBuilder()
      .setColor(canBan ? 0xed4245 : 0xf1c40f)
      .setTitle(canBan ? '🚫 黑名单成员已被封禁' : '⚠️ 黑名单成员无法被封禁')
      .setDescription(canBan
        ? '机器人已按照全局黑名单处理该成员。'
        : '机器人没有封禁权限，因此该成员已被限制使用机器人；请服务器管理员手动处理。')
      .addFields(
        { name: '成员 ID', value: String(userId), inline: true },
        { name: '服务器', value: guild.name, inline: true },
        { name: '原因', value: String(reason || '未提供原因'), inline: false },
        ...(errorText ? [{ name: '处理结果', value: errorText, inline: false }] : []),
      )
      .setTimestamp()],
  }).catch(() => null);
}

async function auditBlacklist(guild, userId, reason, action, result) {
  if (!auditSender) return;
  const embed = new EmbedBuilder()
    .setColor(action === '封禁' ? 0xed4245 : 0xf1c40f)
    .setTitle(`全局黑名单：${action}`)
    .addFields(
      { name: '成员 ID', value: String(userId), inline: true },
      { name: '处理结果', value: result, inline: true },
      { name: '原因', value: String(reason || '未提供原因'), inline: false },
    )
    .setTimestamp();
  await auditSender(guild, embed, 'blacklist', `global-blacklist:${action}:${userId}:${guild.id}:${result}`).catch((error) => console.error('Blacklist audit failed:', error.message));
}

async function enforceForGuild(guild, userId, reason) {
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const canBan = Boolean(me?.permissions?.has(PermissionFlagsBits.BanMembers));
  if (!canBan) {
    const result = '机器人没有 Ban Members 权限，已限制机器人功能';
    await auditBlacklist(guild, userId, reason, '限制使用', result);
    await sendOwnerNotice(guild, userId, reason, '限制使用', false, result);
    return { guildId: guild.id, banned: false, blocked: true, result };
  }
  const user = await guild.client.users.fetch(userId).catch(() => null);
  const member = await guild.members.fetch(userId).catch(() => null);
  const banReason = `全局黑名单：${reason}`.slice(0, 512);
  const banned = await guild.members.ban(user || userId, { reason: banReason, deleteMessageSeconds: 0 }).then(() => true).catch((error) => {
    console.warn(`Could not ban blacklisted user ${userId} in guild ${guild.id}:`, error.message);
    return false;
  });
  if (banned) {
    const result = member ? '已封禁当前成员' : '成员不在服务器，已设置进入后自动封禁';
    await auditBlacklist(guild, userId, reason, '封禁', result);
    await sendOwnerNotice(guild, userId, reason, '封禁', true);
    return { guildId: guild.id, banned: true, blocked: false, result };
  }
  const result = '封禁失败，已限制机器人功能';
  await auditBlacklist(guild, userId, reason, '限制使用', result);
  await sendOwnerNotice(guild, userId, reason, '限制使用', false, result);
  return { guildId: guild.id, banned: false, blocked: true, result };
}

async function handleBlacklistInteraction(interaction, client) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'blacklist') return false;
  if (!ownerOnly(interaction)) return interaction.reply({ content: '只有机器人拥有者可以使用此指令。', ephemeral: true });
  const action = interaction.options.getString('action', true);
  if (action === 'list') {
    const description = entries.size
      ? [...entries.entries()].map(([userId, entry]) => `<@${userId}>（\`${userId}\`）\n原因：${entry.reason}`).join('\n\n')
      : '目前没有全局黑名单成员。';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🌐 全局黑名单').setDescription(description.slice(0, 4096)).setFooter({ text: `共 ${entries.size} 名成员` })], ephemeral: true });
  }
  const userId = interaction.options.getString('user_id')?.trim();
  if (!validUserId(userId)) return interaction.reply({ content: '请填写有效的 Discord 用户 ID。', ephemeral: true });
  if (action === 'remove') {
    if (!entries.delete(userId)) return interaction.reply({ content: '该成员不在全局黑名单中。', ephemeral: true });
    saveData();
    return interaction.reply({ content: `已将成员 ID \`${userId}\` 移出全局黑名单。已封禁的服务器不会自动解封。`, ephemeral: true });
  }
  const reason = interaction.options.getString('reason')?.trim();
  if (!reason) return interaction.reply({ content: '加入黑名单时必须填写原因。', ephemeral: true });
  if (userId === ownerId) return interaction.reply({ content: '不能将机器人拥有者加入全局黑名单。', ephemeral: true });
  entries.set(userId, { reason, createdAt: Date.now(), createdBy: interaction.user.id });
  saveData();
  const results = [];
  for (const guild of client.guilds.cache.values()) results.push(await enforceForGuild(guild, userId, reason));
  const banned = results.filter((item) => item.banned).length;
  const blocked = results.filter((item) => item.blocked).length;
  return interaction.reply({ embeds: [blacklistEmbed(userId, entries.get(userId), '已加入全局黑名单').addFields(
    { name: '现有服务器处理', value: `已封禁/设置自动封禁：${banned} 个\n无法封禁并限制使用：${blocked} 个`, inline: false },
  )], ephemeral: true });
}

function setupBlacklist(client) {
  loadData();
  client.on('interactionCreate', (interaction) => {
    if (isBlacklisted(interaction.user?.id) && interaction.commandName !== 'blacklist') {
      if (!interaction.replied && !interaction.deferred) interaction.reply({ content: `你已被限制使用本机器人。原因：${getBlacklistEntry(interaction.user.id).reason}`, ephemeral: true }).catch(() => null);
      return;
    }
    handleBlacklistInteraction(interaction, client).catch((error) => {
      console.error('Blacklist interaction failed:', error);
      const response = { content: '全局黑名单操作失败，请稍后再试。', ephemeral: true };
      if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null); else interaction.reply(response).catch(() => null);
    });
  });
  client.on('guildMemberAdd', async (member) => {
    const entry = getBlacklistEntry(member.id);
    if (!entry) return;
    await enforceForGuild(member.guild, member.id, entry.reason);
  });
}

module.exports = { blacklistCommand, setupBlacklist, setBlacklistAuditSender, isBlacklisted, getBlacklistEntry };
