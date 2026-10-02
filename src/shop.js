const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { changeMajorBalance, getMajorBalance, formatMoney, parseMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'shop.json');
const shops = new Map();
const tickets = new Map();
const sessions = new Map();
const browseSessions = new Map();

const shopCommand = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('管理员设置并发布商城面板')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

function defaultShop() {
  return { nextId: 1, products: [], ticketCategoryId: null, recordChannelId: null };
}
function normalizeProduct(product, fallbackId) {
  return {
    id: String(product.id || fallbackId),
    name: String(product.name || '未命名商品').slice(0, 80),
    description: String(product.description || '暂无商品说明').slice(0, 400),
    price: parseMoney(product.price) ?? 0,
    stock: Number.isInteger(Number(product.stock)) ? Number(product.stock) : 0,
    active: product.active !== false,
  };
}
function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [guildId, shop] of Object.entries(raw)) {
      shops.set(guildId, {
        nextId: Number(shop.nextId) || 1,
        products: (shop.products || []).map((product, index) => normalizeProduct(product, index + 1)),
        ticketCategoryId: shop.ticketCategoryId || null,
        recordChannelId: shop.recordChannelId || null,
      });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load shop data:', error.message);
  }
}
function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${dataFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(shops.entries()), null, 2));
  fs.renameSync(temporary, dataFile);
}
function loadTickets() {
  try {
    const file = path.join(dataDir, 'shop-tickets.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [channelId, ticket] of Object.entries(raw)) tickets.set(channelId, ticket);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to load shop tickets:', error.message);
  }
}
function saveTickets() {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'shop-tickets.json');
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(tickets.entries()), null, 2));
  fs.renameSync(temporary, file);
}
function getShop(guildId) {
  if (!shops.has(guildId)) shops.set(guildId, defaultShop());
  return shops.get(guildId);
}
function isManager(interaction) {
  return interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}
function key(interaction) { return `${interaction.guildId}:${interaction.user.id}`; }
function selectedProduct(shop, id) { return shop.products.find((product) => product.id === String(id)); }
function productStatus(product) {
  if (!product.active) return '已下架';
  if (product.stock === -1) return '无限库存';
  if (product.stock <= 0) return '售罄';
  return `库存 ${product.stock}`;
}
function adminEmbed(shop, selectedId = null) {
  const lines = shop.products.length
    ? shop.products.map((product) => `${product.id}. **${product.name}**｜${formatMoney(product.price)} 余额｜${productStatus(product)}${selectedId === product.id ? ' ← 当前选择' : ''}`)
    : ['目前还没有商品，请先点击“上架商品”。'];
  return new EmbedBuilder().setColor(0x9b59b6).setTitle('🛒 商城管理面板').setDescription('这是私密管理员面板。你可以上架、下架、编辑价格和库存，库存填写 `-1` 代表无限数量。\n\n' + lines.join('\n')).addFields(
    { name: '工单分类', value: shop.ticketCategoryId ? `<#${shop.ticketCategoryId}>` : '未设置（自动放在最上方）', inline: true },
    { name: '记录频道', value: shop.recordChannelId ? `<#${shop.recordChannelId}>` : '未设置（生成记录时需要设置）', inline: true },
  ).setFooter({ text: '点击“发布公开商城”后，成员可在当前频道逛商城' });
}
function adminComponents(shop, selectedId = null) {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:admin:add').setLabel('上架商品').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('shop:admin:publish').setLabel('发布公开商城').setEmoji('🛒').setStyle(ButtonStyle.Primary),
  )];
  const categorySelect = new ChannelSelectMenuBuilder().setCustomId('shop:admin:category').setPlaceholder('🗂️ 设置工单分类（可选）').setChannelTypes(ChannelType.GuildCategory);
  if (shop.ticketCategoryId) categorySelect.setDefaultChannels(shop.ticketCategoryId);
  rows.push(new ActionRowBuilder().addComponents(categorySelect));
  const recordSelect = new ChannelSelectMenuBuilder().setCustomId('shop:admin:record-channel').setPlaceholder('🧾 设置记录发送频道（可选）').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
  if (shop.recordChannelId) recordSelect.setDefaultChannels(shop.recordChannelId);
  rows.push(new ActionRowBuilder().addComponents(recordSelect));
  if (shop.products.length) {
    const options = shop.products.slice(0, 25).map((product) => new StringSelectMenuOptionBuilder().setLabel(product.name.slice(0, 100)).setDescription(`${formatMoney(product.price)} 余额｜${productStatus(product)}`.slice(0, 100)).setValue(product.id).setDefault(product.id === selectedId));
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('shop:admin:select').setPlaceholder('选择要管理的商品').addOptions(options)));
  }
  if (selectedId && selectedProduct(shop, selectedId)) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop:admin:edit').setLabel('修改商品').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('shop:admin:toggle').setLabel(selectedProduct(shop, selectedId).active ? '下架商品' : '重新上架').setEmoji(selectedProduct(shop, selectedId).active ? '📤' : '📥').setStyle(selectedProduct(shop, selectedId).active ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('shop:admin:delete').setLabel('删除商品').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    ));
  }
  return rows;
}
function productModal(mode, product = {}) {
  const modal = new ModalBuilder().setCustomId(`shop:modal:${mode}${product.id ? `:${product.id}` : ''}`).setTitle(mode === 'add' ? '上架商品' : '修改商品');
  return modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('商品名称').setValue(product.name || '').setMaxLength(80).setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('商品说明').setValue(product.description || '').setMaxLength(400).setStyle(TextInputStyle.Paragraph).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('价格（余额）').setPlaceholder('例如 10.50').setValue(product.price !== undefined ? String(product.price) : '').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('stock').setLabel('数量（-1 = 无限）').setPlaceholder('例如 10 或 -1').setValue(product.stock !== undefined ? String(product.stock) : '').setStyle(TextInputStyle.Short).setRequired(true)),
  );
}
function publicEmbed() {
  return new EmbedBuilder().setColor(0x9b59b6).setTitle('🛒 服务器商城').setDescription('点击下方“逛商城”按钮，机器人会私密显示商品列表和购买操作。').setFooter({ text: '所有商品使用大面额余额购买｜购买前会进行二次确认' });
}
function browseEmbed(shop, showAll = false) {
  const products = shop.products.filter((product) => product.active && (showAll || product.stock === -1 || product.stock > 0));
  const text = products.length
    ? products.map((product) => `**${product.name}**\n${product.description}\n价格：**${formatMoney(product.price)} 余额**｜${productStatus(product)}`).join('\n\n')
    : (showAll ? '目前没有已上架的商品。' : '目前没有有货的商品，请切换到“查看全部”。');
  return new EmbedBuilder().setColor(0x9b59b6).setTitle(`🛍️ 私密商城｜${showAll ? '查看全部' : '只看有货'}`).setDescription(text);
}
function browseComponents(shop, showAll = false) {
  const products = shop.products.filter((product) => product.active && (showAll || product.stock === -1 || product.stock > 0)).slice(0, 25);
  const rows = [];
  if (products.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('shop:browse:select').setPlaceholder('🛍️ 选择商品查看并购买').addOptions(products.map((product) => new StringSelectMenuOptionBuilder().setLabel(product.name.slice(0, 100)).setDescription(`${formatMoney(product.price)} 余额｜${productStatus(product)}`.slice(0, 100)).setValue(product.id)))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:filter:stock').setLabel('只看有货').setEmoji('✅').setStyle(showAll ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('shop:filter:all').setLabel('查看全部').setEmoji('📋').setStyle(showAll ? ButtonStyle.Success : ButtonStyle.Secondary),
  ));
  return rows;
}
function detailEmbed(product) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle(`📦 ${product.name}`).setDescription(product.description).addFields({ name: '价格', value: `${formatMoney(product.price)} 余额`, inline: true }, { name: '库存', value: product.stock === -1 ? '无限数量' : String(product.stock), inline: true });
}
function safeChannelName(value) {
  return String(value || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 70) || 'user';
}
function ticketName(ticket, status = 'open') {
  const prefix = status === 'processing' ? '处理中' : '购买物品';
  return `${prefix}-${safeChannelName(ticket.buyerName)}`.slice(0, 100);
}
function ticketEmbed(ticket) {
  return new EmbedBuilder().setColor(ticket.claimedBy ? 0xf1c40f : 0x2ecc71).setTitle('🧾 商城购买工单').setDescription('管理员可以点击“认领”开始处理；处理完成后点击“关单”。').addFields(
    { name: '购买成员', value: `<@${ticket.buyerId}>`, inline: true },
    { name: '商品', value: ticket.productName, inline: true },
    { name: '数量', value: String(ticket.quantity), inline: true },
    { name: '支付总价', value: `${formatMoney(ticket.total)} 余额`, inline: true },
    { name: '状态', value: ticket.closed ? '已关闭' : ticket.claimedBy ? `处理中（<@${ticket.claimedBy}>）` : '等待认领', inline: true },
  ).setFooter({ text: `工单创建时间：${new Date(ticket.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` });
}
function ticketComponents(ticket) {
  if (ticket.closed) return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:ticket:reopen').setLabel('重新开单').setEmoji('🔓').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('shop:ticket:record').setLabel('生成记录').setEmoji('🧾').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('shop:ticket:delete').setLabel('直接关单').setEmoji('🗑️').setStyle(ButtonStyle.Danger))];
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:ticket:claim').setLabel(ticket.claimedBy ? '已认领' : '认领工单').setEmoji('🙋').setStyle(ticket.claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(Boolean(ticket.claimedBy)), new ButtonBuilder().setCustomId('shop:ticket:close').setLabel('关单').setEmoji('🔒').setStyle(ButtonStyle.Danger))];
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function ticketHtml(ticket) {
  return `<!doctype html><meta charset="utf-8"><title>商城购买记录</title><style>body{font:16px sans-serif;max-width:760px;margin:40px auto;padding:0 20px}dt{font-weight:bold;margin-top:16px}dd{margin:4px 0}</style><h1>商城购买记录</h1><dl><dt>购买成员</dt><dd>${escapeHtml(ticket.buyerName)} (${escapeHtml(ticket.buyerId)})</dd><dt>商品</dt><dd>${escapeHtml(ticket.productName)}</dd><dt>数量</dt><dd>${ticket.quantity}</dd><dt>支付总价</dt><dd>${formatMoney(ticket.total)} 余额</dd><dt>创建时间</dt><dd>${escapeHtml(new Date(ticket.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</dd><dt>认领管理员</dt><dd>${escapeHtml(ticket.claimedByName || '未认领')}</dd><dt>关闭时间</dt><dd>${ticket.closedAt ? escapeHtml(new Date(ticket.closedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) : '未关闭'}</dd></dl>`;
}
async function createTicket(interaction, ticket) {
  const shop = getShop(interaction.guildId);
  const everyone = interaction.guild.roles.everyone;
  const overwrites = [
    { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ticket.buyerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.AttachFiles] },
  ];
  for (const role of interaction.guild.roles.cache.values()) if (role.permissions.has(PermissionFlagsBits.ManageGuild)) overwrites.push({ id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] });
  const channel = await interaction.guild.channels.create({ name: ticketName(ticket), type: ChannelType.GuildText, parent: shop.ticketCategoryId || undefined, permissionOverwrites: overwrites });
  ticket.channelId = channel.id;
  tickets.set(channel.id, ticket);
  saveTickets();
  await channel.send({ content: `<@${ticket.buyerId}>`, embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) });
  return channel;
}
async function handleShop(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'shop') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const shop = JSON.parse(JSON.stringify(getShop(interaction.guildId)));
    sessions.set(key(interaction), { shop, selectedId: null });
    return interaction.reply({ embeds: [adminEmbed(shop)], components: adminComponents(shop), ephemeral: true });
  }
  if (interaction.isButton() && interaction.customId.startsWith('shop:ticket:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '只有管理员可以处理商城工单。', ephemeral: true });
    const ticket = tickets.get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '找不到这个工单记录。', ephemeral: true });
    const action = interaction.customId.split(':')[2];
    if (action === 'claim') {
      if (ticket.claimedBy) return interaction.reply({ content: '这个工单已经被其他管理员认领。', ephemeral: true });
      ticket.claimedBy = interaction.user.id;
      ticket.claimedByName = interaction.user.tag;
      await interaction.channel.setName(ticketName(ticket, 'processing')).catch(() => null);
      saveTickets();
      return interaction.update({ embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) });
    }
    if (action === 'close') {
      ticket.closed = true;
      ticket.closedAt = Date.now();
      saveTickets();
      return interaction.update({ embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) });
    }
    if (action === 'reopen') {
      ticket.closed = false;
      ticket.closedAt = null;
      await interaction.channel.setName(ticketName(ticket, ticket.claimedBy ? 'processing' : 'open')).catch(() => null);
      saveTickets();
      return interaction.update({ embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) });
    }
    if (action === 'record') {
      const shop = getShop(interaction.guildId);
      const channel = shop.recordChannelId ? await interaction.guild.channels.fetch(shop.recordChannelId).catch(() => null) : null;
      if (!channel?.isTextBased()) return interaction.reply({ content: '还没有设置记录发送频道，请管理员在 `/shop` 私密面板中设置。', ephemeral: true });
      await channel.send({ content: `🧾 商城购买记录｜${ticket.productName}｜${ticket.buyerName}`, files: [{ attachment: Buffer.from(ticketHtml(ticket), 'utf8'), name: `shop-ticket-${ticket.channelId}.html` }] });
      return interaction.reply({ content: `记录已生成并发送到 <#${channel.id}>，HTML 文件可以直接用浏览器打开或下载。`, ephemeral: true });
    }
    if (action === 'delete') {
      tickets.delete(interaction.channelId);
      saveTickets();
      await interaction.reply({ content: '工单将被删除。', ephemeral: true });
      return interaction.channel.delete('商城工单直接关单');
    }
  }
  if (interaction.isChannelSelectMenu?.() && interaction.customId.startsWith('shop:admin:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const session = sessions.get(key(interaction));
    if (!session) return interaction.reply({ content: '管理面板已过期，请重新使用 `/shop`。', ephemeral: true });
    const action = interaction.customId.split(':')[2];
    if (action === 'category') session.shop.ticketCategoryId = interaction.values[0] || null;
    if (action === 'record-channel') session.shop.recordChannelId = interaction.values[0] || null;
    return interaction.update({ embeds: [adminEmbed(session.shop, session.selectedId)], components: adminComponents(session.shop, session.selectedId) });
  }
  if (interaction.isButton() && interaction.customId === 'shop:browse') {
    if (!interaction.inGuild()) return interaction.reply({ content: '此按钮只能在服务器内使用。', ephemeral: true });
    const shop = getShop(interaction.guildId);
    browseSessions.set(key(interaction), { showAll: false });
    return interaction.reply({ embeds: [browseEmbed(shop, false)], components: browseComponents(shop, false), ephemeral: true });
  }
  if (interaction.isButton() && interaction.customId.startsWith('shop:filter:')) {
    const showAll = interaction.customId.endsWith(':all');
    browseSessions.set(key(interaction), { showAll });
    const shop = getShop(interaction.guildId);
    return interaction.update({ embeds: [browseEmbed(shop, showAll)], components: browseComponents(shop, showAll) });
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'shop:browse:select') {
    const product = selectedProduct(getShop(interaction.guildId), interaction.values[0]);
    if (!product || !product.active) return interaction.update({ content: '这个商品刚刚下架。', embeds: [], components: [] });
    const buttons = [];
    if (product.stock === -1 || product.stock > 0) buttons.push(new ButtonBuilder().setCustomId(`shop:buy:${product.id}`).setLabel('选择购买数量').setEmoji('🛒').setStyle(ButtonStyle.Success));
    else buttons.push(new ButtonBuilder().setCustomId('shop:soldout').setLabel('已售罄').setEmoji('⛔').setStyle(ButtonStyle.Secondary).setDisabled(true));
    buttons.push(new ButtonBuilder().setCustomId('shop:back').setLabel('返回商品列表').setEmoji('↩️').setStyle(ButtonStyle.Secondary));
    return interaction.update({ embeds: [detailEmbed(product)], components: [new ActionRowBuilder().addComponents(buttons)] });
  }
  if (interaction.isButton() && interaction.customId === 'shop:back') {
    const showAll = browseSessions.get(key(interaction))?.showAll || false;
    return interaction.update({ embeds: [browseEmbed(getShop(interaction.guildId), showAll)], components: browseComponents(getShop(interaction.guildId), showAll) });
  }
  if (interaction.isButton() && interaction.customId.startsWith('shop:buy:')) {
    const product = selectedProduct(getShop(interaction.guildId), interaction.customId.split(':')[2]);
    if (!product || !product.active || (product.stock !== -1 && product.stock <= 0)) return interaction.reply({ content: '这个商品刚刚下架或已经售罄。', ephemeral: true });
    return interaction.showModal(new ModalBuilder().setCustomId(`shop:quantity:${product.id}`).setTitle('选择购买数量').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('购买数量').setPlaceholder(product.stock === -1 ? '请输入正整数，例如 2' : `请输入 1-${product.stock} 之间的数量`).setStyle(TextInputStyle.Short).setRequired(true))));
  }
  if (interaction.isButton() && interaction.customId === 'shop:cancel') return interaction.update({ content: '已取消购买。', embeds: [], components: [] });
  if (interaction.isModalSubmit() && interaction.customId.startsWith('shop:quantity:')) {
    const product = selectedProduct(getShop(interaction.guildId), interaction.customId.split(':')[2]);
    const quantity = Number(interaction.fields.getTextInputValue('quantity').trim());
    if (!product || !product.active || (product.stock !== -1 && product.stock <= 0)) return interaction.reply({ content: '这个商品刚刚下架或已经售罄。', ephemeral: true });
    if (!Number.isInteger(quantity) || quantity < 1 || (product.stock !== -1 && quantity > product.stock)) return interaction.reply({ content: `购买数量必须是正整数${product.stock === -1 ? '' : `，且不能超过库存 ${product.stock}`}。`, ephemeral: true });
    const total = Math.round(product.price * quantity * 100) / 100;
    return interaction.reply({ embeds: [detailEmbed(product).setDescription(`${product.description}\n\n⚠️ 请确认购买数量和总价。`)
      .addFields({ name: '购买数量', value: String(quantity), inline: true }, { name: '应付总价', value: `${formatMoney(total)} 余额`, inline: true })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`shop:confirm:${product.id}:${quantity}`).setLabel('确认购买').setEmoji('✅').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('shop:cancel').setLabel('取消购买').setEmoji('❌').setStyle(ButtonStyle.Secondary))], ephemeral: true });
  }
  if (interaction.isButton() && interaction.customId.startsWith('shop:confirm:')) {
    const [, , productId, quantityText] = interaction.customId.split(':');
    const quantity = Number(quantityText);
    const product = selectedProduct(getShop(interaction.guildId), productId);
    if (!product || !product.active || (product.stock !== -1 && product.stock <= 0)) return interaction.update({ content: '购买失败：商品已下架或售罄。', embeds: [], components: [] });
    if (!Number.isInteger(quantity) || quantity < 1 || (product.stock !== -1 && quantity > product.stock)) return interaction.update({ content: '购买失败：库存不足，请重新选择数量。', embeds: [], components: [] });
    const total = Math.round(product.price * quantity * 100) / 100;
    const balance = getMajorBalance(interaction.guildId, interaction.user.id);
    if (balance < total) return interaction.update({ content: `购买失败：余额不足，需要 ${formatMoney(total)} 余额，你目前有 ${formatMoney(balance)} 余额。`, embeds: [], components: [] });
    const shop = getShop(interaction.guildId);
    const current = selectedProduct(shop, product.id);
    if (!current || !current.active || (current.stock !== -1 && current.stock <= 0)) return interaction.update({ content: '购买失败：商品库存刚刚发生变化。', embeds: [], components: [] });
    if (current.stock !== -1 && quantity > current.stock) return interaction.update({ content: '购买失败：商品库存刚刚发生变化。', embeds: [], components: [] });
    changeMajorBalance(interaction.guildId, interaction.user.id, -total, { reason: `商城购买：${current.name} × ${quantity}`, actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
    if (current.stock !== -1) current.stock -= quantity;
    saveData();
    await interaction.deferUpdate();
    const ticket = { guildId: interaction.guildId, buyerId: interaction.user.id, buyerName: interaction.user.username, productName: current.name, quantity, total, createdAt: Date.now(), claimedBy: null, claimedByName: null, closed: false, closedAt: null };
    const ticketChannel = await createTicket(interaction, ticket).catch((error) => {
      console.error('Failed to create shop ticket:', error.message);
      return null;
    });
    return interaction.editReply({ content: `购买成功\n\n商品：${current.name}\n购买数量：${quantity}\n商品单价：${formatMoney(current.price)} 余额\n支付总价：${formatMoney(total)} 余额\n剩余库存：${current.stock === -1 ? '无限' : current.stock}\n扣款后余额：${formatMoney(getMajorBalance(interaction.guildId, interaction.user.id))} 余额\n\n${ticketChannel ? `工单已建立：<#${ticketChannel.id}>` : '工单建立失败，请联系管理员。'}`, embeds: [], components: [] });
  }
  if (interaction.isButton() && interaction.customId.startsWith('shop:admin:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const session = sessions.get(key(interaction));
    if (!session) return interaction.reply({ content: '管理面板已过期，请重新使用 `/shop`。', ephemeral: true });
    const action = interaction.customId.split(':')[2];
    if (action === 'add') return interaction.showModal(productModal('add'));
    if (action === 'publish') {
      shops.set(interaction.guildId, session.shop); saveData(); sessions.delete(key(interaction));
      await interaction.update({ content: '商城商品已保存，公开商城面板已发布到当前频道。', embeds: [], components: [] });
      return interaction.channel.send({ embeds: [publicEmbed()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:browse').setLabel('逛商城').setEmoji('🛍️').setStyle(ButtonStyle.Primary))] });
    }
    const product = selectedProduct(session.shop, session.selectedId);
    if (!product) return interaction.reply({ content: '请先从下拉菜单选择商品。', ephemeral: true });
    if (action === 'edit') return interaction.showModal(productModal('edit', product));
    if (action === 'toggle') { product.active = !product.active; return interaction.update({ embeds: [adminEmbed(session.shop, session.selectedId)], components: adminComponents(session.shop, session.selectedId) }); }
    if (action === 'delete') { session.shop.products = session.shop.products.filter((item) => item.id !== product.id); session.selectedId = null; return interaction.update({ embeds: [adminEmbed(session.shop)], components: adminComponents(session.shop) }); }
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'shop:admin:select') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const session = sessions.get(key(interaction));
    if (!session) return interaction.reply({ content: '管理面板已过期，请重新使用 `/shop`。', ephemeral: true });
    session.selectedId = interaction.values[0];
    return interaction.update({ embeds: [adminEmbed(session.shop, session.selectedId)], components: adminComponents(session.shop, session.selectedId) });
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('shop:modal:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const session = sessions.get(key(interaction));
    if (!session) return interaction.reply({ content: '管理面板已过期，请重新使用 `/shop`。', ephemeral: true });
    const parts = interaction.customId.split(':');
    const mode = parts[2];
    const name = interaction.fields.getTextInputValue('name').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const price = parseMoney(interaction.fields.getTextInputValue('price'));
    const stockText = interaction.fields.getTextInputValue('stock').trim();
    const stock = Number(stockText);
    if (!name || !description || price === null || price <= 0 || !Number.isInteger(stock) || stock < -1) return interaction.reply({ content: '商品名称和说明不能为空；价格必须大于 0；数量必须是整数且不能小于 -1。', ephemeral: true });
    if (mode === 'add') {
      const product = { id: String(session.shop.nextId++), name, description, price, stock, active: true };
      session.shop.products.push(product); session.selectedId = product.id;
    } else {
      const product = selectedProduct(session.shop, parts[3]);
      if (!product) return interaction.reply({ content: '商品不存在，请重新打开 `/shop`。', ephemeral: true });
      Object.assign(product, { name, description, price, stock }); session.selectedId = product.id;
    }
    return interaction.update({ embeds: [adminEmbed(session.shop, session.selectedId)], components: adminComponents(session.shop, session.selectedId) });
  }
  return false;
}
function setupShop(client) {
  loadData();
  loadTickets();
  client.on('interactionCreate', (interaction) => handleShop(interaction).catch((error) => {
    console.error('Shop interaction failed:', error);
    const response = { content: '商城操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null); else interaction.reply(response).catch(() => null);
  }));
}
module.exports = { shopCommand, setupShop };
