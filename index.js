require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { logEvent } = require('./db');

const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.User],
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ============================================================
// Internal API — the Next.js /api/verify route calls this AFTER
// it has already run the IP/VPN/alt-account check itself. This
// bot does not make the verification decision, it only carries
// out the role grant once told to, and logs it.
// ============================================================
const app = express();
app.use(express.json());

app.post('/verify/grant-role', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { discordId } = req.body;
  if (!discordId) {
    return res.status(400).json({ error: 'discordId is required' });
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId);
    await member.roles.add(VERIFIED_ROLE_ID, 'Passed website verification');

    await logEvent(client, {
      guildId: GUILD_ID,
      category: 'VERIFICATION',
      targetId: discordId,
      summary: `${member.user.tag} verified`,
      data: { via: 'website' },
    });

    try {
      const verifyChannel = await client.channels.fetch('1485745143599337583');
      if (verifyChannel) {
        await verifyChannel.send(`✅ ${member.user.tag} has been verified.`);
      }
    } catch (chErr) {
      console.error('Failed to post to verification channel:', chErr);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('grant-role failed:', err);
    res.status(500).json({ error: 'failed to grant role' });
  }
});

// A blocked verification attempt (VPN or alt match) — the website
// calls this so it still shows up in the dashboard/log channel even
// though no role changes hands.
app.post('/verify/log-block', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { discordId, reason } = req.body;
  if (!discordId || !reason) {
    return res.status(400).json({ error: 'discordId and reason are required' });
  }

  try {
    await logEvent(client, {
      guildId: GUILD_ID,
      category: 'VERIFICATION',
      targetId: discordId,
      summary: `Blocked verification attempt — ${reason}`,
      data: { reason },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('log-block failed:', err);
    res.status(500).json({ error: 'failed to log block' });
  }
});

// A verification failure the website has already decided on (VPN or IP-hash
// match). The website has already written the Blacklist row itself — this
// route's job is just to remove the user from Discord so they can't keep
// using the server while blacklisted from the site.
app.post('/verify/blacklist', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { discordId, reason } = req.body;
  if (!discordId || !reason) {
    return res.status(400).json({ error: 'discordId and reason are required' });
  }

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordId).catch(() => null);

    if (member) {
      await member.kick(`Blacklisted: ${reason}`).catch((err) => {
        console.error('Failed to kick blacklisted member:', err);
      });
    }

    await logEvent(client, {
      guildId: GUILD_ID,
      category: 'VERIFICATION',
      targetId: discordId,
      summary: `Blacklisted and kicked — ${reason}`,
      data: { reason },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('blacklist failed:', err);
    res.status(500).json({ error: 'failed to blacklist' });
  }
});

app.post('/requests/log-new', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { discordId, kind, target, isBooster } = req.body;
  if (!discordId || !kind || !target) {
    return res.status(400).json({ error: 'discordId, kind, and target are required' });
  }

  try {
    const channelId = process.env.DISCORD_CHANNEL_REQUESTS;
    if (channelId) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        const { EmbedBuilder, Colors } = require('discord.js');
        const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
        const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
        const requester = member ? member.user.tag : discordId;

        const embed = new EmbedBuilder()
          .setDescription(
            `${isBooster ? '⭐ ' : ''}${requester} requested a ${kind === 'CELEBRITY' ? 'celebrity' : 'film/show'} pack: **${target}**`
          )
          .setColor(isBooster ? Colors.Gold : Colors.Blurple)
          .setTimestamp();
        await channel.send({ embeds: [embed] }).catch(() => null);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('log-new request failed:', err);
    res.status(500).json({ error: 'failed to log request' });
  }
});

app.listen(process.env.INTERNAL_API_PORT || 3001, () => {
  console.log(`Internal API listening on port ${process.env.INTERNAL_API_PORT || 3001}`);
});

// ============================================================
// Logging — join/leave, message edit/delete, server updates,
// member updates (roles, nickname, username, avatar)
// ============================================================

client.on('guildMemberAdd', async (member) => {
  await logEvent(client, {
    guildId: member.guild.id,
    category: 'JOIN_LEAVE',
    targetId: member.id,
    summary: `${member.user.tag} joined`,
    data: {
      username: member.user.username,
      accountCreated: member.user.createdAt,
      avatarURL: member.user.displayAvatarURL({ size: 128 }),
      memberCount: member.guild.memberCount,
      isJoin: true,
    },
  });
});

client.on('guildMemberRemove', async (member) => {
  await logEvent(client, {
    guildId: member.guild.id,
    category: 'JOIN_LEAVE',
    targetId: member.id,
    summary: `${member.user.tag} left`,
    data: {
      username: member.user.username,
      accountCreated: member.user.createdAt,
      avatarURL: member.user.displayAvatarURL({ size: 128 }),
      isJoin: false,
    },
  });
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const addedRoles = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const removedRoles = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));

  if (addedRoles.size || removedRoles.size) {
    const parts = [];
    if (addedRoles.size) parts.push(`+${addedRoles.map((r) => r.name).join(', ')}`);
    if (removedRoles.size) parts.push(`-${removedRoles.map((r) => r.name).join(', ')}`);
    await logEvent(client, {
      guildId: newMember.guild.id,
      category: 'MEMBER_UPDATE',
      targetId: newMember.id,
      summary: `${newMember.user.tag} roles changed: ${parts.join(' ')}`,
      data: { added: addedRoles.map((r) => r.id), removed: removedRoles.map((r) => r.id) },
    });
  }

  if (oldMember.nickname !== newMember.nickname) {
    await logEvent(client, {
      guildId: newMember.guild.id,
      category: 'MEMBER_UPDATE',
      targetId: newMember.id,
      summary: `${newMember.user.tag} nickname: "${oldMember.nickname ?? '(none)'}" → "${newMember.nickname ?? '(none)'}"`,
      data: { before: oldMember.nickname, after: newMember.nickname },
    });
  }
});

client.on('userUpdate', async (oldUser, newUser) => {
  if (oldUser.avatar === newUser.avatar && oldUser.username === newUser.username) return;

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild || !guild.members.cache.has(newUser.id)) return;

  const changes = [];
  if (oldUser.username !== newUser.username) changes.push(`username "${oldUser.username}" → "${newUser.username}"`);
  if (oldUser.avatar !== newUser.avatar) changes.push('avatar changed');

  await logEvent(client, {
    guildId: GUILD_ID,
    category: 'MEMBER_UPDATE',
    targetId: newUser.id,
    summary: `${newUser.tag}: ${changes.join(', ')}`,
    data: { before: { username: oldUser.username }, after: { username: newUser.username } },
  });
});

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot) return;
  await logEvent(client, {
    guildId: message.guild.id,
    category: 'MESSAGE_DELETE',
    actorId: message.author?.id,
    targetId: message.author?.id,
    summary: `Message by ${message.author?.tag ?? 'unknown'} deleted in #${message.channel.name}`,
    data: { channelId: message.channel.id, content: message.content?.slice(0, 500) ?? '(uncached content)' },
  });
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;

  await logEvent(client, {
    guildId: newMessage.guild.id,
    category: 'MESSAGE_EDIT',
    actorId: newMessage.author?.id,
    targetId: newMessage.author?.id,
    summary: `Message by ${newMessage.author?.tag ?? 'unknown'} edited in #${newMessage.channel.name}`,
    data: {
      channelId: newMessage.channel.id,
      before: oldMessage.content?.slice(0, 500) ?? '(uncached content)',
      after: newMessage.content?.slice(0, 500),
    },
  });
});

client.on('guildUpdate', async (oldGuild, newGuild) => {
  const changes = [];
  if (oldGuild.name !== newGuild.name) changes.push(`name "${oldGuild.name}" → "${newGuild.name}"`);
  if (oldGuild.icon !== newGuild.icon) changes.push('icon changed');
  if (!changes.length) return;

  await logEvent(client, {
    guildId: newGuild.id,
    category: 'SERVER_UPDATE',
    summary: `Server updated: ${changes.join(', ')}`,
    data: { changes },
  });
});

client.login(process.env.DISCORD_BOT_TOKEN);

// ============================================================
// Verify button — posts in the verification channel, DMs the
// member a link to the website's /verify page when clicked.
// ============================================================
const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId === 'start_verification') {
    const verifyUrl = `${process.env.WEBSITE_URL}/verify`;
    try {
      await interaction.user.send(
        `Click here to verify: ${verifyUrl}\n\nYou'll need to log in with Discord on the site to complete verification.`
      );
      await interaction.reply({ content: 'Check your DMs for the verification link!', ephemeral: true });
    } catch (err) {
      await interaction.reply({
        content: `I couldn't DM you — please enable DMs from server members, or visit ${verifyUrl} directly.`,
        ephemeral: true,
      });
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.content === '!postverify' && message.member?.permissions.has('Administrator')) {
    const button = new ButtonBuilder()
      .setCustomId('start_verification')
      .setLabel('Verify')
      .setStyle(ButtonStyle.Success);
    const row = new ActionRowBuilder().addComponents(button);
    await message.channel.send({
      content: 'Click below to verify your account and gain full access to the server.',
      components: [row],
    });
    await message.delete().catch(() => null);
  }
});
