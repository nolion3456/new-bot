const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { changeBalance, changeMajorBalance, getBalance, getMajorBalance, getGuildData, formatMoney, parseMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'exchange.json');
const configs = new Map();
const sessions = new Map();

const exchangeCommand = new SlashCommandBuilder()
  .setName('exchange')
  .setDescription('管理员设置并发布余额兑换面板')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

function defaults() {
  return {
    miniToMajor: { enabled: false, source: 100, target: 1 },
    majorToMini: { enabled: false, source: 1, target: 100 },
  };
}
function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [guildId, config] of Object.entries(raw)) configs.set(guildId, { ...defaults(), ...config });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load exchange data:', error.message);
  }
}
function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(configs.entries()), null, 2));
  fs.renameSync(temporary, dataFile);
}
function getConfig(guildId) {
  if (!configs.has(guildId)) configs.set(guildId, defaults());
  return configs.get(guildId);
}
function isManager(interaction) {
  return interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}
function sessionKey(interaction) { return `${interaction.guildId}:${interaction.user.id}`; }
function ratioText(rule, miniName) { return `${formatMoney(rule.source)} ${rule === undefined ? '' : ''}${rule.source === 1 ? '余额' : miniName} = ${formatMoney(rule.target)} ${rule.target === 1 ? '余额' : miniName}`; }
function settingsEmbed(config, miniName) {
  return new EmbedBuilder().setColor(0x3498db).setTitle('💱 兑换设置面板').setDescription('这是私密管理员面板。你可以分别设置两种币的兑换方向、兑换数量和是否开放。')
    .addFields(
      { name: '迷你币 → 余额', value: `${config.miniToMajor.enabled ? '已开放' : '未开放'}\n${formatMoney(config.miniToMajor.source)} ${miniName} = ${formatMoney(config.miniToMajor.target)} 余额`, inline: true },
      { name: '余额 → 迷你币', value: `${config.majorToMini.enabled ? '已开放' : '未开放'}\n${formatMoney(config.majorToMini.source)} 余额 = ${formatMoney(config.majorToMini.target)} ${miniName}`, inline: true },
    );
}
function settingsComponents(config) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exchange:settings:mini-major').setLabel('设置迷你币→余额').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('exchange:settings:major-mini').setLabel('设置余额→迷你币').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('exchange:settings:toggle-mini-major').setLabel(config.miniToMajor.enabled ? '关闭迷你币→余额' : '开放迷你币→余额').setStyle(config.miniToMajor.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('exchange:settings:toggle-major-mini').setLabel(config.majorToMini.enabled ? '关闭余额→迷你币' : '开放余额→迷你币').setStyle(config.majorToMini.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('exchange:settings:confirm').setLabel('确认发布公开兑换面板').setEmoji('✅').setStyle(ButtonStyle.Primary)),
  ];
}
function settingModal(direction) {
  const miniToMajor = direction === 'mini-major';
  return new ModalBuilder().setCustomId(`exchange:modal:${direction}`).setTitle(miniToMajor ? '设置迷你币兑换余额' : '设置余额兑换迷你币').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('source').setLabel(miniToMajor ? '需要多少迷你币' : '需要多少余额').setPlaceholder('例如 100').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('target').setLabel(miniToMajor ? '兑换得到多少余额' : '兑换得到多少迷你币').setPlaceholder('例如 1').setStyle(TextInputStyle.Short).setRequired(true)),
  );
}
function publicEmbed(guild) {
  const config = getConfig(guild.id);
  const mini = getGuildData(guild.id).name;
  const options = [];
  if (config.miniToMajor.enabled) options.push(`迷你币 → 余额：${formatMoney(config.miniToMajor.source)} ${mini} = ${formatMoney(config.miniToMajor.target)} 余额`);
  if (config.majorToMini.enabled) options.push(`余额 → 迷你币：${formatMoney(config.majorToMini.source)} 余额 = ${formatMoney(config.majorToMini.target)} ${mini}`);
  return new EmbedBuilder().setColor(0x3498db).setTitle('💱 余额兑换中心').setDescription(options.length ? '点击下方按钮后，机器人会私密显示兑换操作面板。' : '目前没有开放任何兑换方向。').addFields({ name: '兑换规则', value: options.join('\n') || '未开放' }).setFooter({ text: '兑换结果和余额只会私密显示给操作成员' });
}
function publicComponents(config) {
  const buttons = [];
  if (config.miniToMajor.enabled) buttons.push(new ButtonBuilder().setCustomId('exchange:open:mini-major').setLabel('迷你币→余额').setStyle(ButtonStyle.Primary));
  if (config.majorToMini.enabled) buttons.push(new ButtonBuilder().setCustomId('exchange:open:major-mini').setLabel('余额→迷你币').setStyle(ButtonStyle.Primary));
  return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
}
function operationModal(direction, miniName, rule) {
  const sourceName = direction === 'mini-major' ? miniName : '余额';
  return new ModalBuilder().setCustomId(`exchange:operate:${direction}`).setTitle(`${sourceName}兑换`).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel(`输入要兑换的${sourceName}数量`).setPlaceholder(`兑换比例：${formatMoney(rule.source)} 换 ${formatMoney(rule.target)}`).setStyle(TextInputStyle.Short).setRequired(true)));
}
async function handleExchange(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'exchange') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const config = JSON.parse(JSON.stringify(getConfig(interaction.guildId)));
    sessions.set(sessionKey(interaction), config);
    return interaction.reply({ embeds: [settingsEmbed(config, getGuildData(interaction.guildId).name)], components: settingsComponents(config), ephemeral: true });
  }
  if (interaction.isButton() && interaction.customId === 'exchange:open') return interaction.reply({ embeds: [publicEmbed(interaction.guild)], components: publicComponents(getConfig(interaction.guildId)), ephemeral: true });
  if (interaction.isButton() && interaction.customId.startsWith('exchange:open:')) {
    const direction = interaction.customId.split(':')[2];
    const rule = getConfig(interaction.guildId)[direction === 'mini-major' ? 'miniToMajor' : 'majorToMini'];
    if (!rule.enabled) return interaction.reply({ content: '这个兑换方向目前没有开放。', ephemeral: true });
    return interaction.showModal(operationModal(direction, getGuildData(interaction.guildId).name, rule));
  }
  if (interaction.isButton() && interaction.customId.startsWith('exchange:settings:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const config = sessions.get(sessionKey(interaction));
    if (!config) return interaction.reply({ content: '设置面板已过期，请重新使用 `/exchange`。', ephemeral: true });
    const action = interaction.customId.split(':')[2];
    if (action === 'confirm') {
      configs.set(interaction.guildId, config); saveData(); sessions.delete(sessionKey(interaction));
      await interaction.update({ content: '兑换规则已保存，公开兑换面板已发布到当前频道。', embeds: [], components: [] });
      return interaction.channel.send({ embeds: [publicEmbed(interaction.guild)], components: publicComponents(config) });
    }
    if (action.startsWith('toggle-')) {
      const direction = action.slice('toggle-'.length);
      config[direction === 'mini-major' ? 'miniToMajor' : 'majorToMini'].enabled = !config[direction === 'mini-major' ? 'miniToMajor' : 'majorToMini'].enabled;
      return interaction.update({ embeds: [settingsEmbed(config, getGuildData(interaction.guildId).name)], components: settingsComponents(config) });
    }
    return interaction.showModal(settingModal(action));
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('exchange:modal:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const config = sessions.get(sessionKey(interaction));
    if (!config) return interaction.reply({ content: '设置面板已过期，请重新使用 `/exchange`。', ephemeral: true });
    const direction = interaction.customId.split(':')[2];
    const source = parseMoney(interaction.fields.getTextInputValue('source'));
    const target = parseMoney(interaction.fields.getTextInputValue('target'));
    if (source === null || target === null || source <= 0 || target <= 0) return interaction.reply({ content: '兑换数量必须是大于 0 的金额，最多支持两位小数。', ephemeral: true });
    config[direction === 'mini-major' ? 'miniToMajor' : 'majorToMini'] = { enabled: true, source, target };
    return interaction.update({ embeds: [settingsEmbed(config, getGuildData(interaction.guildId).name)], components: settingsComponents(config) });
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('exchange:operate:')) {
    const direction = interaction.customId.split(':')[2];
    const config = getConfig(interaction.guildId);
    const rule = config[direction === 'mini-major' ? 'miniToMajor' : 'majorToMini'];
    const amount = parseMoney(interaction.fields.getTextInputValue('amount'));
    const mini = getGuildData(interaction.guildId).name;
    if (!rule.enabled || amount === null || amount <= 0) return interaction.reply({ content: '兑换金额无效或该方向未开放。', ephemeral: true });
    const result = amount / rule.source * rule.target;
    if (direction === 'mini-major') {
      if (getBalance(interaction.guildId, interaction.user.id) < amount) return interaction.reply({ content: `迷你币余额不足，需要 ${formatMoney(amount)} ${mini}。`, ephemeral: true });
      changeBalance(interaction.guildId, interaction.user.id, -amount, { reason: '兑换：迷你币兑换余额', actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
      changeMajorBalance(interaction.guildId, interaction.user.id, result, { reason: '兑换：迷你币兑换余额', actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
    } else {
      if (getMajorBalance(interaction.guildId, interaction.user.id) < amount) return interaction.reply({ content: `余额不足，需要 ${formatMoney(amount)} 余额。`, ephemeral: true });
      changeMajorBalance(interaction.guildId, interaction.user.id, -amount, { reason: '兑换：余额兑换迷你币', actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
      changeBalance(interaction.guildId, interaction.user.id, result, { reason: '兑换：余额兑换迷你币', actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
    }
    return interaction.update({ content: `兑换成功\n\n兑换方向：${direction === 'mini-major' ? `${formatMoney(amount)} ${mini} → ${formatMoney(result)} 余额` : `${formatMoney(amount)} 余额 → ${formatMoney(result)} ${mini}`}\n\n本次兑换结果仅你可见。`, embeds: [], components: [] });
  }
  return false;
}
function setupExchange(client) {
  loadData();
  client.on('interactionCreate', (interaction) => handleExchange(interaction).catch((error) => {
    console.error('Exchange interaction failed:', error);
    const response = { content: '兑换操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null); else interaction.reply(response).catch(() => null);
  }));
}
module.exports = { exchangeCommand, setupExchange };
