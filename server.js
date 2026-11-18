const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Client, RichPresence, CustomStatus } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Pure in-memory per-browser-session store (zero shared disk data)
const userSessions = new Map();
const externalAssetCache = new Map();
let cachedGames = [];

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
    avatar: null,
    activeGame: null,
    activeDetails: null
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
      profileStatus: {
        status: 'online',
        text: '',
        emoji: '',
        device: 'desktop',
        expiresAt: null
      },
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

// Reliable GIF & Image External Asset Resolver with Retry + Cache
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

function buildCustomStatusActivity(client, profileStatus) {
  if (!profileStatus) return null;
  const text = (profileStatus.text || '').trim();
  const emoji = (profileStatus.emoji || '').trim();
  if (!text && !emoji) return null;

  const custom = new CustomStatus(client);
  if (text) custom.setState(text.slice(0, 128));
  if (emoji) {
    const customMatch = emoji.match(/^<(a?):([a-zA-Z0-9_]+):(\d+)>$/);
    if (customMatch) {
      custom.setEmoji(customMatch[2], customMatch[3], Boolean(customMatch[1]));
    } else {
      custom.setEmoji(emoji);
    }
  }
  return custom;
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
  if (!isNaN(pSize) && !isNaN(pMax) && pSize > 0 && pMax >= pSize) {
    rpc.setParty({ max: pMax, current: pSize });
  }

  const now = Date.now();
  if (payload.timestampMode === 'now') {
    rpc.setStartTimestamp(now);
  } else if (payload.timestampMode === 'elapsed_1h') {
    rpc.setStartTimestamp(now - 3600000);
  } else if (payload.timestampMode === 'custom') {
    if (payload.customStartMins !== '' && !isNaN(payload.customStartMins)) {
      rpc.setStartTimestamp(now - (parseFloat(payload.customStartMins) * 60 * 1000));
    }
    if (payload.customEndMins !== '' && !isNaN(payload.customEndMins)) {
      rpc.setEndTimestamp(now + (parseFloat(payload.customEndMins) * 60 * 1000));
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

  const statusVal = (entry.activeRPC && entry.activeRPC.statusType) || entry.profileStatus?.status || 'online';
  try {
    entry.client.user.setStatus(statusVal);
  } catch (e) {}

  const activities = [];

  if (entry.profileStatus?.expiresAt && Date.now() > entry.profileStatus.expiresAt) {
    entry.profileStatus.text = '';
    entry.profileStatus.emoji = '';
    entry.profileStatus.expiresAt = null;
  }

  const customStatusAct = buildCustomStatusActivity(entry.client, entry.profileStatus);
  if (customStatusAct) {
    activities.push(customStatusAct);
  }

  if (entry.activeRPC && entry.activeRPC.name && entry.activeRPC.name.trim()) {
    const rpc = await buildRichPresence(entry.client, entry.activeRPC, entry.profileStatus?.device);
    activities.push(rpc);
    entry.info.activeGame = entry.activeRPC.name.trim();
    entry.info.activeDetails = entry.activeRPC.details ? entry.activeRPC.details.trim() : null;
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
      entry.client.user.setActivity(activities[activities.length - 1]);
    } else {
      entry.client.user.setActivity(null);
    }
  }
}

function start247KeepAlive(entry) {
  if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
  entry.keepAliveTimer = setInterval(async () => {
    if (!entry.token) return;
    if (!entry.client || !entry.info.connected) {
      if (!entry.reconnecting) {
        entry.reconnecting = true;
        try {
          await loginSessionWithToken(entry, entry.token, 1, entry.profileStatus?.device);
        } catch (e) {}
        entry.reconnecting = false;
      }
      return;
    }
    try {
      await syncFullDiscordPresence(entry);
    } catch (e) {}
  }, 4 * 60 * 1000);
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
    await new Promise(r => setTimeout(r, 200));
  }

  const activeDevice = deviceOverride || entry.profileStatus?.device || 'desktop';
  const { wsProps } = resolveDeviceProperties(activeDevice);

  return new Promise((resolve, reject) => {
    const client = new Client({
      checkUpdate: false,
      intents: ['GUILDS'],
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
      entry.info = {
        connected: true,
        user: client.user.tag,
        avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
        activeGame: null,
        activeDetails: null
      };

      await syncFullDiscordPresence(entry);
      start247KeepAlive(entry);
      resolve(entry.info);
    });

    client.on('disconnect', () => {
      entry.info.connected = false;
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

const CRUNCHYROLL_LOGO_URL = 'https://myimgs.org/storage/images/87240/1000048105.png';

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
    const jikanResp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 NexusRPC/2.4' } });
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

app.get('/status', (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  res.json({
    sessionId: sid,
    session: entry.info,
    activeRPC: entry.activeRPC,
    profileStatus: entry.profileStatus
  });
});

app.post('/connect-token', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);
  const token = cleanToken(req.body?.token);

  if (!token) {
    return res.status(400).json({ error: 'Please paste your Discord token first.' });
  }

  try {
    const info = await loginSessionWithToken(entry, token);
    res.json({
      success: true,
      sessionId: sid,
      session: info,
      activeRPC: entry.activeRPC,
      profileStatus: entry.profileStatus
    });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Could not connect with that token.' });
  }
});

app.post('/disconnect', (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
  if (entry.client) {
    try {
      entry.client.removeAllListeners();
      entry.client.destroy();
    } catch (e) {}
    entry.client = null;
  }

  userSessions.delete(sid);
  res.json({ success: true });
});

app.post('/set-profile-status', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const { status, text, emoji, device, expiresInMins } = req.body || {};
  const prevDevice = entry.profileStatus?.device || 'desktop';
  const nextDevice = device || prevDevice;
  const mins = parseInt(expiresInMins, 10);

  entry.profileStatus = {
    status: status || 'online',
    text: (text || '').trim().slice(0, 128),
    emoji: (emoji || '').trim(),
    device: nextDevice,
    expiresAt: (!isNaN(mins) && mins > 0) ? Date.now() + mins * 60 * 1000 : null
  };

  if (entry.activeRPC) {
    entry.activeRPC.statusType = entry.profileStatus.status;
    entry.activeRPC.device = nextDevice;
  }

  try {
    if (nextDevice !== prevDevice && entry.token) {
      await loginSessionWithToken(entry, entry.token, 1, nextDevice);
    } else {
      await syncFullDiscordPresence(entry);
    }

    res.json({
      success: true,
      session: entry.info,
      profileStatus: entry.profileStatus,
      activeRPC: entry.activeRPC
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not update profile status.' });
  }
});

app.post('/set-rpc', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const payload = req.body;
  if (!payload.name || !payload.name.trim()) {
    return res.status(400).json({ error: 'Give your activity a name first.' });
  }

  try {
    const prevDevice = entry.profileStatus?.device || 'desktop';
    const nextDevice = payload.device || prevDevice;
    if (payload.statusType) entry.profileStatus.status = payload.statusType;
    if (payload.device) entry.profileStatus.device = payload.device;

    entry.activeRPC = payload;

    if (nextDevice !== prevDevice && entry.token) {
      await loginSessionWithToken(entry, entry.token, 1, nextDevice);
    } else {
      await syncFullDiscordPresence(entry);
    }

    return res.json({
      success: true,
      session: entry.info,
      activeRPC: entry.activeRPC,
      profileStatus: entry.profileStatus
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not update your status. Try again.' });
  }
});

app.post('/clear-rpc', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  entry.activeRPC = null;
  entry.info.activeGame = null;
  entry.info.activeDetails = null;

  if (entry.info.connected && entry.client) {
    await syncFullDiscordPresence(entry);
  }

  res.json({
    success: true,
    session: entry.info,
    profileStatus: entry.profileStatus
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running 24/7 on port ${PORT}`));
