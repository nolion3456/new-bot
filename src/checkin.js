const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { changeBalance, getGuildData, roundMoney, formatMoney, parseMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'checkins.json');
const checkins = new Map();
const DAY_MS = 86_400_000;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

const checkinCommand = new SlashCommandBuilder()
  .setName('checkin')
  .setDescription('领取今日签到奖励');

const checkinSettingsCommand = new SlashCommandBuilder()
  .setName('checkin-settings')
  .setDescription('设置签到与每日奖励规则（管理员）')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
  .addSubcommand((subcommand) => subcommand
    .setName('base')
    .setDescription('设置每日基础奖励')
    .addStringOption((option) => option.setName('minimum').setDescription('最低奖励，例如 10.25').setRequired(true))
    .addStringOption((option) => option.setName('maximum').setDescription('最高奖励；与最低相同则固定').setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName('streak')
    .setDescription('设置连续签到额外奖励')
    .addStringOption((option) => option.setName('amount').setDescription('每天连续签到增加的迷你币').setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName('weekly')
    .setDescription('设置每周签到天数奖励')
    .addIntegerOption((option) => option.setName('days').setDescription('本周签到达到几天').setMinValue(1).setMaxValue(7).setRequired(true))
    .addStringOption((option) => option.setName('amount').setDescription('额外奖励数量').setRequired(true)))
  .addSubcommand((subcommand) => subcommand.setName('show').setDescription('查看当前签到规则'));

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
  if (!checkins.has(guildId)) {
    checkins.set(guildId, { minimum: 10, maximum: 10, streakBonus: 0, weeklyDays: 7, weeklyBonus: 0, users: {} });
  }
  return checkins.get(guildId);
}

function localDayKey(date = new Date()) {
  return new Date(date.getTime() + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}

function dayNumber(dayKey) {
  return Math.floor(Date.parse(`${dayKey}T00:00:00.000Z`) / DAY_MS);
}

function weekKey(dayKey) {
  const day = dayNumber(dayKey);
  return String(Math.floor(day / 7));
}

function randomReward(minimum, maximum) {
  const low = roundMoney(Math.min(minimum, maximum));
  const high = roundMoney(Math.max(minimum, maximum));
  if (low === high) return low;
  return roundMoney(low + Math.random() * (high - low));
}

function formatRules(config) {
  const base = config.minimum === config.maximum ? formatMoney(config.minimum) : `${formatMoney(config.minimum)} ~ ${formatMoney(config.maximum)}`;
  return `每日基础奖励：${base}\n连续签到额外奖励：每天 +${formatMoney(config.streakBonus)}\n每周奖励：签到 ${config.weeklyDays} 天 +${formatMoney(config.weeklyBonus)}`;
}

function isManager(interaction) {
  return interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function handleCheckinInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'checkin') {
    if (!interaction.guild) return interaction.reply({ content: '此指令只能在服务器内使用。', ephemeral: true });
    const config = getConfig(interaction.guildId);
    const userId = interaction.user.id;
    const today = localDayKey();
    const record = config.users[userId] || { lastDay: null, streak: 0, week: null, weekDays: [] };
    if (record.lastDay === today) return interaction.reply({ content: `你今天已经签到过了。当前连续签到：${record.streak} 天。`, ephemeral: true });
    const previousDay = localDayKey(new Date(Date.now() - DAY_MS));
    const streak = record.lastDay === previousDay ? Number(record.streak || 0) + 1 : 1;
    const currentWeek = weekKey(today);
    const weekDays = record.week === currentWeek ? [...new Set(record.weekDays || [])] : [];
    weekDays.push(today);
    const baseReward = randomReward(config.minimum, config.maximum);
    const streakReward = roundMoney(Math.max(0, streak - 1) * config.streakBonus);
    const weeklyReward = weekDays.length >= config.weeklyDays && !(record.week === currentWeek && record.weekRewardClaimed) ? config.weeklyBonus : 0;
    const total = roundMoney(baseReward + streakReward + weeklyReward);
    changeBalance(interaction.guildId, userId, total);
    config.users[userId] = { lastDay: today, streak, week: currentWeek, weekDays, weekRewardClaimed: weeklyReward > 0 || (record.week === currentWeek && record.weekRewardClaimed) };
    saveData();
    const balance = getGuildData(interaction.guildId).balances[userId] || 0;
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('✅ 签到成功')
      .setDescription(`<@${userId}> 获得了 **${formatMoney(total)} ${getGuildData(interaction.guildId).name}**`)
      .addFields(
        { name: '基础奖励', value: formatMoney(baseReward), inline: true },
        { name: '连续签到奖励', value: `+${formatMoney(streakReward)}`, inline: true },
        { name: '本周签到奖励', value: `+${formatMoney(weeklyReward)}`, inline: true },
        { name: '连续签到', value: `${streak} 天`, inline: true },
        { name: '本周签到天数', value: `${weekDays.length}/${config.weeklyDays}`, inline: true },
        { name: '当前余额', value: `${formatMoney(balance)} ${getGuildData(interaction.guildId).name}`, inline: true },
      )
      .setFooter({ text: '签到时间按照 UTC+8，每天 00:00 后可再次签到' })
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'checkin-settings') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const config = getConfig(interaction.guildId);
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'show') return interaction.reply({ content: `当前签到规则：\n${formatRules(config)}`, ephemeral: true });
    if (subcommand === 'base') {
      const minimum = parseMoney(interaction.options.getString('minimum'));
      const maximum = parseMoney(interaction.options.getString('maximum'));
      if (minimum === null || maximum === null || minimum < 0 || maximum < 0) return interaction.reply({ content: '请输入非负金额，最多支持两位小数。', ephemeral: true });
      config.minimum = minimum;
      config.maximum = maximum;
    } else if (subcommand === 'streak') {
      const amount = parseMoney(interaction.options.getString('amount'));
      if (amount === null || amount < 0) return interaction.reply({ content: '请输入非负金额，最多支持两位小数。', ephemeral: true });
      config.streakBonus = amount;
    } else if (subcommand === 'weekly') {
      config.weeklyDays = interaction.options.getInteger('days');
      const amount = parseMoney(interaction.options.getString('amount'));
      if (amount === null || amount < 0) return interaction.reply({ content: '请输入非负金额，最多支持两位小数。', ephemeral: true });
      config.weeklyBonus = amount;
    }
    saveData();
    return interaction.reply({ content: `签到规则已更新：\n${formatRules(config)}`, ephemeral: true });
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

module.exports = { checkinCommand, checkinSettingsCommand, setupCheckins, localDayKey };
