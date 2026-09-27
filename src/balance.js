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

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'balances.json');
const guildBalances = new Map();

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
  .setDescription('查看你的迷你币余额并打开操作面板');

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
  if (!guildBalances.has(guildId)) guildBalances.set(guildId, { name: '迷你币', balances: {} });
  return guildBalances.get(guildId);
}

function getBalance(guildId, userId) {
  return getGuildData(guildId).balances[userId] || 0;
}

function panelEmbed(guild, user) {
  const data = getGuildData(guild.id);
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`💰 ${data.name}余额`)
    .setDescription(`<@${user.id}>（${user.tag}），你目前拥有：\n# ${formatMoney(getBalance(guild.id, user.id))} ${data.name}`)
    .setFooter({ text: '只有拥有“管理服务器”权限的成员可以加币或减币' })
    .setTimestamp();
}

function panelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('balance:add').setLabel('加币').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('balance:remove').setLabel('减币').setEmoji('➖').setStyle(ButtonStyle.Danger),
  )];
}

function amountModal(action) {
  const data = new TextInputBuilder()
    .setCustomId('balance:amount')
    .setLabel('数量')
    .setPlaceholder('请输入金额，例如 100、10.25 或 -5.5')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12);
  return new ModalBuilder()
    .setCustomId(`balance:modal:${action}`)
    .setTitle(action === 'add' ? '加币' : '减币')
    .addComponents(new ActionRowBuilder().addComponents(data));
}

function isManager(interaction) {
  return interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function handleBalanceInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'balance') {
    if (!interaction.guild) return interaction.reply({ content: '此指令只能在服务器内使用。', ephemeral: true });
    return interaction.reply({ embeds: [panelEmbed(interaction.guild, interaction.user)], components: panelComponents() });
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
    const action = interaction.customId.split(':')[1];
    return interaction.showModal(amountModal(action));
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('balance:modal:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '只有拥有“管理服务器”权限的成员可以操作余额。', ephemeral: true });
    const action = interaction.customId.split(':')[2];
    const amount = parseMoney(interaction.fields.getTextInputValue('balance:amount'));
    if (amount === null || amount === 0) return interaction.reply({ content: '请输入非 0 金额，最多支持两位小数，例如 `100`、`10.25` 或 `-5.5`。', ephemeral: true });
    const targetId = interaction.message?.embeds?.[0]?.description?.match(/<@!?([0-9]+)>/)?.[1] || interaction.user.id;
    const data = getGuildData(interaction.guildId);
    const before = getBalance(interaction.guildId, targetId);
    const after = roundMoney(action === 'add' ? before + amount : before - amount);
    data.balances[targetId] = after;
    saveData();
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    const targetLabel = target ? `${target.user.tag} (<@${targetId}>)` : `<@${targetId}>`;
    const actionLabel = action === 'add' ? '增加' : '减少';
    await interaction.reply({ content: `余额已更新：${targetLabel} **${actionLabel} ${formatMoney(amount)} ${data.name}**，变更后余额：**${formatMoney(after)} ${data.name}**。操作者：${interaction.user}。` });
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

module.exports = { balanceCommand, balanceNameCommand, setupBalances, roundMoney, parseMoney, formatMoney };
