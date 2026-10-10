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
const { canManageGuild } = require('./permissions');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'balances.json');
const guildBalances = new Map();
let balanceAuditSender = null;

function roundMoney(value) {
  const rounded = Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatMoney(value) {
  return roundMoney(value).toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function parseMoney(value) {
  const text = String(value).trim();
  if (!/^-?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && Math.abs(amount) <= 9_000_000_000_000 ? roundMoney(amount) : null;
}

const balanceCommand = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('查看迷你币余额并打开操作面板')
  .addUserOption((option) => option.setName('user').setDescription('要查看的玩家（可选）'));

const balanceNameCommand = new SlashCommandBuilder()
  .setName('balance-name')
  .setDescription('修改本服务器的余额名称（管理员）')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
  .addStringOption((option) => option.setName('name').setDescription('新的币名称').setMinLength(1).setMaxLength(30).setRequired(true));

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [guildId, value] of Object.entries(raw)) {
      guildBalances.set(guildId, {
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : '迷你币',
        balances: Object.fromEntries(Object.entries(value.balances || {}).map(([userId, amount]) => [userId, roundMoney(Number(amount) || 0)])),
        majorBalances: Object.fromEntries(Object.entries(value.majorBalances || {}).map(([userId, amount]) => [userId, roundMoney(Number(amount) || 0)])),
      });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load balances:', error.message);
  }
}

function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const raw = Object.fromEntries(guildBalances.entries());
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(raw, null, 2));
  fs.renameSync(temporary, dataFile);
}

function getGuildData(guildId) {
  if (!guildBalances.has(guildId)) guildBalances.set(guildId, { name: '迷你币', balances: {}, majorBalances: {} });
  return guildBalances.get(guildId);
}

function getBalance(guildId, userId) {
  return getGuildData(guildId).balances[userId] || 0;
}

function getMajorBalance(guildId, userId) {
  return getGuildData(guildId).majorBalances[userId] || 0;
}

function changeMajorBalance(guildId, userId, amount, metadata = {}) {
  const data = getGuildData(guildId);
  const before = getMajorBalance(guildId, userId);
  const after = roundMoney(before + Number(amount));
  data.majorBalances[userId] = after;
  saveData();
  const result = { before, after, data };
  if (balanceAuditSender) Promise.resolve(balanceAuditSender({ guildId, userId, amount: Number(amount), before, after, currency: '余额', reason: metadata.reason || '余额调整', actorId: metadata.actorId || null, actorLabel: metadata.actorLabel || '系统' })).catch((error) => console.error('Balance audit failed:', error.message));
  return result;
}

function changeBalance(guildId, userId, amount, metadata = {}) {
  const data = getGuildData(guildId);
  const before = getBalance(guildId, userId);
  const after = roundMoney(before + Number(amount));
  data.balances[userId] = after;
  saveData();
  const result = { before, after, data };
  if (balanceAuditSender) Promise.resolve(balanceAuditSender({ guildId, userId, amount: Number(amount), before, after, currency: data.name, reason: metadata.reason || '余额调整', actorId: metadata.actorId || null, actorLabel: metadata.actorLabel || '系统' })).catch((error) => console.error('Balance audit failed:', error.message));
  return result;
}

function setBalanceAuditSender(sender) {
  balanceAuditSender = sender;
}

function panelEmbed(guild, user) {
  const data = getGuildData(guild.id);
  const balance = getBalance(guild.id, user.id);
  const majorBalance = getMajorBalance(guild.id, user.id);
  return new EmbedBuilder()
    .setColor(balance >= 0 ? 0x57f287 : 0xed4245)
    .setTitle(`💰 ${data.name}资产面板`)
    .setDescription(`### <@${user.id}>\n查看并管理本服务器的 ${data.name} 余额。`)
    .addFields(
      { name: '当前余额', value: `${formatMoney(balance)} ${data.name}`, inline: false },
      { name: '大面额余额', value: `${formatMoney(majorBalance)} 余额`, inline: false },
      { name: '账户状态', value: balance >= 0 ? '余额正常' : '当前为负数', inline: true },
      { name: '查询对象', value: `${user.tag}`, inline: true },
    )
    .setFooter({ text: '管理服务器权限可使用下方按钮调整余额｜金额支持最多两位小数与负数' })
    .setTimestamp();
}

function panelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('balance:add').setLabel('加币').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('balance:remove').setLabel('减币').setEmoji('➖').setStyle(ButtonStyle.Danger),
  )];
}

function currencyChoiceComponents(action, targetId, messageId = '') {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`balance:choose:${action}:mini:${targetId}:${messageId}`).setLabel('迷你币').setEmoji('🪙').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`balance:choose:${action}:major:${targetId}:${messageId}`).setLabel('余额').setEmoji('💰').setStyle(ButtonStyle.Success),
  )];
}

function amountModal(action, currency, targetId, messageId = '') {
  const data = new TextInputBuilder()
    .setCustomId('balance:amount')
    .setLabel('数量')
    .setPlaceholder('请输入金额，例如 100、10.25 或 -5.5')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12);
  return new ModalBuilder()
    .setCustomId(`balance:modal:${action}:${currency}:${targetId}:${messageId}`)
    .setTitle(`${action === 'add' ? '加' : '减'}${currency === 'major' ? '余额' : '迷你币'}`)
    .addComponents(
      new ActionRowBuilder().addComponents(data),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('原因（可选）').setPlaceholder('例如：活动奖励、违规扣除').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)),
    );
}

function isManager(interaction) {
  return canManageGuild(interaction);
}

async function handleBalanceInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'balance') {
    if (!interaction.guild) return interaction.reply({ content: '此指令只能在服务器内使用。', ephemeral: true });
    const target = interaction.options.getUser('user') || interaction.user;
    return interaction.reply({ embeds: [panelEmbed(interaction.guild, target)], components: panelComponents() });
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'balance-name') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const name = interaction.options.getString('name').trim();
    const data = getGuildData(interaction.guildId);
    data.name = name;
    saveData();
    return interaction.reply({ content: `已将本服务器的余额名称改为 **${name}**。`, ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId.startsWith('balance:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '只有拥有“管理服务器”权限的成员可以加币或减币。', ephemeral: true });
    const parts = interaction.customId.split(':');
    const action = parts[1];
    if (action === 'add' || action === 'remove') {
      const targetId = interaction.message?.embeds?.[0]?.description?.match(/<@!?([0-9]+)>/)?.[1] || interaction.user.id;
      return interaction.reply({ content: `请选择要${action === 'add' ? '增加' : '减少'}的币种：`, components: currencyChoiceComponents(action, targetId, interaction.message?.id), ephemeral: true });
    }
    if (action !== 'choose' || !['add', 'remove'].includes(parts[2]) || !['mini', 'major'].includes(parts[3])) return interaction.reply({ content: '余额操作类型无效，请重新打开余额面板。', ephemeral: true });
    return interaction.showModal(amountModal(parts[2], parts[3], parts[4], parts[5] || ''));
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('balance:modal:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '只有拥有“管理服务器”权限的成员可以操作余额。', ephemeral: true });
    const [, , action, currency, targetIdFromModal, messageIdFromModal] = interaction.customId.split(':');
    const amount = parseMoney(interaction.fields.getTextInputValue('balance:amount'));
    const reason = interaction.fields.getTextInputValue('reason')?.trim() || '';
    if (amount === null || amount === 0) return interaction.reply({ content: '请输入非 0 金额，最多支持两位小数，例如 `100`、`10.25` 或 `-5.5`。', ephemeral: true });
    const targetId = targetIdFromModal || interaction.user.id;
    const data = getGuildData(interaction.guildId);
    const signedAmount = action === 'add' ? Math.abs(amount) : -Math.abs(amount);
    const actionLabel = action === 'add' ? '增加' : '减少';
    const currencyName = currency === 'major' ? '余额' : data.name;
    const change = currency === 'major' ? changeMajorBalance : changeBalance;
    const { before, after } = change(interaction.guildId, targetId, signedAmount, {
      reason: `管理员手动${actionLabel}${currencyName}${reason ? `（原因：${reason}）` : ''}`,
      actorId: interaction.user.id,
      actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)`,
    });
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    const targetLabel = target ? `${target.user.tag} (<@${targetId}>)` : `<@${targetId}>`;
    const changeEmbed = new EmbedBuilder()
      .setColor(action === 'add' ? 0x57f287 : 0xed4245)
      .setTitle(`💰 ${data.name}余额变更`)
      .addFields(
        { name: '被调整成员', value: targetLabel, inline: false },
        { name: '变更数量', value: `${signedAmount >= 0 ? '+' : '-'}${formatMoney(Math.abs(signedAmount))} ${currencyName}`, inline: true },
        { name: '变更后余额', value: `${formatMoney(after)} ${currencyName}`, inline: false },
        { name: '操作者', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false },
        { name: '原因', value: reason || '未填写', inline: false },
      )
      .setTimestamp();
    const sourceMessage = interaction.message || (messageIdFromModal ? await interaction.channel?.messages.fetch(messageIdFromModal).catch(() => null) : null);
    if (sourceMessage) {
      const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
      if (targetUser) await sourceMessage.edit({ embeds: [panelEmbed(interaction.guild, targetUser)], components: panelComponents() }).catch(() => null);
    }
    await interaction.reply({
      embeds: [changeEmbed],
    });
    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    if (targetUser) {
      await targetUser.send({ embeds: [changeEmbed.setFooter({ text: '这是你的余额变更通知' })] }).catch(() => null);
    }
    return;
  }
  return false;
}

function setupBalances(client) {
  loadData();
  client.on('interactionCreate', (interaction) => handleBalanceInteraction(interaction).catch((error) => {
    console.error('Balance interaction failed:', error);
    const response = { content: '余额操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { balanceCommand, balanceNameCommand, setupBalances, setBalanceAuditSender, roundMoney, parseMoney, formatMoney, getBalance, changeBalance, getMajorBalance, changeMajorBalance, getGuildData };
