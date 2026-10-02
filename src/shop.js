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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { changeMajorBalance, getMajorBalance, formatMoney, parseMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'shop.json');
const shops = new Map();
const sessions = new Map();
const browseSessions = new Map();

const shopCommand = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('管理员设置并发布商城面板')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

function defaultShop() {
  return { nextId: 1, products: [] };
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
  return new EmbedBuilder().setColor(0x9b59b6).setTitle('🛒 商城管理面板').setDescription('这是私密管理员面板。你可以上架、下架、编辑价格和库存，库存填写 `-1` 代表无限数量。\n\n' + lines.join('\n')).setFooter({ text: '点击“发布公开商城”后，成员可在当前频道逛商城' });
}
function adminComponents(shop, selectedId = null) {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:admin:add').setLabel('上架商品').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('shop:admin:publish').setLabel('发布公开商城').setEmoji('🛒').setStyle(ButtonStyle.Primary),
  )];
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
async function handleShop(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'shop') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const shop = JSON.parse(JSON.stringify(getShop(interaction.guildId)));
    sessions.set(key(interaction), { shop, selectedId: null });
    return interaction.reply({ embeds: [adminEmbed(shop)], components: adminComponents(shop), ephemeral: true });
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
    return interaction.update({ content: `购买成功\n\n商品：${current.name}\n购买数量：${quantity}\n商品单价：${formatMoney(current.price)} 余额\n支付总价：${formatMoney(total)} 余额\n剩余库存：${current.stock === -1 ? '无限' : current.stock}\n扣款后余额：${formatMoney(getMajorBalance(interaction.guildId, interaction.user.id))} 余额`, embeds: [], components: [] });
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
  client.on('interactionCreate', (interaction) => handleShop(interaction).catch((error) => {
    console.error('Shop interaction failed:', error);
    const response = { content: '商城操作失败，请稍后再试。', ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(response).catch(() => null); else interaction.reply(response).catch(() => null);
  }));
}
module.exports = { shopCommand, setupShop };
