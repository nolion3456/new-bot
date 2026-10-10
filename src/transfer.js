const {
  EmbedBuilder,
  SlashCommandBuilder,
} = require('discord.js');
const { changeBalance, getBalance, getGuildData, formatMoney, parseMoney } = require('./balance');

const transferCommand = new SlashCommandBuilder()
  .setName('transfer')
  .setDescription('转账迷你币给其他成员')
  .addUserOption((option) => option.setName('user').setDescription('收款成员').setRequired(true))
  .addStringOption((option) => option.setName('amount').setDescription('转账金额，最多两位小数').setRequired(true))
  .addStringOption((option) => option.setName('reason').setDescription('转账原因（可选）').setRequired(false).setMaxLength(500));

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
  const senderBalance = getBalance(interaction.guildId, interaction.user.id);
  if (senderBalance < amount) return interaction.reply({ content: `余额不足。你要转账 ${formatMoney(amount)} ${currency}，当前余额为 ${formatMoney(senderBalance)} ${currency}。`, ephemeral: true });
  const senderResult = changeBalance(interaction.guildId, interaction.user.id, -amount, {
    reason: `成员转账给 ${recipient.tag}${reason ? `（原因：${reason}）` : ''}`,
    actorId: interaction.user.id,
    actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)`,
  });
  const recipientResult = changeBalance(interaction.guildId, recipient.id, amount, {
    reason: `收到 ${interaction.user.tag} 的成员转账${reason ? `（原因：${reason}）` : ''}`,
    actorId: interaction.user.id,
    actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)`,
  });
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('💸 转账成功')
    .addFields(
      { name: '转账人', value: `${interaction.user.tag} (<@${interaction.user.id}>)`, inline: false },
      { name: '收款人', value: `${recipient.tag} (<@${recipient.id}>)`, inline: false },
      { name: '转账数量', value: `${formatMoney(amount)} ${currency}`, inline: true },
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
        { name: '收到后余额', value: `${formatMoney(recipientResult.after)} ${currency}`, inline: true },
        { name: '转账原因', value: reason || '未填写', inline: false },
        { name: '服务器', value: interaction.guild.name, inline: false },
      )
      .setTimestamp()],
  }).catch(() => null);
  return true;
}

function setupTransfers(client) {
  client.on('interactionCreate', (interaction) => handleTransferInteraction(interaction).catch((error) => {
    console.error('Transfer interaction failed:', error);
    const response = { content: '转账失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { transferCommand, setupTransfers };
