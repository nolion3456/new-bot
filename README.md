# Discord 多功能机器人

这是一个使用 Node.js 和 discord.js 构建的 Discord 机器人。

## 基础指令

- `/ping`：检查机器人是否在线并显示延迟。
- `/help`：查看可用指令。
- `/audit-channel`：由拥有“管理服务器”权限的成员打开私密后台管理面板。

## Giveaway 抽奖功能

### 创建与发布

```text
/giveaway create duration:1d winners:1 prize:奖品 channel:#抽奖频道
```

执行后不会立即公开发布，而是先发送只有指令发送者看得到的私密设置面板。管理员可以：

- 选择一个额外身份组；拥有该身份组的成员中奖权重为 2 倍，但其他成员仍然可以参加；
- 不选择身份组，让所有成员以相同权重参加；
- 选择“发布抽奖”或“取消”。

`channel` 参数可以省略；省略时会使用执行 `/giveaway create` 的当前频道。发布后的抽奖使用 🎉 按钮参加，不使用 reactions。抽奖 Embed 会显示奖品、获奖人数、参加人数和 Discord 相对倒计时；到期后自动抽取并在频道公开 @ 获奖者。

### 管理指令

- `/giveaway end message_id:<消息ID>`：提前结束并抽奖。
- `/giveaway reroll message_id:<消息ID>`：对已结束抽奖重新抽取获奖者，优先排除上一轮获奖者。
- `/giveaway list`：列出本服务器进行中的抽奖。
- `/giveaway delete message_id:<消息ID>`：删除抽奖消息和保存的数据。

抽奖数据保存在 `data/giveaways.json`，机器人重启后会读取未结束抽奖并恢复计时器。数据按服务器和抽奖 ID 隔离，支持多个服务器和多个并行抽奖。

## 审计后台

执行 `/audit-channel` 后，面板提供三个下拉菜单：第一个选择要显示的日志类型（可多选），第二个选择后台文字频道，第三个选择添加、移除或刷新操作。最多同时配置 3 个后台审计频道。可选日志类型包括身份组变动、昵称变动、消息编辑、消息删除、成员加入和成员离开；关闭某项后，该项事件不会发送到后台频道。

成员加入和离开日志会显示成员帐号创建时间、成员标识以及加入或离开时间。新增后台日志包括成员被禁言、解除禁言、封禁、解除封禁和踢出，并显示目标成员与执行者；禁言日志还会显示禁言结束时间和禁言时长。消息编辑日志会显示编辑前文字、编辑后文字、发送者、频道、发送时间和编辑时间。消息删除日志会显示发送者、删除者、频道、发送时间和删除时间。

Discord 没有“unkick/解除踢出”这个审计事件：踢出后成员重新加入只能算成员加入，无法可靠判断是否属于“解除踢出”，因此该选项会在面板中说明不可用，不会伪造日志。

## Discord Developer Portal 设置

为了读取成员进出、消息编辑与删除事件，请开启：**Server Members Intent** 和 **Message Content Intent**。

邀请机器人时，至少授予 View Channels、Send Messages、Embed Links、Read Message History、View Audit Log、Moderate Members、Ban Members 和 Kick Members 权限。使用管理指令需要 Discord 的 **Manage Server（管理服务器）** 权限。

## 本地运行

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 DISCORD_TOKEN
npm start
```

## 环境变量

- `DISCORD_TOKEN`：Discord Bot Token，必填。
- `DISCORD_GUILD_ID`：可选。填写后会立即向指定服务器注册指令；不填写则注册为全局指令。
- `PORT`：可选，默认 `3000`。

审计配置与抽奖数据会写入本地 JSON 文件。请确认部署平台的文件系统会保留运行时文件；如果平台使用临时文件系统，重启或重新部署后需要改用持久化磁盘或数据库。
