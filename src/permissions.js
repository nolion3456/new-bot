const { PermissionFlagsBits } = require('discord.js');

/**
 * 管理员必须拥有“管理服务器”权限，且其最高身份组必须高于机器人。
 * 服务器拥有者始终视为最高权限管理员。
 */
function canManageGuild(interaction) {
  if (!interaction?.inGuild?.() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return false;
  const guild = interaction.guild;
  if (guild.ownerId === interaction.user?.id) return true;
  const member = interaction.member;
  const botMember = guild.members?.me;
  if (!member?.roles?.highest || !botMember?.roles?.highest) return false;
  return member.roles.highest.comparePositionTo(botMember.roles.highest) > 0;
}

module.exports = { canManageGuild };
