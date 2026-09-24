# Discord 多功能机器人（基础版）

这是一个使用 Node.js 和 discord.js 构建、可部署到 Render 的 Discord 机器人。

## 当前指令

- `/ping`：检查机器人是否在线并显示 WebSocket 延迟。
- `/help`：查看可用指令。
- `/audit-channel add channel:#频道`：由拥有“管理服务器”权限的管理员添加审计频道，最多 3 个。
- `/audit-channel remove channel:#频道`：移除审计频道。
- `/audit-channel list`：查看当前审计频道。

同一条审计日志会发送到已配置的全部审计频道。当前记录内容包括：

- 成员身份组新增和移除；
- 成员昵称修改前与修改后，以及操作者；
- 消息编辑前文字、编辑后文字、发送者、频道、消息发送时间和编辑时间；
- 消息删除前文字、发送者、频道、发送时间、删除时间，以及删除者（通过 Discord 审计日志识别，无法确认时会明确标注）。

## Discord 开发者后台设置

为了读取消息编辑与删除事件，请在 Discord Developer Portal 的 Bot 设置中开启以下 **Privileged Gateway Intents**：

- **Server Members Intent**
- **Message Content Intent**

邀请机器人时，至少授予以下权限：

- View Channels
- Send Messages
- Embed Links
- Read Message History
- View Audit Log（用于识别身份组和消息删除操作者）
- Manage Messages（如果希望机器人读取相关管理审计信息，建议开启）

## 本地运行

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 DISCORD_TOKEN
npm start
```

## 环境变量

- `DISCORD_TOKEN`：Discord Bot Token，必填。
- `DISCORD_GUILD_ID`：可选。填写后会立即向指定服务器注册指令；不填写则注册为全局指令，可能需要一段时间生效。
- `PORT`：可选，Render 会自动提供，默认值为 `10000`。

审计频道配置会通过机器人在第一个审计频道发送的配置消息恢复；不要删除该配置消息。Token 只应设置在本地 `.env` 或 Render 的环境变量中，不能提交到 GitHub。
