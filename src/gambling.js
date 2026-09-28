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
const { changeBalance, getBalance, getGuildData, formatMoney, parseMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'gambling.json');
const configs = new Map();
const settingSessions = new Map();

const gambleCommand = new SlashCommandBuilder()
  .setName('gamble')
  .setDescription('管理员设置并发布迷你币小游戏面板')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

function defaultConfig() {
  return { slot: { price: 10, probability: 35 }, 'high-low': { price: 10, probability: 45 } };
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [guildId, value] of Object.entries(raw)) configs.set(guildId, { ...defaultConfig(), ...value });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load gambling data:', error.message);
  }
}

function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(configs.entries()), null, 2));
  fs.renameSync(temporary, dataFile);
}

function getConfig(guildId) {
  if (!configs.has(guildId)) configs.set(guildId, defaultConfig());
  return configs.get(guildId);
}

function isManager(interaction) {
  return interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function settingKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

function settingsEmbed(session, currency) {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🎮 小游戏设置面板')
    .setDescription('这是私密管理员面板。调整两个游戏的最低下注金额和中奖概率，完成后点击“确认发布”。')
    .addFields(
      { name: '🎰 老司机老虎机', value: `最低下注：${formatMoney(session.slot.price)} ${currency}\n中奖概率：${session.slot.probability}%`, inline: true },
      { name: '🎲 猜大小', value: `最低下注：${formatMoney(session['high-low'].price)} ${currency}\n中奖概率：${session['high-low'].probability}%`, inline: true },
    );
}

function settingsComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gamble:settings:slot').setLabel('设置老虎机').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gamble:settings:high-low').setLabel('设置猜大小').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gamble:settings:confirm').setLabel('确认发布').setEmoji('✅').setStyle(ButtonStyle.Success)),
  ];
}

function settingModal(game) {
  return new ModalBuilder()
    .setCustomId(`gamble:modal:${game}`)
    .setTitle(game === 'slot' ? '设置老虎机' : '设置猜大小')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('最低下注金额').setPlaceholder('例如 10.25').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('probability').setLabel('中奖概率（0-100）').setPlaceholder('例如 35').setStyle(TextInputStyle.Short).setRequired(true)),
    );
}

function publicPanelEmbed(guild) {
  const currency = getGuildData(guild.id).name;
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🎮 迷你币小游戏大厅')
    .setDescription('点击下方按钮后，机器人会私讯显示游戏选择面板。请选择要玩的游戏，再按照提示操作。')
    .addFields(
      { name: '可玩游戏', value: '🎰 老司机老虎机\n🎲 猜大小', inline: true },
      { name: '结算币种', value: currency, inline: true },
      { name: '注意', value: '成员自行输入下注金额；下注不能低于游戏最低下注，中奖时返还 2 倍下注金额。', inline: false },
    )
    .setFooter({ text: '游戏仅使用服务器内虚拟币，不涉及现实货币' });
}

function publicPanelComponents() {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gamble:open').setLabel('开始游戏').setEmoji('🎮').setStyle(ButtonStyle.Primary))];
}

function privateGamePanel() {
  return {
    content: '请选择你要玩的游戏：',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gamble:choose:slot').setLabel('老虎机').setEmoji('🎰').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gamble:choose:high-low').setLabel('猜大小').setEmoji('🎲').setStyle(ButtonStyle.Primary),
    )],
  };
}

function guessPanel() {
  return {
    content: '请选择你猜的结果：',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gamble:guess:high').setLabel('大').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gamble:guess:low').setLabel('小').setStyle(ButtonStyle.Primary),
    )],
  };
}

function randomWin(probability) {
  return Math.random() * 100 < probability;
}

function betModal(game, choice = '') {
  return new ModalBuilder()
    .setCustomId(`gamble:bet-modal:${game}:${choice}`)
    .setTitle(game === 'slot' ? '输入老虎机下注' : `输入猜大小下注（${choice === 'high' ? '大' : '小'}）`)
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('下注金额')
      .setPlaceholder('请输入不低于最低下注的金额')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)));
}

async function playGame(interaction, game, choice, amount) {
  const config = getConfig(interaction.guildId)[game];
  const currency = getGuildData(interaction.guildId).name;
  const price = Number(config.price);
  if (amount === null || amount < price) return interaction.reply({ content: `下注金额不能低于 ${formatMoney(price)} ${currency}。`, ephemeral: true });
  const balance = getBalance(interaction.guildId, interaction.user.id);
  if (balance < amount) return interaction.reply({ content: `余额不足。你的下注金额为 ${formatMoney(amount)} ${currency}，当前余额是 ${formatMoney(balance)} ${currency}。`, ephemeral: true });
  const paid = changeBalance(interaction.guildId, interaction.user.id, -amount);
  const won = randomWin(config.probability);
  const payout = won ? amount * 2 : 0;
  const settled = payout ? changeBalance(interaction.guildId, interaction.user.id, payout) : paid;
  if (game === 'slot') {
    const symbols = won ? ['🍒', '🍒', '🍒'] : ['🍒', '🔔', '💎'];
    return interaction.update({ content: '', embeds: [new EmbedBuilder().setColor(won ? 0x57f287 : 0xed4245).setTitle('🎰 迷你币老虎机').addFields(
      { name: '结果', value: symbols.join(' | '), inline: false },
      { name: '下注金额', value: `${formatMoney(amount)} ${currency}`, inline: true },
      { name: '结果', value: won ? `中奖，返还 ${formatMoney(payout)} ${currency}` : '未中奖', inline: true },
      { name: '变更后余额', value: `${formatMoney(settled.after)} ${currency}`, inline: false },
    ).setTimestamp()], components: [] });
  }
  const number = Math.floor(Math.random() * 100) + 1;
  const actual = number >= 51 ? 'high' : 'low';
  const matched = actual === choice;
  const finalWin = won && matched;
  const finalPayout = finalWin ? amount * 2 : 0;
  const finalSettled = finalPayout ? changeBalance(interaction.guildId, interaction.user.id, finalPayout) : paid;
  return interaction.update({ content: '', embeds: [new EmbedBuilder().setColor(finalWin ? 0x57f287 : 0xed4245).setTitle('🎲 迷你币猜大小').addFields(
    { name: '你的选择', value: choice === 'high' ? '大' : '小', inline: true },
    { name: '系统结果', value: `${number}（${actual === 'high' ? '大' : '小'}）`, inline: true },
    { name: '下注金额', value: `${formatMoney(amount)} ${currency}`, inline: true },
    { name: '结果', value: finalWin ? `中奖，返还 ${formatMoney(finalPayout)} ${currency}` : '未中奖', inline: true },
    { name: '变更后余额', value: `${formatMoney(finalSettled.after)} ${currency}`, inline: false },
  ).setTimestamp()], components: [] });
}

async function handleGamblingInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'gamble') {
    if (!isManager(interaction)) return interaction.reply({ content: '只有拥有“管理服务器”权限的成员可以设置并发布小游戏大厅。', ephemeral: true });
    const current = getConfig(interaction.guildId);
    const session = { slot: { ...current.slot }, 'high-low': { ...current['high-low'] }, channelId: interaction.channelId };
    settingSessions.set(settingKey(interaction), session);
    return interaction.reply({ embeds: [settingsEmbed(session, getGuildData(interaction.guildId).name)], components: settingsComponents(), ephemeral: true });
  }

  if (interaction.isButton() && interaction.customId === 'gamble:open') return interaction.reply(privateGamePanel());

  if (interaction.isButton() && interaction.customId.startsWith('gamble:settings:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const action = interaction.customId.split(':')[2];
    const session = settingSessions.get(settingKey(interaction));
    if (!session) return interaction.reply({ content: '设置面板已过期，请重新使用 `/gamble`。', ephemeral: true });
    if (action === 'confirm') {
      const config = getConfig(interaction.guildId);
      config.slot = session.slot;
      config['high-low'] = session['high-low'];
      saveData();
      settingSessions.delete(settingKey(interaction));
      await interaction.update({ content: '游戏规则已保存，公开游戏大厅已发布到当前频道。', embeds: [], components: [] });
      return interaction.channel.send({ embeds: [publicPanelEmbed(interaction.guild)], components: publicPanelComponents() });
    }
    return interaction.showModal(settingModal(action));
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('gamble:modal:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const game = interaction.customId.split(':')[2];
    const session = settingSessions.get(settingKey(interaction));
    if (!session) return interaction.reply({ content: '设置面板已过期，请重新使用 `/gamble`。', ephemeral: true });
    const price = parseMoney(interaction.fields.getTextInputValue('price'));
    const probability = Number(interaction.fields.getTextInputValue('probability'));
    if (price === null || price <= 0 || !Number.isInteger(probability) || probability < 0 || probability > 100) return interaction.reply({ content: '价格必须是大于 0 的金额，中奖概率必须是 0 到 100 的整数。', ephemeral: true });
    session[game] = { price, probability };
    return interaction.update({ embeds: [settingsEmbed(session, getGuildData(interaction.guildId).name)], components: settingsComponents() });
  }

  if (interaction.isButton() && interaction.customId === 'gamble:choose:slot') return interaction.showModal(betModal('slot'));
  if (interaction.isButton() && interaction.customId === 'gamble:choose:high-low') return interaction.update(guessPanel());
  if (interaction.isButton() && interaction.customId.startsWith('gamble:guess:')) return interaction.showModal(betModal('high-low', interaction.customId.split(':')[2]));
  if (interaction.isModalSubmit() && interaction.customId.startsWith('gamble:bet-modal:')) {
    const [, , game, choice] = interaction.customId.split(':');
    const amount = parseMoney(interaction.fields.getTextInputValue('amount'));
    if (amount === null || amount <= 0) return interaction.reply({ content: '请输入大于 0 且最多两位小数的下注金额。', ephemeral: true });
    return playGame(interaction, game, choice || null, amount);
  }
  return false;
}

function setupGambling(client) {
  loadData();
  client.on('interactionCreate', (interaction) => handleGamblingInteraction(interaction).catch((error) => {
    console.error('Gambling interaction failed:', error);
    const response = { content: '游戏操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { gambleCommand, setupGambling };
