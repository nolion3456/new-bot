# Discord 多功能机器人（基础版）

这是一个使用 Node.js 和 discord.js 构建、可部署到 Render 的 Discord 机器人基础版本。

## 当前指令

- `/ping`：检查机器人是否在线并显示 WebSocket 延迟。
- `/help`：查看可用指令。

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

Token 只应设置在本地 `.env` 或 Render 的环境变量中，不能提交到 GitHub。
