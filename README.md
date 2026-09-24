# Discord 多功能机器人（基础版）

这是一个使用 Node.js 和 discord.js 构建、可部署到 Render 的 Discord 机器人。

## 当前指令

- `/ping`：检查机器人是否在线并显示 WebSocket 延迟。
- `/help`：查看可用指令。
- `/audit-channel`：由拥有“管理服务器”权限的管理员打开私密后台审计频道面板。

执行 `/audit-channel` 后，机器人只会向指令发送者显示私密面板。管理员可以在面板中选择文字频道，再点击“添加选中频道”“移除选中频道”或“刷新当前配置”。最多同时配置 3 个审计频道；相同的审计日志会发送到全部已配置频道。

当前记录内容包括成员身份组新增和移除、昵称修改前与修改后及操作者、消息编辑前文字与编辑后文字、消息发送者、频道、发送时间和编辑时间，以及消息删除前文字、发送者、删除者、频道、发送时间和删除时间。删除者通过 Discord 审计日志识别；无法确认时会明确标注。

## Discord 开发者后台设置

为了读取消息编辑与删除事件，请在 Discord Developer Portal 的 Bot 设置中开启以下 **Privileged Gateway Intents**：**Server Members Intent** 和 **Message Content Intent**。

邀请机器人时，至少授予 View Channels、Send Messages、Embed Links、Read Message History 和 View Audit Log 权限。为了让机器人配合 Discord 审计日志识别管理操作，建议同时授予 Manage Messages。

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

审计频道配置会通过机器人在第一个审计频道发送的配置消息恢复；不要删除最新的配置消息。Token 只应设置在本地 `.env` 或 Render 的环境变量中，不能提交到 GitHub。
