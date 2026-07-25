const { Pool } = require('pg');
const { EmbedBuilder, Colors } = require('discord.js');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Each LogCategory maps to its own channel env var, emoji, and color.
// These must already exist on the Prisma LogCategory enum:
// JOIN_LEAVE, VERIFICATION, MESSAGE_DELETE, MESSAGE_EDIT, SERVER_UPDATE, MEMBER_UPDATE
const CATEGORY_CONFIG = {
  JOIN_LEAVE: { emoji: '✦', color: Colors.Blue, channelEnv: 'DISCORD_CHANNEL_JOIN_LEAVE' },
  VERIFICATION: { emoji: '✦', color: Colors.Green, channelEnv: 'DISCORD_CHANNEL_VERIFICATION' },
  MESSAGE_DELETE: { emoji: '✦', color: Colors.Red, channelEnv: 'DISCORD_CHANNEL_MESSAGE_LOGS' },
  MESSAGE_EDIT: { emoji: '✦', color: Colors.Yellow, channelEnv: 'DISCORD_CHANNEL_MESSAGE_LOGS' },
  SERVER_UPDATE: { emoji: '✦', color: Colors.Purple, channelEnv: 'DISCORD_CHANNEL_SERVER_UPDATES' },
  MEMBER_UPDATE: { emoji: '✦', color: Colors.Grey, channelEnv: 'DISCORD_CHANNEL_MEMBER_UPDATES' },
};

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function timeAgo(date) {
  const then = new Date(date);
  const now = new Date();
  let months =
    (now.getFullYear() - then.getFullYear()) * 12 + (now.getMonth() - then.getMonth());
  const years = Math.floor(months / 12);
  months = months % 12;

  const dayDiff = new Date(now);
  dayDiff.setFullYear(then.getFullYear() + years);
  dayDiff.setMonth(then.getMonth() + months);
  let days = Math.floor((now - dayDiff) / (1000 * 60 * 60 * 24));
  if (days < 0) {
    months -= 1;
    if (months < 0) {
      months += 12;
    }
    days = Math.floor((now - then) / (1000 * 60 * 60 * 24)) % 30;
  }

  const parts = [];
  if (years > 0) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  if (months > 0) parts.push(`${months} month${months === 1 ? '' : 's'}`);
  if (days > 0 || parts.length === 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);

  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function buildJoinLeaveEmbed({ targetId, data }) {
  const isJoin = !!data?.isJoin;
  const lines = [`✦ **Member ${isJoin ? 'Joined' : 'Left'}**`, '', `<@${targetId}>`];

  if (isJoin && data?.memberCount) {
    lines.push(`${ordinal(data.memberCount)} to join`);
  }
  if (data?.accountCreated) {
    lines.push(`created ${timeAgo(data.accountCreated)} ago`);
  }

  return new EmbedBuilder()
    .setColor(isJoin ? Colors.Green : Colors.Red)
    .setDescription(lines.join('\n'))
    .setThumbnail(data?.avatarURL || null)
    .setFooter({ text: `ID: ${targetId}` })
    .setTimestamp();
}

/**
 * Writes a row to the LogEntry table the Next.js dashboard reads from,
 * and posts an embed to that category's channel.
 */
async function logEvent(client, { guildId, category, actorId, targetId, summary, data }) {
  await pool.query(
    `INSERT INTO "LogEntry" (id, "guildId", category, "actorId", "targetId", summary, data, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      crypto.randomUUID(),
      String(guildId),
      category,
      actorId ? String(actorId) : null,
      targetId ? String(targetId) : null,
      summary,
      data,
    ]
  );

  const config = CATEGORY_CONFIG[category];
  const channelId = config && process.env[config.channelEnv];
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const embed =
    category === 'JOIN_LEAVE'
      ? buildJoinLeaveEmbed({ targetId, data })
      : new EmbedBuilder().setDescription(`${config.emoji} ${summary}`).setColor(config.color).setTimestamp();

  await channel.send({ embeds: [embed] }).catch(() => null);
}

module.exports = { pool, logEvent, CATEGORY_CONFIG };
