const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { changeBalance, getBalance, getGuildData, roundMoney, formatMoney, parseMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'checkins.json');
const checkins = new Map();
const panelSessions = new Map();
const DAY_MS = 86_400_000;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

const checkinCommand = new SlashCommandBuilder()
  .setName('checkin')
  .setDescription('打开签到设置面板并发布签到面板');

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [guildId, value] of Object.entries(raw)) {
      checkins.set(guildId, {
        minimum: Number(value.minimum ?? 10),
        maximum: Number(value.maximum ?? value.minimum ?? 10),
        streakBonus: Number(value.streakBonus ?? 0),
        weeklyDays: Number(value.weeklyDays ?? 7),
        weeklyBonus: Number(value.weeklyBonus ?? 0),
        users: value.users || {},
      });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load check-in data:', error.message);
  }
}

function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(checkins.entries()), null, 2));
  fs.renameSync(temporary, dataFile);
}

function getConfig(guildId) {
  if (!checkins.has(guildId)) checkins.set(guildId, { minimum: 10, maximum: 10, streakBonus: 0, weeklyDays: 7, weeklyBonus: 0, users: {} });
  return checkins.get(guildId);
}

function localDayKey(date = new Date()) {
  return new Date(date.getTime() + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}

function dayNumber(dayKey) {
  return Math.floor(Date.parse(`${dayKey}T00:00:00.000Z`) / DAY_MS);
}

function weekKey(dayKey) {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return date.toISOString().slice(0, 10);
}

function randomReward(minimum, maximum) {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  return low === high ? roundMoney(low) : roundMoney(low + Math.random() * (high - low));
}

function formatRules(config) {
  const base = config.minimum === config.maximum ? formatMoney(config.minimum) : `${formatMoney(config.minimum)} ~ ${formatMoney(config.maximum)}`;
  return `每日基础奖励：${base}\n连续签到额外奖励：每天 +${formatMoney(config.streakBonus)}\n每周奖励：签到 ${config.weeklyDays} 天 +${formatMoney(config.weeklyBonus)}`;
}

function isManager(interaction) {
  return require('./permissions').canManageGuild(interaction);
}

function sessionKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function settingsEmbed(guild, session) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('签到设置面板')
    .setDescription('这是私密设置面板。点击下方按钮调整规则，最后点击“确认”后，会在当前频道发布公开签到面板。')
    .addFields({ name: '当前规则', value: formatRules(session) }, { name: '时区', value: 'UTC+8（每天 00:00 后可再次签到）' })
    .setFooter({ text: `发布频道：#${guild.channels.cache.get(session.channelId)?.name || '当前频道'}` });
}

function settingsComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('checkin:base').setLabel('设置每日基础奖励').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('checkin:streak').setLabel('设置连续奖励').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('checkin:weekly').setLabel('设置每周奖励').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('checkin:confirm').setLabel('确认').setEmoji('✅').setStyle(ButtonStyle.Success),
    ),
  ];
}

function settingsModal(type) {
  const modal = new ModalBuilder().setCustomId(`checkin:modal:${type}`).setTitle(type === 'base' ? '设置每日基础奖励' : type === 'streak' ? '设置连续签到奖励' : '设置每周签到奖励');
  if (type === 'base') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('minimum').setLabel('最低奖励').setPlaceholder('例如 10 或 10.25').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('maximum').setLabel('最高奖励').setPlaceholder('与最低相同即为固定奖励').setStyle(TextInputStyle.Short).setRequired(true)),
    );
  } else if (type === 'streak') {
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('每天连续签到额外奖励').setPlaceholder('例如 2.5').setStyle(TextInputStyle.Short).setRequired(true)));
  } else {
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('days').setLabel('本周需要签到几天（1-7）').setPlaceholder('例如 5').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('达到天数后的额外奖励').setPlaceholder('例如 50').setStyle(TextInputStyle.Short).setRequired(true)),
    );
  }
  return modal;
}

function publicPanelEmbed(guild) {
  const config = getConfig(guild.id);
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('📅 每日签到')
    .setDescription('每天按照 UTC+8 过了 00:00 后，点击下方按钮领取每日迷你币奖励。')
    .addFields({ name: '签到规则', value: formatRules(config) })
    .setFooter({ text: '每位成员每天只能签到一次' });
}

function publicPanelComponents() {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('checkin:claim').setLabel('签到').setEmoji('📅').setStyle(ButtonStyle.Primary))];
}

function currentCheckinEmbed(guildId, userId, record, today, config) {
  const currentWeek = weekKey(today);
  const weekDays = record.week === currentWeek ? [...new Set(record.weekDays || [])] : [];
  const currency = getGuildData(guildId).name;
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('📅 今日已经签到')
    .setDescription(`<@${userId}> 今天已经领取过奖励，这次不会重复发放。`)
    .addFields(
      { name: '连续签到', value: `${record.streak || 0} 天`, inline: true },
      { name: '本周签到天数', value: `${weekDays.length}/${config.weeklyDays}`, inline: true },
      { name: '当前余额', value: `${formatMoney(getBalance(guildId, userId))} ${currency}`, inline: true },
      { name: '今日签到日期', value: today, inline: true },
      { name: '本周签到日期', value: weekDays.length ? weekDays.join('、') : '暂无', inline: false },
      { name: '每周奖励状态', value: record.weekRewardClaimed ? '本周奖励已领取' : `签到满 ${config.weeklyDays} 天可获得 +${formatMoney(config.weeklyBonus)} ${currency}`, inline: false },
    )
    .setFooter({ text: '每周从星期一 00:00 开始，星期日 23:59 结束（UTC+8）' })
    .setTimestamp();
}

async function claimCheckin(interaction) {
  const config = getConfig(interaction.guildId);
  const userId = interaction.user.id;
  const today = localDayKey();
  const record = config.users[userId] || { lastDay: null, streak: 0, week: null, weekDays: [] };
  if (record.lastDay === today) return interaction.reply({ embeds: [currentCheckinEmbed(interaction.guildId, userId, record, today, config)], ephemeral: true });
  const previousDay = localDayKey(new Date(Date.now() - DAY_MS));
  const streak = record.lastDay === previousDay ? Number(record.streak || 0) + 1 : 1;
  const currentWeek = weekKey(today);
  const weekDays = record.week === currentWeek ? [...new Set(record.weekDays || [])] : [];
  weekDays.push(today);
  const baseReward = randomReward(config.minimum, config.maximum);
  const streakReward = roundMoney(Math.max(0, streak - 1) * config.streakBonus);
  const weeklyReward = weekDays.length >= config.weeklyDays && !(record.week === currentWeek && record.weekRewardClaimed) ? config.weeklyBonus : 0;
  const total = roundMoney(baseReward + streakReward + weeklyReward);
  const balanceResult = changeBalance(interaction.guildId, userId, total, {
    reason: `每日签到奖励（连续签到 ${streak} 天）`,
    actorLabel: '系统（每日签到）',
  });
  config.users[userId] = { lastDay: today, streak, week: currentWeek, weekDays, weekRewardClaimed: weeklyReward > 0 || (record.week === currentWeek && record.weekRewardClaimed) };
  saveData();
  const currency = getGuildData(interaction.guildId).name;
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ 签到成功')
    .setDescription(`<@${userId}> 获得了 **${formatMoney(total)} ${currency}**`)
    .addFields(
      { name: '基础奖励', value: formatMoney(baseReward), inline: true },
      { name: '连续签到奖励', value: `+${formatMoney(streakReward)}`, inline: true },
      { name: '本周签到奖励', value: `+${formatMoney(weeklyReward)}`, inline: true },
      { name: '连续签到', value: `${streak} 天`, inline: true },
      { name: '本周签到天数', value: `${weekDays.length}/${config.weeklyDays}`, inline: true },
      { name: '当前余额', value: `${formatMoney(balanceResult.after)} ${currency}`, inline: true },
    )
    .setFooter({ text: '签到时间按照 UTC+8；每周从星期一 00:00 开始，星期日 23:59 结束' })
    .setTimestamp();
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCheckinInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'checkin') {
    if (!isManager(interaction)) return interaction.reply({ content: '只有拥有“管理服务器”权限的成员可以发布签到面板。请点击频道里的签到按钮领取奖励。', ephemeral: true });
    const session = { ...getConfig(interaction.guildId), channelId: interaction.channelId, users: getConfig(interaction.guildId).users };
    panelSessions.set(sessionKey(interaction), session);
    return interaction.reply({ embeds: [settingsEmbed(interaction.guild, session)], components: settingsComponents(), ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId === 'checkin:claim') {
    if (!interaction.inGuild()) return interaction.reply({ content: '此按钮只能在服务器内使用。', ephemeral: true });
    return claimCheckin(interaction);
  }

  if (interaction.isButton() && ['base', 'streak', 'weekly'].some((type) => interaction.customId === `checkin:${type}`)) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const session = panelSessions.get(sessionKey(interaction));
    if (!session) return interaction.reply({ content: '设置面板已过期，请重新使用 `/checkin`。', ephemeral: true });
    return interaction.showModal(settingsModal(interaction.customId.split(':')[1]));
  }

  if (interaction.isButton() && interaction.customId === 'checkin:confirm') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const session = panelSessions.get(sessionKey(interaction));
    if (!session) return interaction.reply({ content: '设置面板已过期，请重新使用 `/checkin`。', ephemeral: true });
    const config = getConfig(interaction.guildId);
    Object.assign(config, { minimum: session.minimum, maximum: session.maximum, streakBonus: session.streakBonus, weeklyDays: session.weeklyDays, weeklyBonus: session.weeklyBonus });
    saveData();
    panelSessions.delete(sessionKey(interaction));
    await interaction.update({ content: '签到规则已保存，公开签到面板已发布到当前频道。', embeds: [], components: [] });
    return interaction.channel.send({ embeds: [publicPanelEmbed(interaction.guild)], components: publicPanelComponents() });
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('checkin:modal:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const session = panelSessions.get(sessionKey(interaction));
    if (!session) return interaction.reply({ content: '设置面板已过期，请重新使用 `/checkin`。', ephemeral: true });
    const type = interaction.customId.split(':')[2];
    if (type === 'base') {
      const minimum = parseMoney(interaction.fields.getTextInputValue('minimum'));
      const maximum = parseMoney(interaction.fields.getTextInputValue('maximum'));
      if (minimum === null || maximum === null || minimum < 0 || maximum < 0) return interaction.reply({ content: '请输入非负金额，最多支持两位小数。', ephemeral: true });
      session.minimum = minimum;
      session.maximum = maximum;
    } else if (type === 'streak') {
      const amount = parseMoney(interaction.fields.getTextInputValue('amount'));
      if (amount === null || amount < 0) return interaction.reply({ content: '请输入非负金额，最多支持两位小数。', ephemeral: true });
      session.streakBonus = amount;
    } else {
      const days = Number(interaction.fields.getTextInputValue('days'));
      const amount = parseMoney(interaction.fields.getTextInputValue('amount'));
      if (!Number.isInteger(days) || days < 1 || days > 7 || amount === null || amount < 0) return interaction.reply({ content: '签到天数必须是 1 到 7 的整数，奖励请输入非负金额，最多支持两位小数。', ephemeral: true });
      session.weeklyDays = days;
      session.weeklyBonus = amount;
    }
    return interaction.update({ embeds: [settingsEmbed(interaction.guild, session)], components: settingsComponents() });
  }
  return false;
}

function setupCheckins(client) {
  loadData();
  client.on('interactionCreate', (interaction) => handleCheckinInteraction(interaction).catch((error) => {
    console.error('Check-in interaction failed:', error);
    const response = { content: '签到操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { checkinCommand, setupCheckins, localDayKey };
