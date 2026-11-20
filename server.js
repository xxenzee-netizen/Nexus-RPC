const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Pure in-memory per-browser-session store (100% isolated per user/browser)
const userSessions = new Map();
const externalAssetCache = new Map();
let cachedGames = [];

const NEXUS_LOGO_URL = 'https://myimgs.org/storage/images/87001/1000048092.png';
const CRUNCHYROLL_LOGO_URL = 'https://myimgs.org/storage/images/87240/1000048105.png';

// Periodic cleanup of stale sessions & expired challenges
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of userSessions.entries()) {
    if (!entry.info.connected && now - entry.lastSeen > 60 * 60 * 1000) {
      if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
      userSessions.delete(sid);
    }
  }
}, 15 * 60 * 1000);

function getSessionId(req) {
  const headerSid = req.headers['x-nexus-session'];
  if (headerSid && /^[a-zA-Z0-9_-]{12,64}$/.test(headerSid)) {
    return headerSid;
  }
  return crypto.randomBytes(20).toString('hex');
}

function defaultInfo() {
  return {
    connected: false,
    user: null,
    userId: null,
    avatar: null,
    activeGame: null,
    activeDetails: null,
    customStatus: null,
    afkResponder: { enabled: false, message: '' }
  };
}

function getOrCreateSession(sid) {
  if (!userSessions.has(sid)) {
    userSessions.set(sid, {
      sid,
      token: null,
      client: null,
      keepAliveTimer: null,
      reconnecting: false,
      info: defaultInfo(),
      activeRPC: null,
      customStatus: null,
      afkConfig: { enabled: false, message: "I'm away right now, I'll reply soon!" },
      afkCooldowns: new Map(),
      device: 'desktop',
      lastSeen: Date.now()
    });
  }
  const entry = userSessions.get(sid);
  entry.lastSeen = Date.now();
  return entry;
}

function cleanToken(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/^["'\s]+|["'\s]+$/g, '').trim();
}

function sanitizeImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('data:')) return '';
  return trimmed;
}

function parseDiscordEmojiInput(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return null;

  const customMatch = raw.match(/^<(a)?:([a-zA-Z0-9_]{1,32}):(\d{17,20})>$/);
  if (customMatch) {
    return {
      rawEmoji: raw,
      name: customMatch[2],
      id: customMatch[3],
      animated: Boolean(customMatch[1])
    };
  }

  const shorthandMatch = raw.match(/^(a:)?([a-zA-Z0-9_]{1,32}):(\d{17,20})$/);
  if (shorthandMatch) {
    return {
      rawEmoji: raw,
      name: shorthandMatch[2],
      id: shorthandMatch[3],
      animated: Boolean(shorthandMatch[1])
    };
  }

  return {
    rawEmoji: raw.slice(0, 16),
    name: raw.slice(0, 16),
    id: null,
    animated: false
  };
}

function resolveDeviceProperties(device) {
  const d = (device || 'desktop').toLowerCase();
  if (d === 'android') {
    return {
      wsProps: { os: 'Android', browser: 'Discord Android', device: 'Discord Android' },
      platform: 'android'
    };
  }
  if (d === 'ios') {
    return {
      wsProps: { os: 'iOS', browser: 'Discord iOS', device: 'Discord iOS' },
      platform: 'ios'
    };
  }
  if (d === 'browser' || d === 'web') {
    return {
      wsProps: { os: 'Windows', browser: 'Chrome', device: '' },
      platform: 'desktop'
    };
  }
  if (d === 'ps4' || d === 'ps5' || d === 'playstation') {
    return {
      wsProps: { os: 'Windows', browser: 'Discord Client', device: '' },
      platform: d === 'ps4' ? 'ps4' : 'ps5'
    };
  }
  if (d === 'xbox') {
    return {
      wsProps: { os: 'Windows', browser: 'Discord Client', device: '' },
      platform: 'xbox'
    };
  }
  return {
    wsProps: { os: 'Windows', browser: 'Discord Client', device: '' },
    platform: 'desktop'
  };
}

async function resolveExternalImage(client, appId, imageUrl) {
  if (!imageUrl) return '';
  if (imageUrl.startsWith('mp:')) return imageUrl;
  if (!/^https?:\/\//i.test(imageUrl)) return imageUrl;

  if (imageUrl.startsWith('https://media.discordapp.net/')) {
    return imageUrl.replace('https://media.discordapp.net/', 'mp:');
  }
  if (imageUrl.startsWith('https://cdn.discordapp.com/')) {
    return imageUrl.replace('https://cdn.discordapp.com/', 'mp:');
  }

  const cacheKey = `${appId}:${imageUrl}`;
  if (externalAssetCache.has(cacheKey)) {
    return externalAssetCache.get(cacheKey);
  }

  if (typeof RichPresence.getExternal === 'function') {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await RichPresence.getExternal(client, appId, imageUrl);
        if (Array.isArray(res) && res[0]?.external_asset_path) {
          const rawPath = res[0].external_asset_path;
          const normalized = rawPath.startsWith('mp:') ? rawPath : `mp:${rawPath}`;
          externalAssetCache.set(cacheKey, normalized);
          return normalized;
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 350 * attempt));
      }
    }
  }

  return '';
}

async function buildRichPresence(client, payload, fallbackDevice) {
  const resolvedAppId = (payload.appId && String(payload.appId).trim()) || '1189283746519283746';
  const { platform } = resolveDeviceProperties(payload.device || fallbackDevice);

  const rpc = new RichPresence(client)
    .setApplicationId(resolvedAppId)
    .setType(payload.activityType || 'PLAYING')
    .setName(payload.name.trim());

  if (typeof rpc.setPlatform === 'function' && (platform === 'ps4' || platform === 'ps5' || platform === 'xbox')) {
    try { rpc.setPlatform(platform); } catch (e) {}
  }

  if (payload.details && payload.details.trim()) {
    rpc.setDetails(payload.details.trim().slice(0, 128));
  }
  if (payload.state && payload.state.trim()) {
    rpc.setState(payload.state.trim().slice(0, 128));
  }

  const pSize = parseInt(payload.partySize, 10);
  const pMax = parseInt(payload.partyMax, 10);
  const cleanPartyId = (payload.partyId && String(payload.partyId).trim())
    ? String(payload.partyId).trim().slice(0, 128)
    : '';
  const cleanPartySecret = (payload.partySecret && String(payload.partySecret).trim())
    ? String(payload.partySecret).trim().slice(0, 128)
    : '';

  const hasValidPartySize = !isNaN(pSize) && !isNaN(pMax) && pSize > 0 && pMax >= pSize;
  if (hasValidPartySize || cleanPartyId) {
    const partyObj = {};
    if (hasValidPartySize) {
      partyObj.max = pMax;
      partyObj.current = pSize;
    }
    if (cleanPartyId) {
      partyObj.id = cleanPartyId;
    }
    try {
      rpc.setParty(partyObj);
    } catch (e) {}
  }

  if (cleanPartySecret) {
    if (typeof rpc.setSecrets === 'function') {
      try {
        rpc.setSecrets({ join: cleanPartySecret });
      } catch (e) {}
    } else {
      rpc.secrets = { ...(rpc.secrets || {}), join: cleanPartySecret };
    }
  }

  const now = Date.now();
  if (payload.timestampMode && payload.timestampMode !== 'none') {
    const startSec = parseFloat(payload.startAtSeconds);
    const durSec = parseFloat(payload.durationSeconds);

    let startAnchor = null;
    if (typeof payload.rpcStartedAt === 'number' && payload.rpcStartedAt > 0) {
      startAnchor = payload.rpcStartedAt;
    } else if (!isNaN(startSec) && startSec >= 0) {
      startAnchor = now - Math.round(startSec * 1000);
    } else if (payload.timestampMode === 'elapsed_1h') {
      startAnchor = now - 3600000;
    } else if (payload.timestampMode === 'custom' && payload.customStartMins !== '' && !isNaN(payload.customStartMins)) {
      startAnchor = now - Math.round(parseFloat(payload.customStartMins) * 60 * 1000);
    } else {
      startAnchor = now;
    }

    payload.rpcStartedAt = startAnchor;
    rpc.setStartTimestamp(startAnchor);

    if (!isNaN(durSec) && durSec > 0) {
      const endAnchor = startAnchor + Math.round(durSec * 1000);
      payload.rpcEndsAt = endAnchor;
      rpc.setEndTimestamp(endAnchor);
    } else if (payload.timestampMode === 'custom' && payload.customEndMins !== '' && !isNaN(payload.customEndMins)) {
      const endAnchor = now + Math.round(parseFloat(payload.customEndMins) * 60 * 1000);
      payload.rpcEndsAt = endAnchor;
      rpc.setEndTimestamp(endAnchor);
    }
  }

  const rawLarge = sanitizeImageUrl(payload.largeImage);
  const rawSmall = sanitizeImageUrl(payload.smallImage);

  const [resolvedLarge, resolvedSmall] = await Promise.all([
    rawLarge ? resolveExternalImage(client, resolvedAppId, rawLarge) : Promise.resolve(''),
    rawSmall ? resolveExternalImage(client, resolvedAppId, rawSmall) : Promise.resolve('')
  ]);

  if (resolvedLarge) {
    rpc.setAssetsLargeImage(resolvedLarge);
    if (payload.largeText && payload.largeText.trim()) {
      rpc.setAssetsLargeText(payload.largeText.trim().slice(0, 128));
    }
  }

  if (resolvedSmall) {
    rpc.setAssetsSmallImage(resolvedSmall);
    if (payload.smallText && payload.smallText.trim()) {
      rpc.setAssetsSmallText(payload.smallText.trim().slice(0, 128));
    }
  }

  if (Array.isArray(payload.buttons)) {
    const validButtons = [];
    payload.buttons.slice(0, 2).forEach(btn => {
      if (btn && btn.label && btn.label.trim() && btn.url && btn.url.trim()) {
        let validUrl = btn.url.trim();
        if (!/^https?:\/\//i.test(validUrl)) validUrl = 'https://' + validUrl;
        try {
          new URL(validUrl);
          const cleanLabel = btn.label.trim().slice(0, 32);
          rpc.addButton(cleanLabel, validUrl);
          validButtons.push({ label: cleanLabel, url: validUrl });
        } catch (e) {}
      }
    });

    if (validButtons.length > 0 && Array.isArray(rpc.buttons)) {
      rpc.buttons = validButtons.map(b => b.label);
      rpc.metadata = { button_urls: validButtons.map(b => b.url) };
    }
  }

  return rpc;
}

async function syncFullDiscordPresence(entry) {
  if (!entry.client || !entry.info.connected) return;

  const statusVal = (entry.activeRPC && entry.activeRPC.statusType)
    || (entry.customStatus && entry.customStatus.statusType)
    || 'online';

  try {
    entry.client.user.setStatus(statusVal);
  } catch (e) {}

  const activities = [];

  if (entry.customStatus && (entry.customStatus.text || entry.customStatus.emoji)) {
    const customAct = {
      name: 'Custom Status',
      type: 4,
      state: (entry.customStatus.text || '').trim().slice(0, 128) || undefined
    };
    if (entry.customStatus.emojiId) {
      customAct.emoji = {
        id: entry.customStatus.emojiId,
        name: entry.customStatus.emoji || 'emoji',
        animated: Boolean(entry.customStatus.emojiAnimated)
      };
    } else if (entry.customStatus.emoji && entry.customStatus.emoji.trim()) {
      customAct.emoji = { name: entry.customStatus.emoji.trim() };
    }
    activities.push(customAct);
    entry.info.customStatus = entry.customStatus;
  } else {
    entry.info.customStatus = null;
  }

  const primaryAct = (entry.activeRPC && entry.activeRPC.name && entry.activeRPC.name.trim()) ? entry.activeRPC : null;
  const secondaryAct = (entry.secondaryRPC && entry.secondaryRPC.name && entry.secondaryRPC.name.trim()) ? entry.secondaryRPC : null;

  if (primaryAct) {
    try {
      const rpcPrimary = await buildRichPresence(entry.client, primaryAct, entry.device);
      activities.push(rpcPrimary);
    } catch (e) {}
  }

  if (secondaryAct) {
    try {
      const rpcSecondary = await buildRichPresence(entry.client, secondaryAct, entry.device);
      activities.push(rpcSecondary);
    } catch (e) {}
  }

  const displayMain = primaryAct || secondaryAct;
  if (displayMain) {
    entry.info.activeGame = displayMain.name.trim();
    entry.info.activeDetails = displayMain.details ? displayMain.details.trim() : null;
  } else {
    entry.info.activeGame = null;
    entry.info.activeDetails = null;
  }

  try {
    entry.client.user.setPresence({
      status: statusVal,
      activities
    });
  } catch (e) {
    if (activities.length > 0) {
      try {
        entry.client.user.setActivity(activities[activities.length - 1]);
      } catch (_err) {}
    } else {
      try {
        entry.client.user.setActivity(null);
      } catch (_err) {}
    }
  }
}

function attachAnchoredTimestamp(payload, existingPayload = null) {
  if (!payload || !payload.name || !payload.name.trim()) return null;
  const mode = payload.timestampMode || 'none';
  if (mode === 'none') {
    return { ...payload, rpcStartedAt: null };
  }

  const sameActivity = existingPayload
    && existingPayload.name === payload.name
    && (existingPayload.appId || '') === (payload.appId || '')
    && (existingPayload.timestampMode || 'none') === mode
    && (existingPayload.customStartMins || '') === (payload.customStartMins || '');

  let rpcStartedAt = null;
  if (typeof payload.rpcStartedAt === 'number' && payload.rpcStartedAt > 0) {
    rpcStartedAt = payload.rpcStartedAt;
  } else if (sameActivity && typeof existingPayload.rpcStartedAt === 'number' && existingPayload.rpcStartedAt > 0) {
    rpcStartedAt = existingPayload.rpcStartedAt;
  } else if (mode === 'elapsed_1h') {
    rpcStartedAt = Date.now() - 3600000;
  } else if (mode === 'custom' && payload.customStartMins !== '' && !isNaN(payload.customStartMins)) {
    rpcStartedAt = Date.now() - (parseFloat(payload.customStartMins) * 60 * 1000);
  } else {
    rpcStartedAt = Date.now();
  }

  return { ...payload, rpcStartedAt };
}

async function triggerAutoRecovery(entry) {
  if (!entry || entry.explicitStop || !entry.token || entry.reconnecting) return;
  entry.reconnecting = true;
  try {
    if (entry.activeRPC && !entry.activeRPC.rpcStartedAt && entry.activeRPC.timestampMode && entry.activeRPC.timestampMode !== 'none') {
      entry.activeRPC = attachAnchoredTimestamp(entry.activeRPC);
    }
    await loginSessionWithToken(entry, entry.token, 1, entry.device);
  } catch (e) {
    setTimeout(() => {
      entry.reconnecting = false;
    }, 3000);
    return;
  }
  entry.reconnecting = false;
}

function start247KeepAlive(entry) {
  if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
  // Low-load every-20s health check: only acts if connection dropped or RPC activity vanished unexpectedly
  entry.keepAliveTimer = setInterval(async () => {
    if (!entry.token || entry.explicitStop) return;
    entry.lastSeen = Date.now();

    const isSocketAlive = Boolean(
      entry.client
      && entry.client.user
      && entry.client.ws
      && entry.client.ws.status === 0
      && entry.info.connected
    );

    if (!isSocketAlive) {
      entry.info.connected = false;
      await triggerAutoRecovery(entry);
      return;
    }

    if (entry.activeRPC && entry.activeRPC.name) {
      try {
        const currentActivities = entry.client.user.presence?.activities || [];
        const hasRpc = currentActivities.some(a => a && a.type !== 4 && a.name === entry.activeRPC.name.trim());
        if (!hasRpc) {
          await syncFullDiscordPresence(entry);
        }
      } catch (e) {}
    }
  }, 20000);
}

async function loginSessionWithToken(entry, rawToken, attempt = 1, deviceOverride = null) {
  const token = cleanToken(rawToken);
  if (!token) throw new Error('Please paste your Discord token first.');

  if (entry.client) {
    try {
      entry.client.removeAllListeners();
      entry.client.destroy();
    } catch (e) {}
    entry.client = null;
    await new Promise(r => setTimeout(r, 150));
  }

  const activeDevice = deviceOverride || entry.device || 'desktop';
  const { wsProps } = resolveDeviceProperties(activeDevice);

  return new Promise((resolve, reject) => {
    const client = new Client({
      checkUpdate: false,
      intents: ['GUILDS', 'DIRECT_MESSAGES'],
      ws: {
        properties: wsProps
      }
    });

    const timeout = setTimeout(() => {
      try { client.destroy(); } catch (e) {}
      reject(new Error('Connection took too long. Click Connect again.'));
    }, 15000);

    client.once('ready', async () => {
      clearTimeout(timeout);
      entry.token = token;
      entry.client = client;
      entry.device = activeDevice;

      entry.info = {
        connected: true,
        user: client.user.tag,
        userId: client.user.id,
        avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
        activeGame: null,
        activeDetails: null,
        customStatus: entry.customStatus,
        afkResponder: { ...entry.afkConfig }
      };

      await syncFullDiscordPresence(entry);
      start247KeepAlive(entry);
      resolve(entry.info);
    });

    client.on('messageCreate', async (msg) => {
      try {
        if (!entry.afkConfig?.enabled) return;
        if (!msg.author || msg.author.id === client.user?.id || msg.author.bot) return;
        if (msg.channel?.type !== 'DM') return;

        const now = Date.now();
        const lastReply = entry.afkCooldowns.get(msg.author.id) || 0;
        if (now - lastReply < 5 * 60 * 1000) return;

        entry.afkCooldowns.set(msg.author.id, now);
        const replyText = (entry.afkConfig.message || "I'm away right now, I'll reply soon!").trim();
        if (replyText) {
          await msg.channel.send(replyText);
        }
      } catch (e) {}
    });

    client.on('presenceUpdate', async (_oldP, newP) => {
      try {
        if (!entry.token || entry.explicitStop || !entry.activeRPC || !entry.activeRPC.name) return;
        if (!newP || newP.userId !== client.user?.id) return;
        const acts = newP.activities || [];
        const stillPresent = acts.some(a => a && a.type !== 4 && a.name === entry.activeRPC.name.trim());
        if (!stillPresent && entry.info.connected) {
          await syncFullDiscordPresence(entry);
        }
      } catch (e) {}
    });

    client.on('shardDisconnect', () => {
      entry.info.connected = false;
      if (!entry.explicitStop && entry.token) {
        setTimeout(() => triggerAutoRecovery(entry), 1200);
      }
    });

    client.on('disconnect', () => {
      entry.info.connected = false;
      if (!entry.explicitStop && entry.token) {
        setTimeout(() => triggerAutoRecovery(entry), 1200);
      }
    });

    client.on('error', () => {});

    client.login(token).catch(async () => {
      clearTimeout(timeout);
      try { client.destroy(); } catch (e) {}

      if (attempt < 3) {
        try {
          await new Promise(r => setTimeout(r, 350));
          const retryRes = await loginSessionWithToken(entry, token, attempt + 1, activeDevice);
          return resolve(retryRes);
        } catch (retryErr) {
          if (attempt === 2) {
            return reject(new Error('Could not connect with that token. Check it and try again.'));
          }
        }
      }
      reject(new Error('Could not connect with that token. Check it and try again.'));
    });
  });
}

async function loadGamesCache() {
  try {
    const response = await fetch('https://discord.com/api/v9/games/detectable');
    const data = await response.json();
    cachedGames = data
      .filter(g => g.id && g.name)
      .map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon_hash
          ? `https://cdn.discordapp.com/app-icons/${g.id}/${g.icon_hash}.png?size=128`
          : ''
      }));
  } catch (err) {}
}
loadGamesCache();

async function searchAnimeEverywhere(searchTerm) {
  const query = (searchTerm || '').trim();

  try {
    const randomPage = Math.floor(Math.random() * 12) + 1;
    const gqlQuery = query
      ? `query ($search: String) { Page(page: 1, perPage: 20) { media(search: $search, type: ANIME, sort: POPULARITY_DESC) { title { romaji english } episodes coverImage { extraLarge large } } } }`
      : `query ($page: Int) { Page(page: $page, perPage: 20) { media(type: ANIME, sort: TRENDING_DESC) { title { romaji english } episodes coverImage { extraLarge large } } } }`;
    const aniResp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        query: gqlQuery,
        variables: query ? { search: query } : { page: randomPage }
      })
    });
    if (aniResp.ok) {
      const aniData = await aniResp.json();
      const mediaList = aniData?.data?.Page?.media || [];
      if (mediaList.length > 0) {
        return mediaList.map(m => ({
          title: m.title.english || m.title.romaji,
          episodes: m.episodes || 24,
          subtitle: m.episodes ? `Episode 1 of ${m.episodes} • Crunchyroll` : 'Episode 1 • Crunchyroll',
          album: m.title.romaji || m.title.english,
          icon: m.coverImage?.extraLarge || m.coverImage?.large || CRUNCHYROLL_LOGO_URL
        }));
      }
    }
  } catch (e) {}

  try {
    const url = query
      ? `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=20`
      : `https://api.jikan.moe/v4/top/anime?page=${Math.floor(Math.random() * 8) + 1}&limit=20`;
    const jikanResp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 NexusRPC/3.0' } });
    if (jikanResp.ok) {
      const jikanData = await jikanResp.json();
      if (Array.isArray(jikanData.data) && jikanData.data.length > 0) {
        return jikanData.data.map(anime => ({
          title: anime.title_english || anime.title,
          episodes: anime.episodes || 24,
          subtitle: anime.episodes ? `Episode 1 of ${anime.episodes} • Crunchyroll` : 'Episode 1 • Crunchyroll',
          album: anime.title,
          icon: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || CRUNCHYROLL_LOGO_URL
        }));
      }
    }
  } catch (e) {}

  return [];
}

const RANDOM_MUSIC_SEEDS = ['pop', 'rock', 'lofi', 'synthwave', 'hip hop', 'electronic', 'indie', 'jazz', 'chill', 'night'];
const RANDOM_SHOW_SEEDS = ['star', 'night', 'dark', 'love', 'world', 'city', 'fire', 'shadow', 'king', 'time', 'game', 'war'];

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

app.get('/favicon.ico', (req, res) => {
  res.redirect(302, NEXUS_LOGO_URL);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

/* --- EXTRA TAB ENDPOINTS (Per-Session Isolated) --- */
app.post('/api/extra/custom-status', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const { text, emoji, statusType, clear } = req.body || {};
  if (clear) {
    entry.customStatus = null;
  } else {
    const parsedEmoji = parseDiscordEmojiInput(emoji);
    entry.customStatus = {
      text: String(text || '').trim().slice(0, 128),
      rawEmoji: parsedEmoji ? parsedEmoji.rawEmoji : '',
      emoji: parsedEmoji ? parsedEmoji.name : '',
      emojiId: parsedEmoji ? parsedEmoji.id : null,
      emojiAnimated: parsedEmoji ? parsedEmoji.animated : false,
      statusType: statusType || (entry.activeRPC && entry.activeRPC.statusType) || 'online'
    };
  }

  await syncFullDiscordPresence(entry);
  return res.json({ success: true, session: entry.info });
});

app.post('/api/extra/afk', (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const { enabled, message } = req.body || {};
  entry.afkConfig = {
    enabled: Boolean(enabled),
    message: String(message || "I'm away right now, I'll reply soon!").trim().slice(0, 400)
  };
  entry.afkCooldowns.clear();
  entry.info.afkResponder = { ...entry.afkConfig };

  return res.json({ success: true, session: entry.info });
});

app.post('/api/extra/hypesquad', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.token) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const houseMap = { bravery: 1, brilliance: 2, balance: 3 };
  const houseKey = String(req.body?.house || '').toLowerCase();

  try {
    if (houseKey === 'none') {
      const resp = await fetch('https://discord.com/api/v9/hypesquad/online', {
        method: 'DELETE',
        headers: { Authorization: entry.token }
      });
      if (!resp.ok && resp.status !== 204) {
        return res.status(400).json({ error: 'Could not update HypeSquad badge.' });
      }
      return res.json({ success: true, house: 'none' });
    }

    const houseId = houseMap[houseKey];
    if (!houseId) {
      return res.status(400).json({ error: 'Select a valid HypeSquad house.' });
    }

    const resp = await fetch('https://discord.com/api/v9/hypesquad/online', {
      method: 'POST',
      headers: {
        Authorization: entry.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ house_id: houseId })
    });

    if (!resp.ok && resp.status !== 204) {
      return res.status(400).json({ error: 'Discord rejected the HypeSquad change.' });
    }

    return res.json({ success: true, house: houseKey });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update HypeSquad house.' });
  }
});

app.get('/api/media-search', async (req, res) => {
  const platform = (req.query.platform || 'spotify').toLowerCase();
  const query = (req.query.q || '').trim();

  try {
    if (platform === 'spotify' || platform === 'youtube') {
      const effectiveQuery = query || RANDOM_MUSIC_SEEDS[Math.floor(Math.random() * RANDOM_MUSIC_SEEDS.length)];
      const resp = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(effectiveQuery)}&media=music&limit=24`);
      const data = await resp.json();
      let results = (data.results || []).map(item => ({
        title: item.trackName || item.collectionName,
        subtitle: platform === 'youtube' ? `YouTube • ${item.artistName}` : `by ${item.artistName}`,
        album: item.collectionName || item.trackName,
        icon: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb')
      }));
      if (!query) results = shuffleArray(results).slice(0, 18);
      return res.json({ results });
    }

    if (platform === 'netflix') {
      let rawShows = [];
      if (query) {
        const resp = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
        const data = await resp.json();
        rawShows = (data || []).map(entry => entry.show).filter(Boolean);
      } else {
        const randomPage = Math.floor(Math.random() * 15);
        const resp = await fetch(`https://api.tvmaze.com/shows?page=${randomPage}`);
        if (resp.ok) {
          const pageData = await resp.json();
          rawShows = shuffleArray(pageData || []).slice(0, 20);
        }
        if (rawShows.length === 0) {
          const fallbackSeed = RANDOM_SHOW_SEEDS[Math.floor(Math.random() * RANDOM_SHOW_SEEDS.length)];
          const fbResp = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(fallbackSeed)}`);
          const fbData = await fbResp.json();
          rawShows = (fbData || []).map(entry => entry.show).filter(Boolean);
        }
      }

      const results = rawShows.slice(0, 20).map(s => ({
        title: s.name,
        subtitle: s.genres && s.genres.length ? s.genres.join(' • ') : 'Netflix Series',
        album: s.name,
        icon: s.image ? (s.image.original || s.image.medium) : ''
      }));
      return res.json({ results });
    }

    if (platform === 'crunchyroll') {
      let results = await searchAnimeEverywhere(query);
      if (!query) results = shuffleArray(results);
      return res.json({ results });
    }

    return res.json({ results: [] });
  } catch (err) {
    return res.json({ results: [] });
  }
});

app.get('/api/youtube-info', async (req, res) => {
  const rawUrl = (req.query.url || '').trim();
  if (!rawUrl) return res.status(400).json({ error: 'Paste a YouTube video link first.' });

  let videoId = null;
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    if (u.hostname.includes('youtu.be')) {
      videoId = u.pathname.replace('/', '').split('/')[0];
    } else if (u.searchParams.get('v')) {
      videoId = u.searchParams.get('v');
    } else if (u.pathname.includes('/shorts/')) {
      videoId = u.pathname.split('/shorts/')[1]?.split('/')[0];
    } else if (u.pathname.includes('/live/')) {
      videoId = u.pathname.split('/live/')[1]?.split('/')[0];
    }
  } catch (e) {}

  if (!videoId) {
    return res.status(400).json({ error: 'That does not look like a valid YouTube link.' });
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const fallbackThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const oembedResp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`);
    if (oembedResp.ok) {
      const data = await oembedResp.json();
      return res.json({
        videoId,
        url: canonicalUrl,
        title: data.title || 'YouTube Video',
        author: data.author_name || 'YouTube Creator',
        thumbnail: data.thumbnail_url || fallbackThumb
      });
    }
  } catch (e) {}

  try {
    const noembedResp = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(canonicalUrl)}`);
    if (noembedResp.ok) {
      const data = await noembedResp.json();
      return res.json({
        videoId,
        url: canonicalUrl,
        title: data.title || 'YouTube Video',
        author: data.author_name || 'YouTube Creator',
        thumbnail: data.thumbnail_url || fallbackThumb
      });
    }
  } catch (e) {}

  return res.json({
    videoId,
    url: canonicalUrl,
    title: 'Watching YouTube Video',
    author: 'YouTube',
    thumbnail: fallbackThumb
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/games', async (req, res) => {
  if (cachedGames.length === 0) await loadGamesCache();
  const q = (req.query.q || '').toLowerCase().trim();
  const page = parseInt(req.query.page) || 1;
  const limit = 36;

  let filtered = cachedGames;
  if (q) {
    filtered = cachedGames.filter(g => g.name.toLowerCase().includes(q));
  }

  const start = (page - 1) * limit;
  res.json({
    games: filtered.slice(start, start + limit),
    hasMore: start + limit < filtered.length
  });
});

app.get('/status', async (req, res) => {
  try {
    const sid = getSessionId(req);
    const entry = getOrCreateSession(sid);

    if (entry.token && !entry.explicitStop && !entry.info.connected && !entry.reconnecting) {
      triggerAutoRecovery(entry);
    }

    res.json({
      sessionId: sid,
      session: entry.info,
      activeRPC: entry.activeRPC,
      secondaryRPC: entry.secondaryRPC || null
    });
  } catch (err) {
    res.status(200).json({ session: defaultInfo(), activeRPC: null, secondaryRPC: null });
  }
});

app.post('/connect-token', async (req, res) => {
  try {
    const sid = getSessionId(req);
    const entry = getOrCreateSession(sid);
    const token = cleanToken(req.body?.token);
    const incomingRpc = req.body?.activeRPC;
    const incomingSecondary = req.body?.secondaryRPC;

    if (!token) {
      return res.status(400).json({ error: 'Please paste your Discord token first.' });
    }

    entry.explicitStop = false;
    if (incomingRpc && incomingRpc.name && !entry.activeRPC) {
      entry.activeRPC = attachAnchoredTimestamp(incomingRpc, entry.activeRPC);
    } else if (entry.activeRPC && entry.activeRPC.name) {
      entry.activeRPC = attachAnchoredTimestamp(entry.activeRPC, entry.activeRPC);
    }

    if (incomingSecondary && incomingSecondary.name && !entry.secondaryRPC) {
      entry.secondaryRPC = attachAnchoredTimestamp(incomingSecondary, entry.secondaryRPC);
    } else if (entry.secondaryRPC && entry.secondaryRPC.name) {
      entry.secondaryRPC = attachAnchoredTimestamp(entry.secondaryRPC, entry.secondaryRPC);
    }

    const info = await loginSessionWithToken(entry, token);
    res.json({
      success: true,
      sessionId: sid,
      session: info,
      activeRPC: entry.activeRPC,
      secondaryRPC: entry.secondaryRPC || null
    });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Could not connect with that token.' });
  }
});

app.post('/disconnect', (req, res) => {
  try {
    const sid = getSessionId(req);
    const entry = getOrCreateSession(sid);

    entry.explicitStop = true;
    if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
    if (entry.client) {
      try {
        entry.client.removeAllListeners();
        entry.client.destroy();
      } catch (e) {}
      entry.client = null;
    }

    entry.token = null;
    entry.activeRPC = null;
    entry.secondaryRPC = null;
    entry.info = defaultInfo();
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true });
  }
});

app.post('/set-rpc', async (req, res) => {
  try {
    const sid = getSessionId(req);
    const entry = getOrCreateSession(sid);

    if (!entry.info.connected || !entry.client) {
      return res.status(400).json({ error: 'Connect your account first.' });
    }

    const rawPayload = req.body || {};
    if (!rawPayload.name || !rawPayload.name.trim()) {
      return res.status(400).json({ error: 'Give your activity a name first.' });
    }

    entry.explicitStop = false;
    const prevDevice = entry.device || 'desktop';
    const nextDevice = rawPayload.device || prevDevice;
    entry.device = nextDevice;

    const slot = rawPayload.activitySlot === 'secondary' ? 'secondary' : 'primary';
    if (slot === 'secondary') {
      entry.secondaryRPC = attachAnchoredTimestamp(rawPayload, entry.secondaryRPC);
    } else {
      if (rawPayload.keepCompanion && entry.secondaryRPC && rawPayload.activityType === 'PLAYING') {
        // Keep secondary media/streaming RPC active alongside primary game RPC
      }
      entry.activeRPC = attachAnchoredTimestamp(rawPayload, entry.activeRPC);
    }

    if (nextDevice !== prevDevice && entry.token) {
      await loginSessionWithToken(entry, entry.token, 1, nextDevice);
    } else {
      await syncFullDiscordPresence(entry);
    }

    return res.json({
      success: true,
      session: entry.info,
      activeRPC: entry.activeRPC,
      secondaryRPC: entry.secondaryRPC || null
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not update your status. Try again.' });
  }
});

app.post('/clear-rpc', async (req, res) => {
  try {
    const sid = getSessionId(req);
    const entry = getOrCreateSession(sid);
    const slot = req.body && req.body.activitySlot;

    if (slot === 'secondary') {
      entry.secondaryRPC = null;
    } else {
      entry.explicitStop = true;
      entry.activeRPC = null;
      entry.secondaryRPC = null;
      entry.info.activeGame = null;
      entry.info.activeDetails = null;
    }

    if (entry.info.connected && entry.client) {
      await syncFullDiscordPresence(entry);
    }

    res.json({
      success: true,
      session: entry.info,
      activeRPC: entry.activeRPC,
      secondaryRPC: entry.secondaryRPC || null
    });
  } catch (err) {
    res.json({ success: true, session: entry.info });
  }
});

process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running 24/7 on port ${PORT}`));
