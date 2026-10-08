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
const dataFile = path.join(dataDir, 'auctions.json');
const auctions = new Map();
const timers = new Map();

const auctionCommand = new SlashCommandBuilder()
  .setName('auction')
  .setDescription('管理迷你币拍卖（管理员）')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
  .addSubcommand((subcommand) => subcommand.setName('create').setDescription('打开私密拍卖设置面板'))
  .addSubcommand((subcommand) => subcommand.setName('end').setDescription('结束当前拍卖并结算'));

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [guildId, auction] of Object.entries(raw)) auctions.set(guildId, auction);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load auction data:', error.message);
  }
}

function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(auctions.entries()), null, 2));
  fs.renameSync(temporary, dataFile);
}

function clearTimer(guildId) {
  if (timers.has(guildId)) clearTimeout(timers.get(guildId));
  timers.delete(guildId);
}

function auctionEmbed(auction, currency) {
  const highest = auction.highestBid;
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🔨 ${auction.item}`)
    .setDescription('使用下方按钮出价。每次出价必须达到当前价格加上最低加价。')
    .addFields(
      { name: '当前价格', value: `${formatMoney(auction.currentPrice)} ${currency}`, inline: true },
      { name: '下一次最低出价', value: `${formatMoney(auction.currentPrice + auction.minIncrement)} ${currency}`, inline: true },
      { name: '当前最高出价者', value: highest ? `<@${highest.userId}>` : '暂无', inline: true },
      { name: '最低加价', value: `${formatMoney(auction.minIncrement)} ${currency}`, inline: true },
      { name: '截止时间', value: auction.endAt ? `<t:${Math.floor(auction.endAt / 1000)}:R>` : '由管理员手动结束', inline: true },
      { name: '出价次数', value: String(auction.bidCount || 0), inline: true },
    )
    .setFooter({ text: `拍卖 ID：${auction.id}｜结算币种：${currency}` })
    .setTimestamp();
}

function auctionComponents() {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('auction:bid').setLabel('出价').setEmoji('💰').setStyle(ButtonStyle.Primary))];
}

function createModal() {
  return new ModalBuilder()
    .setCustomId('auction:create-modal')
    .setTitle('创建迷你币拍卖')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('item').setLabel('拍卖物品').setPlaceholder('例如：稀有头衔').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start').setLabel('起始价格').setPlaceholder('例如：100').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('increment').setLabel('每次最低加价').setPlaceholder('例如：10').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('duration').setLabel('拍卖时长（分钟，留空手动结束）').setPlaceholder('例如：60').setStyle(TextInputStyle.Short).setRequired(false)),
    );
}

function isManager(interaction) {
  return require('./permissions').canManageGuild(interaction);
}

async function publishAuction(interaction, values) {
  if (auctions.has(interaction.guildId)) return interaction.reply({ content: '本服务器已经有一场进行中的拍卖，请先结束它。', ephemeral: true });
  const start = parseMoney(values.start);
  const increment = parseMoney(values.increment);
  const durationText = values.duration.trim();
  const durationMinutes = durationText ? Number(durationText) : 0;
  if (start === null || start < 0 || increment === null || increment <= 0 || (durationText && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 43_200))) {
    return interaction.reply({ content: '起始价格必须是非负金额，最低加价必须大于 0；时长必须是 1 到 43200 分钟的整数或留空。', ephemeral: true });
  }
  const auction = {
    id: `${Date.now()}-${interaction.user.id}`,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    item: values.item.trim(),
    currentPrice: start,
    minIncrement: increment,
    highestBid: null,
    bidCount: 0,
    endAt: durationMinutes ? Date.now() + durationMinutes * 60_000 : null,
    status: 'active',
  };
  const message = await interaction.channel.send({ embeds: [auctionEmbed(auction, getGuildData(interaction.guildId).name)], components: auctionComponents() }).catch(() => null);
  if (!message) return interaction.reply({ content: '发布拍卖失败，请检查机器人频道权限。', ephemeral: true });
  auction.messageId = message.id;
  auctions.set(interaction.guildId, auction);
  saveData();
  scheduleAuction(interaction.client, auction);
  return interaction.reply({ content: `拍卖已发布：${message.url}`, ephemeral: true });
}

async function finishAuction(client, guildId) {
  const auction = auctions.get(guildId);
  if (!auction || auction.status !== 'active') return false;
  clearTimer(guildId);
  auction.status = 'ended';
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const currency = getGuildData(guildId).name;
  let result;
  if (auction.highestBid) {
    const winner = await client.users.fetch(auction.highestBid.userId).catch(() => null);
    const payment = changeBalance(guildId, auction.highestBid.userId, -auction.highestBid.amount, {
      reason: `拍卖结算扣款：${auction.item}`,
      actorLabel: '系统（拍卖结算）',
    });
    result = `🎉 拍卖结束\n\n物品：${auction.item}\n得标者：${winner ? `${winner.tag} (<@${winner.id}>)` : `<@${auction.highestBid.userId}>`}\n成交价格：${formatMoney(auction.highestBid.amount)} ${currency}\n扣款后余额：${formatMoney(payment.after)} ${currency}`;
  } else {
    result = `拍卖结束\n\n物品：${auction.item}\n结果：没有人出价。`;
  }
  auctions.delete(guildId);
  saveData();
  if (guild) {
    const channel = await guild.channels.fetch(auction.channelId).catch(() => null);
    if (channel?.isTextBased()) {
      const oldMessage = await channel.messages.fetch(auction.messageId).catch(() => null);
      if (oldMessage) await oldMessage.edit({ embeds: [auctionEmbed({ ...auction, currentPrice: auction.highestBid?.amount || auction.currentPrice }, currency).setColor(0x95a5a6).setTitle(`🔨 ${auction.item}（已结束）`)], components: [] }).catch(() => null);
      await channel.send({ content: result });
    }
  }
  return true;
}

function scheduleAuction(client, auction) {
  clearTimer(auction.guildId);
  if (!auction.endAt) return;
  const delay = Math.max(1000, auction.endAt - Date.now());
  timers.set(auction.guildId, setTimeout(() => finishAuction(client, auction.guildId), delay));
}

async function handleAuctionInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'auction') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'create') {
      if (auctions.has(interaction.guildId)) return interaction.reply({ content: '本服务器已经有一场进行中的拍卖，请先结束它。', ephemeral: true });
      return interaction.showModal(createModal());
    }
    return finishAuction(interaction.client, interaction.guildId).then((ended) => interaction.reply({ content: ended ? '拍卖已结束并结算。' : '目前没有进行中的拍卖。', ephemeral: true }));
  }

  if (interaction.isModalSubmit() && interaction.customId === 'auction:create-modal') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    return publishAuction(interaction, {
      item: interaction.fields.getTextInputValue('item'),
      start: interaction.fields.getTextInputValue('start'),
      increment: interaction.fields.getTextInputValue('increment'),
      duration: interaction.fields.getTextInputValue('duration'),
    });
  }

  if (interaction.isButton() && interaction.customId === 'auction:bid') {
    const auction = auctions.get(interaction.guildId);
    if (!auction || auction.status !== 'active') return interaction.reply({ content: '这场拍卖已经结束。', ephemeral: true });
    return interaction.showModal(new ModalBuilder().setCustomId('auction:bid-modal').setTitle(`出价：${auction.item}`).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel(`最低出价 ${formatMoney(auction.currentPrice + auction.minIncrement)}`).setPlaceholder('请输入迷你币金额').setStyle(TextInputStyle.Short).setRequired(true))));
  }

  if (interaction.isModalSubmit() && interaction.customId === 'auction:bid-modal') {
    const auction = auctions.get(interaction.guildId);
    if (!auction || auction.status !== 'active') return interaction.reply({ content: '这场拍卖已经结束。', ephemeral: true });
    const amount = parseMoney(interaction.fields.getTextInputValue('amount'));
    const minimum = auction.currentPrice + auction.minIncrement;
    if (amount === null || amount < minimum) return interaction.reply({ content: `出价必须至少为 ${formatMoney(minimum)} ${getGuildData(interaction.guildId).name}。`, ephemeral: true });
    const balance = getBalance(interaction.guildId, interaction.user.id);
    if (balance < amount) return interaction.reply({ content: `你的余额不足。当前余额：${formatMoney(balance)} ${getGuildData(interaction.guildId).name}。`, ephemeral: true });
    auction.currentPrice = amount;
    auction.highestBid = { userId: interaction.user.id, amount };
    auction.bidCount = (auction.bidCount || 0) + 1;
    saveData();
    await interaction.update({ embeds: [auctionEmbed(auction, getGuildData(interaction.guildId).name)], components: auctionComponents() });
    return interaction.followUp({ content: `出价成功：${formatMoney(amount)} ${getGuildData(interaction.guildId).name}。`, ephemeral: true });
  }
  return false;
}

function setupAuctions(client) {
  loadData();
  client.on('ready', () => {
    for (const auction of auctions.values()) if (auction.status === 'active') scheduleAuction(client, auction);
  });
  client.on('interactionCreate', (interaction) => handleAuctionInteraction(interaction).catch((error) => {
    console.error('Auction interaction failed:', error);
    const response = { content: '拍卖操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null);
    else interaction.reply(response).catch(() => null);
  }));
}

module.exports = { auctionCommand, setupAuctions };
