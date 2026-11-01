const {
  EmbedBuilder,
  SlashCommandBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { changeBalance, getBalance, getGuildData, formatMoney, parseMoney, roundMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const taxDataFile = path.join(dataDir, 'transfer-tax.json');
const taxSettings = new Map();
const botManagerId = String(process.env.BOT_MANAGER_ID || '').trim();

const transferCommand = new SlashCommandBuilder()
  .setName('transfer')
  .setDescription('转账迷你币给其他成员')
  .addUserOption((option) => option.setName('user').setDescription('收款成员').setRequired(true))
  .addStringOption((option) => option.setName('amount').setDescription('转账金额，最多两位小数').setRequired(true))
  .addStringOption((option) => option.setName('reason').setDescription('转账原因（可选）').setRequired(false).setMaxLength(500));

const transferTaxCommand = new SlashCommandBuilder()
  .setName('transfer-tax')
  .setDescription('设置成员转账税率和收税成员（服务器拥有者/机器人管理者）')
  .addStringOption((option) => option.setName('action').setDescription('操作').setRequired(true).addChoices(
    { name: '设置税率与收税成员', value: 'set' },
    { name: '关闭转账税', value: 'disable' },
    { name: '查看当前设置', value: 'view' },
  ))
  .addStringOption((option) => option.setName('rate').setDescription('税率百分比，例如 5 或 2.5；设置操作必填').setRequired(false))
  .addUserOption((option) => option.setName('recipient').setDescription('收取税额的成员；设置操作必填').setRequired(false));

function loadTaxData() {
  try {
    const raw = JSON.parse(fs.readFileSync(taxDataFile, 'utf8'));
    for (const [guildId, value] of Object.entries(raw)) {
      if (value?.recipientId && Number.isFinite(Number(value.rate))) taxSettings.set(guildId, { rate: Math.max(0, Math.min(100, Number(value.rate))), recipientId: String(value.recipientId) });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load transfer tax settings:', error.message);
  }
}

function saveTaxData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${taxDataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(taxSettings.entries()), null, 2));
  fs.renameSync(temporary, taxDataFile);
}

function canManageTransferTax(interaction) {
  return Boolean(interaction.guild && (interaction.guild.ownerId === interaction.user.id || (botManagerId && botManagerId === interaction.user.id)));
}

function getTaxSetting(guildId) {
  return taxSettings.get(guildId) || { rate: 0, recipientId: null };
}

function taxSettingEmbed(guild, title = '转账收税设置') {
  const setting = getTaxSetting(guild.id);
  return new EmbedBuilder()
    .setColor(setting.rate > 0 ? 0xe67e22 : 0x95a5a6)
    .setTitle(`💸 ${title}`)
    .addFields(
      { name: '当前税率', value: `${formatMoney(setting.rate)}%`, inline: true },
      { name: '收税成员', value: setting.recipientId ? `<@${setting.recipientId}>` : '未设置', inline: true },
    )
    .setFooter({ text: '税额由转账人额外承担，收款人仍收到完整转账金额' })
    .setTimestamp();
}

async function handleTransferInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'transfer') return false;
  if (!interaction.guild) return interaction.reply({ content: '此指令只能在服务器内使用。', ephemeral: true });
  const recipient = interaction.options.getUser('user');
  const amount = parseMoney(interaction.options.getString('amount'));
  const reason = interaction.options.getString('reason')?.trim() || '';
  const currency = getGuildData(interaction.guildId).name;
  if (!recipient || recipient.bot) return interaction.reply({ content: '不能转账给机器人。', ephemeral: true });
  if (recipient.id === interaction.user.id) return interaction.reply({ content: '不能转账给自己。', ephemeral: true });
  if (amount === null || amount <= 0) return interaction.reply({ content: '转账金额必须大于 0，且最多支持两位小数。', ephemeral: true });
  const taxSetting = getTaxSetting(interaction.guildId);
  const tax = roundMoney(amount * taxSetting.rate / 100);
  const totalCost = roundMoney(amount + tax);
  const senderBalance = getBalance(interaction.guildId, interaction.user.id);
  if (senderBalance < totalCost) return interaction.reply({ content: `余额不足。转账金额为 ${formatMoney(amount)} ${currency}，税额为 ${formatMoney(tax)} ${currency}，总共需要 ${formatMoney(totalCost)} ${currency}；当前余额为 ${formatMoney(senderBalance)} ${currency}。`, ephemeral: true });
  const senderResult = changeBalance(interaction.guildId, interaction.user.id, -totalCost, {
    reason: `成员转账给 ${recipient.tag}${reason ? `（原因：${reason}）` : ''}`,
    actorId: interaction.user.id,
    actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)`,
  });
  changeBalance(interaction.guildId, recipient.id, amount, {
    reason: `收到 ${interaction.user.tag} 的成员转账${reason ? `（原因：${reason}）` : ''}`,
    actorId: interaction.user.id,
    actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)`,
  });
  if (tax > 0 && taxSetting.recipientId) changeBalance(interaction.guildId, taxSetting.recipientId, tax, {
    reason: `成员转账税（来自 ${interaction.user.tag}）`,
    actorId: interaction.user.id,
    actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)`,
  });
  const recipientBalanceAfter = getBalance(interaction.guildId, recipient.id);
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('💸 转账成功')
    .addFields(
      { name: '转账人', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false },
      { name: '收款人', value: `${recipient.tag} (<@${recipient.id}>)`, inline: false },
      { name: '转账数量', value: `${formatMoney(amount)} ${currency}`, inline: true },
      { name: '转账税额', value: tax > 0 ? `${formatMoney(tax)} ${currency} → <@${taxSetting.recipientId}>` : '未收税', inline: true },
      { name: '实际扣除', value: `${formatMoney(totalCost)} ${currency}`, inline: true },
      { name: '转账人余额', value: `${formatMoney(senderResult.after)} ${currency}`, inline: true },
      { name: '转账原因', value: reason || '未填写', inline: false },
    )
    .setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
  await recipient.send({
    embeds: [new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('💰 你收到一笔转账')
      .setDescription('你在服务器中收到了一笔迷你币转账。')
      .addFields(
        { name: '转账人', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false },
        { name: '收到数量', value: `${formatMoney(amount)} ${currency}`, inline: true },
        { name: '收到后余额', value: `${formatMoney(recipientBalanceAfter)} ${currency}`, inline: true },
        { name: '转账税额', value: tax > 0 ? `${formatMoney(tax)} ${currency}` : '未收税', inline: true },
        { name: '转账原因', value: reason || '未填写', inline: false },
        { name: '服务器', value: interaction.guild.name, inline: false },
      )
      .setTimestamp()],
  }).catch(() => null);
  return true;
}

async function handleTransferTaxInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'transfer-tax') return false;
  if (!interaction.guild) return interaction.reply({ content: '此指令只能在服务器内使用。', ephemeral: true });
  if (!canManageTransferTax(interaction)) return interaction.reply({ content: '只有服务器拥有者或 BOT_MANAGER_ID 指定的机器人管理者可以设置转账税。', ephemeral: true });
  const action = interaction.options.getString('action', true);
  if (action === 'view') return interaction.reply({ embeds: [taxSettingEmbed(interaction.guild)] });
  if (action === 'disable') {
    taxSettings.delete(interaction.guildId);
    saveTaxData();
    return interaction.reply({ embeds: [taxSettingEmbed(interaction.guild, '转账税已关闭')] });
  }
  const rateText = interaction.options.getString('rate');
  const recipient = interaction.options.getUser('recipient');
  const rate = rateText === null ? null : Number(rateText);
  if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100 || !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(String(rateText).trim())) return interaction.reply({ content: '税率必须是 0 至 100 之间、最多两位小数的百分比，例如 `5` 或 `2.5`。', ephemeral: true });
  if (!recipient || recipient.bot) return interaction.reply({ content: '请指定有效的收税成员，不能设置机器人收税。', ephemeral: true });
  const recipientMember = await interaction.guild.members.fetch(recipient.id).catch(() => null);
  if (!recipientMember) return interaction.reply({ content: '收税成员必须在当前服务器内。', ephemeral: true });
  taxSettings.set(interaction.guildId, { rate: roundMoney(rate), recipientId: recipient.id });
  saveTaxData();
  return interaction.reply({ embeds: [taxSettingEmbed(interaction.guild, '转账税设置成功')] });
}

function setupTransfers(client) {
  loadTaxData();
  client.on('interactionCreate', (interaction) => handleTransferInteraction(interaction).catch((error) => {
    console.error('Transfer interaction failed:', error);
    const response = { content: '转账失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
  client.on('interactionCreate', (interaction) => handleTransferTaxInteraction(interaction).catch((error) => {
    console.error('Transfer tax interaction failed:', error);
    const response = { content: '转账税操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { transferCommand, transferTaxCommand, setupTransfers };
