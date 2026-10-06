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
  UserSelectMenuBuilder,
} = require('discord.js');
const { changeMajorBalance, getMajorBalance, formatMoney, parseMoney } = require('./balance');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'shop.json');
const shops = new Map();
const tickets = new Map();
const sessions = new Map();
const browseSessions = new Map();
const carts = new Map();

const shopCommand = new SlashCommandBuilder()
  .setName('shop')
  .setDescription('管理员设置并发布商城面板')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());
const ticketCommand = new SlashCommandBuilder().setName('ticket').setDescription('在当前商城工单中打开管理面板').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString());

function defaultShop() {
  return { nextId: 1, products: [], ticketCategoryId: null, recordChannelId: null, reviewChannelId: null, coupons: [] };
}
function normalizeProduct(product, fallbackId) {
  const infoItems = Array.isArray(product.infoItems) ? product.infoItems.map((item, index) => ({
    id: String(item.id || `${product.id || fallbackId}-info-${index + 1}`),
    username: String(item.username || '').slice(0, 200),
    password: String(item.password || '').slice(0, 200),
    description: String(item.description || '').slice(0, 1000),
  })).filter((item) => item.username || item.password || item.description) : [];
  const normalized = {
    id: String(product.id || fallbackId),
    name: String(product.name || '未命名商品').slice(0, 80),
    description: String(product.description || '暂无商品说明').slice(0, 400),
    price: parseMoney(product.price) ?? 0,
    stock: Number.isInteger(Number(product.stock)) ? Number(product.stock) : 0,
    active: product.active !== false,
    infoStorage: product.infoStorage === true,
    infoItems,
  };
  if (normalized.infoStorage) normalized.stock = infoItems.length;
  return normalized;
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
        reviewChannelId: shop.reviewChannelId || null,
        coupons: (shop.coupons || []).map((coupon) => ({ ...coupon, usedBy: coupon.usedBy || [] })),
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
  return `${product.infoStorage ? '资料库存' : '库存'} ${product.stock}`;
}
function adminEmbed(shop, selectedId = null) {
  const lines = shop.products.length
    ? shop.products.map((product) => `${product.id}. **${product.name}**｜${formatMoney(product.price)} 余额｜${productStatus(product)}${product.infoStorage ? `｜已储存资料 ${product.infoItems.length} 条` : ''}${selectedId === product.id ? ' ← 当前选择' : ''}`)
    : ['目前还没有商品，请先点击“上架商品”。'];
  return new EmbedBuilder().setColor(0x9b59b6).setTitle('🛒 商城管理面板').setDescription('这是私密管理员面板。你可以上架、下架、编辑价格和库存，库存填写 `-1` 代表无限数量。\n\n' + lines.join('\n')).addFields(
    { name: '工单分类', value: shop.ticketCategoryId ? `<#${shop.ticketCategoryId}>` : '未设置（自动放在最上方）', inline: true },
    { name: '记录频道', value: shop.recordChannelId ? `<#${shop.recordChannelId}>` : '未设置（生成记录时需要设置）', inline: true },
    { name: '评价频道', value: shop.reviewChannelId ? `<#${shop.reviewChannelId}>` : '未设置（默认发在工单频道）', inline: true },
    { name: '优惠券', value: shop.coupons.length ? shop.coupons.map((coupon) => `${coupon.code}（${coupon.type === 'percent' ? `${coupon.value}%` : formatMoney(coupon.value)}，${coupon.maxUses ? `剩余/总次数 ${Math.max(0, coupon.maxUses - (coupon.usedBy || []).length)}/${coupon.maxUses}` : '不限次数'}）`).join('\n').slice(0, 1024) : '尚未设置优惠券', inline: false },
  ).setFooter({ text: '点击“发布公开商城”后，成员可在当前频道逛商城' });
}
function adminComponents(shop, selectedId = null) {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:admin:add').setLabel('上架商品').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('shop:admin:publish').setLabel('发布公开商城').setEmoji('🛒').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('shop:admin:review-settings').setLabel('评价频道').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shop:admin:coupon').setLabel('优惠券').setEmoji('🎟️').setStyle(ButtonStyle.Secondary),
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
      new ButtonBuilder().setCustomId('shop:admin:info-toggle').setLabel(selectedProduct(shop, selectedId).infoStorage ? '关闭资料发放' : '开启资料发放').setEmoji('🔐').setStyle(selectedProduct(shop, selectedId).infoStorage ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('shop:admin:info-add').setLabel('添加商品资料').setEmoji('➕').setStyle(ButtonStyle.Primary),
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
function infoItemModal(productId) {
  return new ModalBuilder().setCustomId(`shop:info:add:${productId}`).setTitle('添加商品资料').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('username').setLabel('Roblox 名称').setPlaceholder('请输入账号名称').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('password').setLabel('密码').setPlaceholder('请输入密码').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('资料描述（可选）').setPlaceholder('例如：等级、服务器、备注').setStyle(TextInputStyle.Paragraph).setRequired(false)),
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
function cartKey(interaction) { return `${interaction.guildId}:${interaction.user.id}`; }
function getCart(interaction) {
  if (!carts.has(cartKey(interaction))) carts.set(cartKey(interaction), []);
  return carts.get(cartKey(interaction));
}
function cartEmbed(interaction) {
  const cart = getCart(interaction);
  const shop = getShop(interaction.guildId);
  const lines = cart.length ? cart.map((item) => {
    const product = selectedProduct(shop, item.productId);
    const price = product?.price ?? item.price;
    return `**${product?.name || item.name}** × ${item.quantity}｜${formatMoney(price * item.quantity)} 余额`;
  }) : ['购物车目前是空的。'];
  const total = cart.reduce((sum, item) => {
    const product = selectedProduct(shop, item.productId);
    return sum + (product?.price ?? item.price) * item.quantity;
  }, 0);
  return new EmbedBuilder().setColor(0x2ecc71).setTitle('🛒 我的购物车').setDescription(lines.join('\n')).addFields({ name: '商品种类', value: String(cart.length), inline: true }, { name: '预计总价', value: `${formatMoney(total)} 余额`, inline: true });
}
function cartComponents(interaction) {
  const hasItems = getCart(interaction).length > 0;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop:cart:checkout').setLabel('结算购物车').setEmoji('💳').setStyle(ButtonStyle.Success).setDisabled(!hasItems),
    new ButtonBuilder().setCustomId('shop:cart:clear').setLabel('清空购物车').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!hasItems),
    new ButtonBuilder().setCustomId('shop:continue').setLabel('继续购物').setEmoji('🛍️').setStyle(ButtonStyle.Primary),
  )];
}
function currentCart(interaction) {
  const cart = getCart(interaction);
  const shop = getShop(interaction.guildId);
  const items = [];
  for (const item of cart) {
    const product = selectedProduct(shop, item.productId);
    if (!product || !product.active) return { error: `${item.name} 已下架。` };
    if ((product.stock !== -1 && product.stock < item.quantity) || !hasInfoStock(product, item.quantity)) return { error: `${product.name} 的商品资料库存不足，目前只有 ${product.infoStorage ? product.infoItems.length : product.stock} 件。` };
    items.push({ productId: product.id, name: product.name, quantity: item.quantity, price: product.price, subtotal: Math.round(product.price * item.quantity * 100) / 100 });
  }
  return { items, total: Math.round(items.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100 };
}
function itemsTotal(items) { return Math.round(items.reduce((sum, item) => sum + Number(item.price) * Number(item.quantity), 0) * 100) / 100; }
function couponDiscount(coupon, amount) {
  if (!coupon) return 0;
  return Math.min(amount, Math.round((coupon.type === 'percent' ? amount * coupon.value / 100 : coupon.value) * 100) / 100);
}
function validCoupon(shop, code, userId) {
  const coupon = shop.coupons.find((item) => item.code.toLowerCase() === code.toLowerCase() && item.active !== false);
  if (!coupon) return { error: '优惠券不存在或已停用。' };
  if (coupon.expiresAt && coupon.expiresAt < Date.now()) return { error: '优惠券已过期。' };
  if (coupon.maxUses > 0 && (coupon.usedBy || []).length >= coupon.maxUses) return { error: '优惠券已达到使用上限。' };
  if (coupon.perUser && (coupon.usedBy || []).includes(userId)) return { error: '你已经使用过这张优惠券。' };
  return { coupon };
}
function hasInfoStock(product, quantity) {
  return !product.infoStorage || (product.stock !== -1 && product.infoItems.length >= quantity);
}
function takeRandomInfo(product, quantity) {
  const selected = [];
  for (let index = 0; index < quantity; index += 1) {
    const itemIndex = Math.floor(Math.random() * product.infoItems.length);
    selected.push(product.infoItems.splice(itemIndex, 1)[0]);
  }
  product.stock = product.infoItems.length;
  return selected;
}
function safeChannelName(value) {
  return String(value || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 70) || 'user';
}
function ticketName(ticket, status = 'open') {
  const prefix = status === 'processing' ? '处理中' : '购买物品';
  return `${prefix}-${safeChannelName(ticket.buyerName)}`.slice(0, 100);
}
function ticketStatus(ticket) { return ticket.status || (ticket.closed ? 'closed' : ticket.claimedBy ? 'processing' : 'open'); }
function ticketEmbed(ticket) {
  const itemText = ticket.items?.length ? ticket.items.map((item) => `${item.name} × ${item.quantity}`).join('\n') : ticket.productName;
  const status = ticketStatus(ticket);
  return new EmbedBuilder().setColor(status === 'cancelled' ? 0xe74c3c : status === 'completed' ? 0x2ecc71 : ticket.claimedBy ? 0xf1c40f : 0x3498db).setTitle('🧾 商城购买工单').setDescription('使用下方按钮处理订单；成员只能操作自己的订单。').addFields(
    { name: '购买成员', value: `<@${ticket.buyerId}>`, inline: true },
    { name: '商品', value: itemText.slice(0, 1024), inline: false },
    { name: '数量', value: String(ticket.quantity), inline: true },
    { name: '支付总价', value: `${formatMoney(ticket.total)} 余额`, inline: true },
    { name: '状态', value: status === 'processing' ? `处理中（<@${ticket.claimedBy}>）` : ({ open: '等待处理', completed: '已完成', cancelled: ticket.refunded ? '已取消（已退款）' : '已取消', closed: '已关闭' }[status] || status), inline: true },
    ...(ticket.couponCode ? [{ name: '优惠券', value: `${ticket.couponCode}（-${formatMoney(ticket.discount || 0)}）`, inline: true }] : []),
  ).setFooter({ text: `工单创建时间：${new Date(ticket.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` });
}
function reviewPanelEmbed(ticket) {
  return new EmbedBuilder().setColor(0xf1c40f).setTitle('⭐ 订单评价').setDescription('订单已经完成，感谢你的购买！请点击下方按钮填写评价。只有开单成员可以提交。').addFields(
    { name: '商品', value: ticket.productName, inline: true },
    { name: '购买成员', value: `<@${ticket.buyerId}>`, inline: true },
  );
}
function reviewPanelComponents() {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:ticket:review').setLabel('填写评价').setEmoji('⭐').setStyle(ButtonStyle.Primary))];
}
function reviewResultEmbed(ticket) {
  return new EmbedBuilder().setColor(0xf1c40f).setTitle('⭐ 订单评价').addFields(
    { name: '商品', value: ticket.productName, inline: true },
    { name: '评分', value: `${'⭐'.repeat(ticket.review.rating)}（${ticket.review.rating}/5）`, inline: true },
    { name: '评价内容', value: ticket.review.comment || '成员未填写文字评价', inline: false },
  ).setTimestamp(ticket.review.createdAt);
}
function ticketComponents(ticket) {
  const status = ticketStatus(ticket);
  if (status === 'closed') return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:ticket:reopen').setLabel('重新开单').setEmoji('🔓').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('shop:ticket:record').setLabel('生成记录').setEmoji('🧾').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('shop:ticket:delete').setLabel('直接关单').setEmoji('🗑️').setStyle(ButtonStyle.Danger))];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop:ticket:complete').setLabel('完成订单').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(['completed', 'cancelled'].includes(status)),
      new ButtonBuilder().setCustomId('shop:ticket:cancel').setLabel('取消订单').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(['completed', 'cancelled'].includes(status)),
      new ButtonBuilder().setCustomId('shop:ticket:edit').setLabel('编辑商品').setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(['completed', 'cancelled'].includes(status)),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('shop:ticket:claim').setLabel(ticket.claimedBy ? '已认领' : '认领工单').setEmoji('🙋').setStyle(ticket.claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(Boolean(ticket.claimedBy) || ['completed', 'cancelled'].includes(status)),
      new ButtonBuilder().setCustomId('shop:ticket:close').setLabel('关闭订单').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('shop:ticket:coupon').setLabel('填写优惠券').setEmoji('🎟️').setStyle(ButtonStyle.Secondary),
    ),
  ];
}
function ticketAdminComponents(ticket) {
  const statusSelect = new StringSelectMenuBuilder().setCustomId('shop:ticket-admin:status').setPlaceholder('调整订单状态').addOptions(
    new StringSelectMenuOptionBuilder().setLabel('等待处理').setValue('open'),
    new StringSelectMenuOptionBuilder().setLabel('处理中').setValue('processing'),
    new StringSelectMenuOptionBuilder().setLabel('完成订单').setValue('completed'),
    new StringSelectMenuOptionBuilder().setLabel('取消订单').setValue('cancelled'),
    new StringSelectMenuOptionBuilder().setLabel('关闭订单').setValue('closed'),
  );
  return [
    new ActionRowBuilder().addComponents(statusSelect),
    new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('shop:ticket-admin:add-member').setPlaceholder('添加可以查看此工单的成员')),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:ticket-admin:coupon').setLabel('设置优惠券').setEmoji('🎟️').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('shop:ticket-admin:record').setLabel('生成记录').setEmoji('🧾').setStyle(ButtonStyle.Secondary)),
  ];
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function ticketHtml(ticket, transcript = []) {
  const items = ticket.items?.length ? ticket.items.map((item) => `<li>${escapeHtml(item.name)} × ${item.quantity}</li>`).join('') : `<li>${escapeHtml(ticket.productName)} × ${ticket.quantity}</li>`;
  const chat = transcript.length ? transcript.map((message) => `<article><b>${escapeHtml(message.author)}</b> <time>${escapeHtml(message.time)}</time><p>${escapeHtml(message.content || '（无文字内容）').replace(/\n/g, '<br>')}</p>${message.attachments.length ? `<p>附件：${message.attachments.map(escapeHtml).join('<br>')}</p>` : ''}</article>`).join('') : '<p>未读取到聊天记录。</p>';
  return `<!doctype html><meta charset="utf-8"><title>商城购买记录</title><style>body{font:16px sans-serif;max-width:860px;margin:40px auto;padding:0 20px}dt{font-weight:bold;margin-top:16px}dd{margin:4px 0}article{border-top:1px solid #ddd;padding:12px 0}time{color:#777;font-size:12px}article p{white-space:normal;margin:6px 0}</style><h1>商城购买记录</h1><dl><dt>购买成员</dt><dd>${escapeHtml(ticket.buyerName)} (${escapeHtml(ticket.buyerId)})</dd><dt>商品</dt><dd><ul>${items}</ul></dd><dt>商品总数量</dt><dd>${ticket.quantity}</dd><dt>支付总价</dt><dd>${formatMoney(ticket.total)} 余额</dd><dt>创建时间</dt><dd>${escapeHtml(new Date(ticket.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))}</dd><dt>认领管理员</dt><dd>${escapeHtml(ticket.claimedByName || '未认领')}</dd><dt>关闭时间</dt><dd>${ticket.closedAt ? escapeHtml(new Date(ticket.closedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) : '未关闭'}</dd></dl><h2>聊天记录</h2>${chat}`;
}
async function collectTranscript(channel) {
  const messages = [];
  let before;
  for (let page = 0; page < 10; page += 1) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch?.size) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp).map((message) => ({
    author: message.author?.tag || message.author?.username || '未知成员',
    time: new Date(message.createdTimestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    content: message.content || '',
    attachments: [...message.attachments.values()].map((attachment) => attachment.url),
  }));
}
async function sendTicketRecord(interaction, ticket) {
  const sourceChannel = interaction.channel;
  const transcript = sourceChannel?.messages ? await collectTranscript(sourceChannel) : [];
  const buffer = Buffer.from(ticketHtml(ticket, transcript), 'utf8');
  const fileName = `shop-ticket-${ticket.channelId}.html`;
  const shop = getShop(interaction.guildId);
  const recordChannel = shop.recordChannelId ? await interaction.guild.channels.fetch(shop.recordChannelId).catch(() => null) : null;
  const sentChannel = Boolean(recordChannel?.isTextBased());
  if (sentChannel) await recordChannel.send({ content: `🧾 商城购买记录｜${ticket.productName}｜${ticket.buyerName}（包含聊天记录）`, files: [{ attachment: buffer, name: fileName }] });
  const buyer = await interaction.client.users.fetch(ticket.buyerId).catch(() => null);
  const sentDm = Boolean(await buyer?.send({ content: '这是你的商城购买记录，包含工单聊天记录。', files: [{ attachment: buffer, name: fileName }] }).catch(() => null));
  return { sentChannel, sentDm };
}
function infoPanelEmbed(ticket, info, index, total) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle(`🔐 商品资料 ${index}/${total}`).setDescription('这是你购买的商品资料，请妥善保存。').addFields(
    { name: '商品', value: ticket.productName, inline: true },
    { name: 'Roblox 名称', value: info.username || '未提供', inline: false },
    { name: '密码', value: info.password || '未提供', inline: false },
    { name: '描述', value: info.description || '无', inline: false },
  ).setFooter({ text: '此资料仅发送到私密商城工单频道' });
}
async function deliverTicketInfo(ticket, channel) {
  const deliveries = ticket.infoDeliveries || [];
  for (let index = 0; index < deliveries.length; index += 1) {
    await channel.send({ embeds: [infoPanelEmbed(ticket, deliveries[index], index + 1, deliveries.length)] }).catch(() => null);
  }
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
  const panel = await channel.send({ content: `<@${ticket.buyerId}>`, embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) });
  ticket.panelMessageId = panel.id;
  saveTickets();
  await deliverTicketInfo(ticket, channel);
  return channel;
}
async function refreshTicketPanel(ticket, guild) {
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  const message = channel?.messages ? await channel.messages.fetch(ticket.panelMessageId).catch(() => null) : null;
  if (message) await message.edit({ embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) }).catch(() => null);
}
function ticketRefund(ticket, interaction, reason) {
  if (ticket.refunded || !ticket.total) return false;
  changeMajorBalance(ticket.guildId, ticket.buyerId, ticket.total, { reason, actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
  ticket.refunded = true;
  return true;
}
function restoreTicketStock(ticket) {
  if (ticket.stockRestored) return;
  const shop = getShop(ticket.guildId);
  for (const item of (ticket.items || [])) {
    const product = selectedProduct(shop, item.productId);
    if (product?.stock !== -1) product.stock += item.quantity;
  }
  ticket.stockRestored = true;
  saveData();
}
async function handleShop(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'shop') {
    if (!isManager(interaction)) return interaction.reply({ content: '你需要“管理服务器”权限。', ephemeral: true });
    const shop = JSON.parse(JSON.stringify(getShop(interaction.guildId)));
    sessions.set(key(interaction), { shop, selectedId: null });
    return interaction.reply({ embeds: [adminEmbed(shop)], components: adminComponents(shop), ephemeral: true });
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'ticket') {
    if (!isManager(interaction)) return interaction.reply({ content: '只有管理员可以使用 `/ticket`。', ephemeral: true });
    const ticket = tickets.get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '只能在商城工单频道内使用 `/ticket`。', ephemeral: true });
    return interaction.reply({ embeds: [ticketEmbed(ticket)], components: ticketAdminComponents(ticket), ephemeral: true });
  }
  if (interaction.isButton() && interaction.customId.startsWith('shop:ticket-admin:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '只有管理员可以操作工单管理面板。', ephemeral: true });
    const ticket = tickets.get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '找不到这个工单记录。', ephemeral: true });
    const parts = interaction.customId.split(':');
    const action = parts[2];
    if (action === 'coupon') return interaction.showModal(new ModalBuilder().setCustomId('shop:ticket-admin:coupon-modal').setTitle('设置优惠券').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel('代码').setPlaceholder('例如 SAVE10').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('type').setLabel('类型：percent 或 fixed').setValue('percent').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('value').setLabel('折扣数值').setPlaceholder('percent 填 10 代表 10%，fixed 填余额数').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('maxUses').setLabel('总使用次数（0 = 不限）').setValue('0').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('perUser').setLabel('每人限用一次？yes/no').setValue('yes').setStyle(TextInputStyle.Short).setRequired(true)),
    ));
    if (action === 'record') {
      const result = await sendTicketRecord(interaction, ticket);
      if (!result.sentChannel && !result.sentDm) return interaction.reply({ content: '记录生成失败：请先设置有效的记录频道，并确认买家允许接收私讯。', ephemeral: true });
      return interaction.reply({ content: `记录已生成${result.sentChannel ? '并发送到指定记录频道' : ''}${result.sentDm ? '，也已私讯给开单者' : '，但无法私讯开单者'}。`, ephemeral: true });
    }
    if (action === 'cancel' && parts[3]) {
      ticket.status = 'cancelled'; ticket.cancelledAt = Date.now();
      restoreTicketStock(ticket);
      if (parts[3] === 'refund') ticketRefund(ticket, interaction, '管理员取消订单退款');
      saveTickets(); await refreshTicketPanel(ticket, interaction.guild);
      return interaction.update({ content: ticket.refunded ? '订单已取消并退款。' : '订单已取消且不退款。', components: [] });
    }
    return interaction.reply({ content: '请使用状态下拉菜单调整订单状态。', ephemeral: true });
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'shop:ticket-admin:status') {
    if (!isManager(interaction)) return interaction.reply({ content: '只有管理员可以调整工单状态。', ephemeral: true });
    const ticket = tickets.get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '找不到这个工单记录。', ephemeral: true });
    const status = interaction.values[0];
    if (status === 'cancelled') return interaction.reply({ content: '管理员取消订单时请选择是否退款：', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:ticket-admin:cancel:refund').setLabel('取消并退款').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('shop:ticket-admin:cancel:norefund').setLabel('取消但不退款').setStyle(ButtonStyle.Danger))], ephemeral: true });
    ticket.status = status; ticket.closed = status === 'closed'; ticket.closedAt = status === 'closed' ? Date.now() : null; ticket.claimedBy = status === 'processing' ? (ticket.claimedBy || interaction.user.id) : ticket.claimedBy;
    saveTickets(); await refreshTicketPanel(ticket, interaction.guild);
    if (status === 'completed') await interaction.channel.send({ content: `<@${ticket.buyerId}>`, embeds: [reviewPanelEmbed(ticket)], components: reviewPanelComponents() });
    return interaction.update({ embeds: [ticketEmbed(ticket)], components: ticketAdminComponents(ticket) });
  }
  if (interaction.isUserSelectMenu?.() && interaction.customId === 'shop:ticket-admin:add-member') {
    if (!isManager(interaction)) return interaction.reply({ content: '只有管理员可以添加成员。', ephemeral: true });
    const ticket = tickets.get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '找不到这个工单记录。', ephemeral: true });
    const memberId = interaction.values[0];
    await interaction.channel.permissionOverwrites.edit(memberId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
    ticket.extraMembers = [...new Set([...(ticket.extraMembers || []), memberId])]; saveTickets();
    return interaction.update({ embeds: [ticketEmbed(ticket)], components: ticketAdminComponents(ticket) });
  }
  if (interaction.isButton() && interaction.customId.startsWith('shop:ticket:')) {
    const ticket = tickets.get(interaction.channelId);
    if (!ticket) return interaction.reply({ content: '找不到这个工单记录。', ephemeral: true });
    const parts = interaction.customId.split(':');
    const action = parts[2];
    const manager = isManager(interaction);
    const owner = interaction.user.id === ticket.buyerId;
    if (!manager && !owner) return interaction.reply({ content: '只有购买成员或管理员可以操作这个工单。', ephemeral: true });
    if (action === 'claim') {
      if (!manager) return interaction.reply({ content: '只有管理员可以认领工单。', ephemeral: true });
      if (ticket.claimedBy) return interaction.reply({ content: '这个工单已经被其他管理员认领。', ephemeral: true });
      ticket.claimedBy = interaction.user.id;
      ticket.claimedByName = interaction.user.tag;
      await interaction.channel.setName(ticketName(ticket, 'processing')).catch(() => null);
      saveTickets();
      return interaction.update({ embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) });
    }
    if (action === 'close' && !parts[3]) {
      if (!manager) return interaction.reply({ content: '只有管理员可以关闭订单。', ephemeral: true });
      await interaction.deferUpdate();
      return interaction.channel.send({ embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle('🔒 确认关闭订单').setDescription('管理员请求关闭此订单。确认后原本的订单面板不会改变，并会在频道中显示关闭后的新面板。')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:ticket:close:confirm').setLabel('确认关闭订单').setEmoji('🔒').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('shop:ticket:close:cancel').setLabel('取消').setStyle(ButtonStyle.Secondary))] });
    }
    if (action === 'close' && parts[3] === 'confirm') {
      if (!manager) return interaction.reply({ content: '只有管理员可以确认关闭订单。', ephemeral: true });
      ticket.status = 'closed'; ticket.closed = true; ticket.closedAt = Date.now(); saveTickets();
      return interaction.update({ content: '订单已关闭。原始订单面板保持不变；以下是新的关闭后操作面板。', embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) });
    }
    if (action === 'close' && parts[3] === 'cancel') return interaction.update({ content: '已取消关闭订单。', components: [] });
    if (action === 'complete') {
      if (!manager) return interaction.reply({ content: '只有管理员可以完成订单。', ephemeral: true });
      ticket.status = 'completed'; ticket.completedAt = Date.now(); saveTickets();
      await refreshTicketPanel(ticket, interaction.guild);
      await interaction.channel.send({ content: `<@${ticket.buyerId}>`, embeds: [reviewPanelEmbed(ticket)], components: reviewPanelComponents() });
      return interaction.reply({ content: '订单已标记为完成，并已发送公开评价面板。', ephemeral: true });
    }
    if (action === 'cancel') {
      if (parts[3] === 'refund' || parts[3] === 'norefund') {
        if (!manager) return interaction.reply({ content: '只有管理员可以确认此取消方式。', ephemeral: true });
        ticket.status = 'cancelled'; ticket.cancelledAt = Date.now();
        if (parts[3] === 'refund') ticketRefund(ticket, interaction, '管理员取消订单退款');
        saveTickets(); await refreshTicketPanel(ticket, interaction.guild);
        return interaction.update({ content: ticket.refunded ? '订单已取消，余额已退回。' : '订单已取消，不退回余额。', components: [] });
      }
      if (manager) return interaction.reply({ content: '请选择是否退回余额：', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:ticket:cancel:refund').setLabel('取消并退款').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('shop:ticket:cancel:norefund').setLabel('取消但不退款').setStyle(ButtonStyle.Danger))], ephemeral: true });
      ticket.status = 'cancelled'; ticket.cancelledAt = Date.now(); restoreTicketStock(ticket); ticketRefund(ticket, interaction, '成员取消订单退款'); saveTickets(); await refreshTicketPanel(ticket, interaction.guild);
      return interaction.reply({ content: '订单已取消，余额已退回。', ephemeral: true });
    }
    if (action === 'edit') {
      return interaction.showModal(new ModalBuilder().setCustomId('shop:ticket:edit-modal').setTitle('编辑购买商品').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('items').setLabel('商品ID:数量，用逗号分隔').setPlaceholder('例如 1:2, 3:1；可在商城商品列表查看 ID').setValue((ticket.items || []).map((item) => `${item.productId}:${item.quantity}`).join(',')).setStyle(TextInputStyle.Paragraph).setRequired(true))));
    }
    if (action === 'coupon') return interaction.showModal(new ModalBuilder().setCustomId('shop:ticket:coupon-modal').setTitle('填写优惠券').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel('优惠券代码').setPlaceholder('请输入管理员提供的代码').setStyle(TextInputStyle.Short).setRequired(true))));
    if (action === 'review') {
      if (!owner) return interaction.reply({ content: '只有开单者可以填写评价。', ephemeral: true });
      return interaction.showModal(new ModalBuilder().setCustomId('shop:ticket:review-modal').setTitle('填写订单评价').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('rating').setLabel('评分（1-5）').setStyle(TextInputStyle.Short).setRequired(true)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('comment').setLabel('评价内容').setStyle(TextInputStyle.Paragraph).setRequired(false))));
    }
    if (action === 'reopen') {
      ticket.closed = false;
      ticket.status = ticket.claimedBy ? 'processing' : 'open';
      ticket.closedAt = null;
      await interaction.channel.setName(ticketName(ticket, ticket.claimedBy ? 'processing' : 'open')).catch(() => null);
      saveTickets();
      return interaction.update({ embeds: [ticketEmbed(ticket)], components: ticketComponents(ticket) });
    }
    if (action === 'record') {
      const result = await sendTicketRecord(interaction, ticket);
      if (!result.sentChannel && !result.sentDm) return interaction.reply({ content: '记录生成失败：请先设置有效的记录频道，并确认买家允许接收私讯。', ephemeral: true });
      return interaction.reply({ content: `记录已生成${result.sentChannel ? '并发送到指定记录频道' : ''}${result.sentDm ? '，也已私讯给开单者' : '，但无法私讯开单者'}。HTML 文件包含工单聊天记录。`, ephemeral: true });
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
    if (action === 'review-channel') session.shop.reviewChannelId = interaction.values[0] || null;
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
    if (product.stock === -1 || product.stock > 0) {
      buttons.push(new ButtonBuilder().setCustomId(`shop:cart:add:${product.id}`).setLabel('加入购物车').setEmoji('🛒').setStyle(ButtonStyle.Primary));
      buttons.push(new ButtonBuilder().setCustomId(`shop:buy:${product.id}`).setLabel('立即购买').setEmoji('⚡').setStyle(ButtonStyle.Success));
    }
    else buttons.push(new ButtonBuilder().setCustomId('shop:soldout').setLabel('已售罄').setEmoji('⛔').setStyle(ButtonStyle.Secondary).setDisabled(true));
    buttons.push(new ButtonBuilder().setCustomId('shop:back').setLabel('返回商品列表').setEmoji('↩️').setStyle(ButtonStyle.Secondary));
    return interaction.update({ embeds: [detailEmbed(product)], components: [new ActionRowBuilder().addComponents(buttons)] });
  }
  if (interaction.isButton() && interaction.customId === 'shop:back') {
    const showAll = browseSessions.get(key(interaction))?.showAll || false;
    return interaction.update({ embeds: [browseEmbed(getShop(interaction.guildId), showAll)], components: browseComponents(getShop(interaction.guildId), showAll) });
  }
  if (interaction.isButton() && interaction.customId === 'shop:continue') {
    const showAll = browseSessions.get(key(interaction))?.showAll || false;
    return interaction.update({ embeds: [browseEmbed(getShop(interaction.guildId), showAll)], components: browseComponents(getShop(interaction.guildId), showAll) });
  }
  if (interaction.isButton() && interaction.customId === 'shop:cart:view') return interaction.update({ embeds: [cartEmbed(interaction)], components: cartComponents(interaction) });
  if (interaction.isButton() && interaction.customId === 'shop:cart:clear') {
    carts.set(cartKey(interaction), []);
    return interaction.update({ content: '购物车已清空。', embeds: [cartEmbed(interaction)], components: cartComponents(interaction) });
  }
  if (interaction.isButton() && interaction.customId.startsWith('shop:cart:add:')) {
    const product = selectedProduct(getShop(interaction.guildId), interaction.customId.split(':')[3]);
    if (!product || !product.active || (product.stock !== -1 && product.stock <= 0)) return interaction.reply({ content: '这个商品刚刚下架或已经售罄。', ephemeral: true });
    return interaction.showModal(new ModalBuilder().setCustomId(`shop:cart:quantity:${product.id}`).setTitle('加入购物车').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('加入数量').setPlaceholder(product.stock === -1 ? '请输入正整数，例如 2' : `请输入 1-${product.stock} 之间的数量`).setStyle(TextInputStyle.Short).setRequired(true))));
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('shop:cart:quantity:')) {
    const product = selectedProduct(getShop(interaction.guildId), interaction.customId.split(':')[3]);
    const quantity = Number(interaction.fields.getTextInputValue('quantity').trim());
    if (!product || !product.active || (product.stock !== -1 && product.stock <= 0)) return interaction.reply({ content: '这个商品刚刚下架或已经售罄。', ephemeral: true });
    if (!Number.isInteger(quantity) || quantity < 1 || (product.stock !== -1 && quantity > product.stock)) return interaction.reply({ content: `加入数量必须是正整数${product.stock === -1 ? '' : `，且不能超过库存 ${product.stock}`}。`, ephemeral: true });
    const cart = getCart(interaction);
    const existing = cart.find((item) => item.productId === product.id);
    if (existing) existing.quantity += quantity;
    else cart.push({ productId: product.id, name: product.name, price: product.price, quantity });
    return interaction.reply({ content: `已将 **${product.name} × ${quantity}** 加入购物车。你可以继续挑选其他商品，最后统一结算。`, embeds: [cartEmbed(interaction)], components: cartComponents(interaction), ephemeral: true });
  }
  if (interaction.isButton() && interaction.customId === 'shop:cart:checkout') {
    const summary = currentCart(interaction);
    if (summary.error) return interaction.reply({ content: `无法结算：${summary.error}`, ephemeral: true });
    if (!summary.items.length) return interaction.reply({ content: '购物车目前是空的。', ephemeral: true });
    const balance = getMajorBalance(interaction.guildId, interaction.user.id);
    if (balance < summary.total) return interaction.reply({ content: `余额不足，需要 ${formatMoney(summary.total)} 余额，你目前有 ${formatMoney(balance)} 余额。`, ephemeral: true });
    const itemText = summary.items.map((item) => `${item.name} × ${item.quantity}`).join('\n');
    return interaction.update({ embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle('⚠️ 确认结算购物车').setDescription(`${itemText}\n\n应付总价：**${formatMoney(summary.total)} 余额**\n\n请确认后才会统一扣款并创建一个合并工单。`)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:cart:confirm').setLabel('确认结算').setEmoji('✅').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('shop:cart:cancel').setLabel('返回购物车').setEmoji('↩️').setStyle(ButtonStyle.Secondary))] });
  }
  if (interaction.isButton() && interaction.customId === 'shop:cart:cancel') return interaction.update({ embeds: [cartEmbed(interaction)], components: cartComponents(interaction) });
  if (interaction.isButton() && interaction.customId === 'shop:cart:confirm') {
    const summary = currentCart(interaction);
    if (summary.error) return interaction.update({ content: `结算失败：${summary.error}`, embeds: [], components: [] });
    const balance = getMajorBalance(interaction.guildId, interaction.user.id);
    if (!summary.items.length || balance < summary.total) return interaction.update({ content: '结算失败：购物车为空或余额不足。', embeds: [], components: [] });
    const shop = getShop(interaction.guildId);
    for (const item of summary.items) {
      const current = selectedProduct(shop, item.productId);
      if (!current || !current.active || (current.stock !== -1 && current.stock < item.quantity) || !hasInfoStock(current, item.quantity)) return interaction.update({ content: `结算失败：${item.name} 的库存或商品资料刚刚发生变化，请重新检查购物车。`, embeds: [], components: [] });
    }
    changeMajorBalance(interaction.guildId, interaction.user.id, -summary.total, { reason: `商城购物车结算：${summary.items.length} 种商品`, actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
    const infoDeliveries = [];
    for (const item of summary.items) {
      const current = selectedProduct(shop, item.productId);
      if (current.stock !== -1) current.stock -= item.quantity;
      if (current.infoStorage) infoDeliveries.push(...takeRandomInfo(current, item.quantity));
    }
    saveData();
    const ticket = { guildId: interaction.guildId, buyerId: interaction.user.id, buyerName: interaction.user.username, productName: `${summary.items.length} 种商品`, quantity: summary.items.reduce((sum, item) => sum + item.quantity, 0), total: summary.total, baseTotal: summary.total, items: summary.items, infoDeliveries, createdAt: Date.now(), claimedBy: null, claimedByName: null, closed: false, status: 'open', closedAt: null };
    carts.set(cartKey(interaction), []);
    await interaction.deferUpdate();
    const ticketChannel = await createTicket(interaction, ticket).catch((error) => { console.error('Failed to create shop cart ticket:', error.message); return null; });
    return interaction.editReply({ content: `购物车结算成功\n\n商品种类：${summary.items.length}\n商品总数量：${ticket.quantity}\n支付总价：${formatMoney(summary.total)} 余额\n扣款后余额：${formatMoney(getMajorBalance(interaction.guildId, interaction.user.id))} 余额\n\n${ticketChannel ? `合并工单已建立：<#${ticketChannel.id}>` : '工单建立失败，请联系管理员。'}`, embeds: [], components: [] });
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
    if ((current.stock !== -1 && quantity > current.stock) || !hasInfoStock(current, quantity)) return interaction.update({ content: '购买失败：商品库存或商品资料刚刚发生变化。', embeds: [], components: [] });
    changeMajorBalance(interaction.guildId, interaction.user.id, -total, { reason: `商城购买：${current.name} × ${quantity}`, actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
    if (current.stock !== -1) current.stock -= quantity;
    const infoDeliveries = current.infoStorage ? takeRandomInfo(current, quantity) : [];
    saveData();
    await interaction.deferUpdate();
    const ticket = { guildId: interaction.guildId, buyerId: interaction.user.id, buyerName: interaction.user.username, productName: current.name, quantity, total, baseTotal: total, items: [{ productId: current.id, name: current.name, quantity, price: current.price, subtotal: total }], infoDeliveries, createdAt: Date.now(), claimedBy: null, claimedByName: null, closed: false, status: 'open', closedAt: null };
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
    if (action === 'coupon') return interaction.showModal(new ModalBuilder().setCustomId('shop:ticket-admin:coupon-modal').setTitle('设置优惠券').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('code').setLabel('代码').setPlaceholder('例如 SAVE10').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('type').setLabel('类型：percent 或 fixed').setValue('percent').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('value').setLabel('折扣数值').setPlaceholder('percent 填 10 代表 10%，fixed 填余额数').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('maxUses').setLabel('总使用次数（0 = 不限）').setValue('0').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('perUser').setLabel('每人限用一次？yes/no').setValue('yes').setStyle(TextInputStyle.Short).setRequired(true)),
    ));
    if (action === 'review-settings') {
      const select = new ChannelSelectMenuBuilder().setCustomId('shop:admin:review-channel').setPlaceholder('选择评价发送频道').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
      if (session.shop.reviewChannelId) select.setDefaultChannels(session.shop.reviewChannelId);
      return interaction.reply({ content: '选择后，成员提交的评价会发送到该频道。', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    }
    if (action === 'publish') {
      shops.set(interaction.guildId, session.shop); saveData(); sessions.delete(key(interaction));
      await interaction.update({ content: '商城商品已保存，公开商城面板已发布到当前频道。', embeds: [], components: [] });
      return interaction.channel.send({ embeds: [publicEmbed()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop:browse').setLabel('逛商城').setEmoji('🛍️').setStyle(ButtonStyle.Primary))] });
    }
    const product = selectedProduct(session.shop, session.selectedId);
    if (!product) return interaction.reply({ content: '请先从下拉菜单选择商品。', ephemeral: true });
    if (action === 'info-toggle') {
      if (!product.infoStorage && product.stock === -1) return interaction.reply({ content: '启用商品资料发放后必须使用有限库存，不能设置为无限数量。请先把库存改为有限数量。', ephemeral: true });
      product.infoStorage = !product.infoStorage;
      if (product.infoStorage) product.stock = product.infoItems.length;
      return interaction.update({ embeds: [adminEmbed(session.shop, session.selectedId)], components: adminComponents(session.shop, session.selectedId) });
    }
    if (action === 'info-add') {
      if (!product.infoStorage) return interaction.reply({ content: '请先开启“资料发放”，并确保商品使用有限库存。', ephemeral: true });
      return interaction.showModal(infoItemModal(product.id));
    }
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
  if (interaction.isModalSubmit() && interaction.customId === 'shop:ticket-admin:coupon-modal') {
    if (!isManager(interaction)) return interaction.reply({ content: '只有管理员可以设置优惠券。', ephemeral: true });
    const code = interaction.fields.getTextInputValue('code').trim().toUpperCase();
    const type = interaction.fields.getTextInputValue('type').trim().toLowerCase();
    const value = Number(interaction.fields.getTextInputValue('value').trim());
    const maxUses = Number(interaction.fields.getTextInputValue('maxUses').trim());
    const perUser = ['yes', 'y', '是', 'true'].includes(interaction.fields.getTextInputValue('perUser').trim().toLowerCase());
    if (!code || !['percent', 'fixed'].includes(type) || !Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100) || !Number.isInteger(maxUses) || maxUses < 0) return interaction.reply({ content: '优惠券参数无效：类型只能是 percent/fixed，折扣必须为正数，percent 不能超过 100，次数必须是非负整数。', ephemeral: true });
    const shop = getShop(interaction.guildId);
    if (shop.coupons.some((coupon) => coupon.code.toLowerCase() === code.toLowerCase())) return interaction.reply({ content: '这个优惠券代码已经存在。', ephemeral: true });
    shop.coupons.push({ code, type, value, maxUses, perUser, active: true, usedBy: [], createdBy: interaction.user.id });
    saveData();
    return interaction.reply({ content: `优惠券 **${code}** 已创建。类型：${type}，数值：${value}，总次数：${maxUses || '不限'}，每人限用一次：${perUser ? '是' : '否'}。`, ephemeral: true });
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('shop:info:add:')) {
    if (!isManager(interaction)) return interaction.reply({ content: '只有管理员可以添加商品资料。', ephemeral: true });
    const session = sessions.get(key(interaction));
    if (!session) return interaction.reply({ content: '商城管理面板已过期，请重新使用 `/shop`。', ephemeral: true });
    const product = selectedProduct(session.shop, interaction.customId.split(':')[3]);
    if (!product || !product.infoStorage || product.stock === -1) return interaction.reply({ content: '这个商品没有开启有限数量的资料发放。', ephemeral: true });
    const item = {
      id: `${product.id}-info-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username: interaction.fields.getTextInputValue('username').trim(),
      password: interaction.fields.getTextInputValue('password').trim(),
      description: interaction.fields.getTextInputValue('description')?.trim() || '',
    };
    if (!item.username || !item.password) return interaction.reply({ content: 'Roblox 名称和密码不能为空。', ephemeral: true });
    product.infoItems.push(item);
    product.stock = product.infoItems.length;
    return interaction.update({ embeds: [adminEmbed(session.shop, session.selectedId)], components: adminComponents(session.shop, session.selectedId) });
  }
  if (interaction.isModalSubmit() && interaction.customId === 'shop:ticket:edit-modal') {
    const ticket = tickets.get(interaction.channelId);
    if (!ticket || ['completed', 'cancelled'].includes(ticketStatus(ticket))) return interaction.reply({ content: '这个订单已经完成或取消，不能再编辑。', ephemeral: true });
    if (interaction.user.id !== ticket.buyerId && !isManager(interaction)) return interaction.reply({ content: '只有开单者或管理员可以编辑商品。', ephemeral: true });
    const entries = interaction.fields.getTextInputValue('items').split(',').map((value) => value.trim()).filter(Boolean);
    const shop = getShop(interaction.guildId);
    const oldItems = ticket.items || [{ productId: null, name: ticket.productName, quantity: ticket.quantity, price: ticket.baseTotal / ticket.quantity }];
    const oldQuantities = new Map();
    for (const item of oldItems) oldQuantities.set(String(item.productId), (oldQuantities.get(String(item.productId)) || 0) + item.quantity);
    const newItems = [];
    for (const entry of entries) {
      const [productId, quantityText] = entry.split(':').map((value) => value.trim());
      const quantity = Number(quantityText);
      const product = selectedProduct(shop, productId);
      const available = product?.stock === -1 ? -1 : (product?.stock || 0) + (oldQuantities.get(String(productId)) || 0);
      if (!product || !product.active || !Number.isInteger(quantity) || quantity < 1 || (available !== -1 && available < quantity)) return interaction.reply({ content: `商品 ID ${productId} 不存在、已下架或库存不足。`, ephemeral: true });
      newItems.push({ productId: product.id, name: product.name, quantity, price: product.price, subtotal: Math.round(product.price * quantity * 100) / 100 });
    }
    if (!newItems.length) return interaction.reply({ content: '至少需要保留一种商品。', ephemeral: true });
    const baseTotal = itemsTotal(newItems);
    const discount = ticket.couponCode ? couponDiscount(shop.coupons.find((coupon) => coupon.code.toLowerCase() === ticket.couponCode.toLowerCase()), baseTotal) : 0;
    const newTotal = Math.max(0, Math.round((baseTotal - discount) * 100) / 100);
    const delta = Math.round((newTotal - ticket.total) * 100) / 100;
    if (delta > 0 && getMajorBalance(interaction.guildId, interaction.user.id) < delta) return interaction.reply({ content: `编辑后还需要补款 ${formatMoney(delta)} 余额，但你的余额不足。`, ephemeral: true });
    for (const item of oldItems) { const product = selectedProduct(shop, item.productId); if (product?.stock !== -1) product.stock += item.quantity; }
    for (const item of newItems) { const product = selectedProduct(shop, item.productId); if (product.stock !== -1) product.stock -= item.quantity; }
    if (delta) changeMajorBalance(interaction.guildId, interaction.user.id, -delta, { reason: '编辑商城订单金额调整', actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
    ticket.items = newItems; ticket.productName = `${newItems.length} 种商品`; ticket.quantity = newItems.reduce((sum, item) => sum + item.quantity, 0); ticket.baseTotal = baseTotal; ticket.discount = discount; ticket.total = newTotal;
    saveData(); saveTickets(); await refreshTicketPanel(ticket, interaction.guild);
    return interaction.reply({ content: `订单商品已更新，当前总价为 ${formatMoney(newTotal)} 余额。${delta < 0 ? `已退回 ${formatMoney(-delta)} 余额。` : delta > 0 ? `已补扣 ${formatMoney(delta)} 余额。` : ''}`, ephemeral: true });
  }
  if (interaction.isModalSubmit() && interaction.customId === 'shop:ticket:coupon-modal') {
    const ticket = tickets.get(interaction.channelId);
    if (!ticket || ['completed', 'cancelled'].includes(ticketStatus(ticket))) return interaction.reply({ content: '这个订单目前不能填写优惠券。', ephemeral: true });
    if (interaction.user.id !== ticket.buyerId && !isManager(interaction)) return interaction.reply({ content: '只有开单者或管理员可以填写优惠券。', ephemeral: true });
    if (ticket.couponCode) return interaction.reply({ content: '这个订单已经使用过优惠券，不能重复使用。', ephemeral: true });
    const code = interaction.fields.getTextInputValue('code').trim();
    const result = validCoupon(getShop(interaction.guildId), code, ticket.buyerId);
    if (result.error) return interaction.reply({ content: result.error, ephemeral: true });
    const coupon = result.coupon;
    const discount = couponDiscount(coupon, ticket.baseTotal || ticket.total);
    if (discount <= 0) return interaction.reply({ content: '这张优惠券无法减少当前订单金额。', ephemeral: true });
    changeMajorBalance(interaction.guildId, ticket.buyerId, discount, { reason: `使用优惠券：${coupon.code}`, actorId: interaction.user.id, actorLabel: `${interaction.user.tag} (<@${interaction.user.id}>)` });
    coupon.usedBy = coupon.usedBy || []; coupon.usedBy.push(ticket.buyerId); ticket.couponCode = coupon.code; ticket.discount = discount; ticket.total = Math.max(0, Math.round((ticket.baseTotal - discount) * 100) / 100);
    saveData(); saveTickets(); await refreshTicketPanel(ticket, interaction.guild);
    return interaction.reply({ content: `优惠券使用成功，已退回 ${formatMoney(discount)} 余额。`, ephemeral: true });
  }
  if (interaction.isModalSubmit() && interaction.customId === 'shop:ticket:review-modal') {
    const ticket = tickets.get(interaction.channelId);
    if (!ticket || interaction.user.id !== ticket.buyerId) return interaction.reply({ content: '只有开单者可以填写评价。', ephemeral: true });
    const rating = Number(interaction.fields.getTextInputValue('rating').trim());
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return interaction.reply({ content: '评分必须是 1 到 5。', ephemeral: true });
    ticket.review = { rating, comment: interaction.fields.getTextInputValue('comment')?.trim() || '', createdAt: Date.now() }; saveTickets();
    await interaction.reply({ content: '评价已提交，谢谢你的反馈！', ephemeral: true });
    const reviewChannel = getShop(interaction.guildId).reviewChannelId ? await interaction.guild.channels.fetch(getShop(interaction.guildId).reviewChannelId).catch(() => null) : null;
    return (reviewChannel?.isTextBased() ? reviewChannel : interaction.channel).send({ embeds: [reviewResultEmbed(ticket)] });
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
      if (product.infoStorage && stock === -1) return interaction.reply({ content: '已开启资料发放的商品不能设置无限库存。', ephemeral: true });
      Object.assign(product, { name, description, price, stock }); session.selectedId = product.id;
      if (product.infoStorage) product.stock = product.infoItems.length;
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
