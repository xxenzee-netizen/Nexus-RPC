const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

const SESSIONS_DIR = path.join(__dirname, 'nexus_sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Per-user isolated memory store: Map<sessionId, { client, info, state }>
const userSessions = new Map();
let cachedGames = [];

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const key = parts.shift().trim();
    const val = decodeURIComponent(parts.join('='));
    list[key] = val;
  });
  return list;
}

function getSessionId(req, res) {
  const headerSid = req.headers['x-nexus-session'];
  const cookies = parseCookies(req);
  let sid = (headerSid && /^[a-zA-Z0-9_-]{12,64}$/.test(headerSid)) ? headerSid : cookies['nexus_sid'];

  if (!sid || !/^[a-zA-Z0-9_-]{12,64}$/.test(sid)) {
    sid = crypto.randomBytes(20).toString('hex');
  }

  if (res) {
    res.setHeader('Set-Cookie', `nexus_sid=${sid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  return sid;
}

function defaultState() {
  return {
    token: null,
    activeRPC: null,
    customDraft: {
      activityType: 'PLAYING',
      statusType: 'online',
      device: 'desktop',
      name: '',
      details: '',
      state: '',
      partySize: '',
      partyMax: '',
      timestampMode: 'none',
      customStartMins: '',
      customEndMins: '',
      largeImage: '',
      largeText: '',
      smallImage: '',
      smallText: '',
      btn1Label: '',
      btn1Url: '',
      btn2Label: '',
      btn2Url: ''
    }
  };
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

function getSessionFile(sid) {
  return path.join(SESSIONS_DIR, `${sid}.json`);
}

function loadUserSession(sid) {
  if (userSessions.has(sid)) {
    return userSessions.get(sid);
  }
  const entry = {
    sid,
    client: null,
    info: defaultInfo(),
    state: defaultState()
  };
  try {
    const file = getSessionFile(sid);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      entry.state = { ...defaultState(), ...parsed };
      if (entry.state.token) entry.state.token = cleanToken(entry.state.token);
    }
  } catch (e) {}
  userSessions.set(sid, entry);
  return entry;
}

function saveUserSession(entry) {
  try {
    fs.writeFileSync(getSessionFile(entry.sid), JSON.stringify(entry.state, null, 2), 'utf-8');
  } catch (e) {}
}

function cleanToken(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/^["'\s]+|["'\s]+$/g, '').trim();
}

function sanitizeImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:')) return '';
  return trimmed;
}

function resolveDevicePlatform(device) {
  const d = (device || 'desktop').toLowerCase();
  if (d === 'ps5' || d === 'ps4' || d === 'playstation') {
    return { gatewayDevice: 'desktop', platform: d === 'ps4' ? 'ps4' : 'ps5' };
  }
  if (d === 'xbox') {
    return { gatewayDevice: 'desktop', platform: 'xbox' };
  }
  if (d === 'android' || d === 'ios') {
    return { gatewayDevice: d, platform: d };
  }
  if (d === 'browser' || d === 'web') {
    return { gatewayDevice: 'web', platform: 'desktop' };
  }
  return { gatewayDevice: 'desktop', platform: 'desktop' };
}

async function resolveExternalImage(client, appId, imageUrl) {
  if (!imageUrl) return '';
  if (!/^https?:\/\//i.test(imageUrl)) return imageUrl;

  if (typeof RichPresence.getExternal === 'function') {
    try {
      const res = await RichPresence.getExternal(client, appId, imageUrl);
      if (Array.isArray(res) && res[0]?.external_asset_path) {
        return res[0].external_asset_path;
      }
    } catch (e) {}
  }

  // Fallback for mp:external format if Discord asset proxy returns raw path
  if (imageUrl.startsWith('https://media.discordapp.net/')) {
    return imageUrl.replace('https://media.discordapp.net/', 'mp:');
  }
  return '';
}

async function buildRichPresence(client, payload) {
  const resolvedAppId = (payload.appId && String(payload.appId).trim()) || '1189283746519283746';
  const { platform } = resolveDevicePlatform(payload.device);

  const rpc = new RichPresence(client)
    .setApplicationId(resolvedAppId)
    .setType(payload.activityType || 'PLAYING')
    .setName(payload.name.trim());

  if (typeof rpc.setPlatform === 'function' && (platform === 'ps4' || platform === 'ps5' || platform === 'xbox')) {
    try {
      rpc.setPlatform(platform);
    } catch (e) {}
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

  let resolvedLarge = '';
  let resolvedSmall = '';

  if (rawLarge && rawSmall && /^https?:\/\//i.test(rawLarge) && /^https?:\/\//i.test(rawSmall) && typeof RichPresence.getExternal === 'function') {
    try {
      const ext = await RichPresence.getExternal(client, resolvedAppId, rawLarge, rawSmall);
      if (Array.isArray(ext)) {
        resolvedLarge = ext[0]?.external_asset_path || '';
        resolvedSmall = ext[1]?.external_asset_path || '';
      }
    } catch (e) {}
  }

  if (rawLarge && !resolvedLarge) {
    resolvedLarge = await resolveExternalImage(client, resolvedAppId, rawLarge);
  }
  if (rawSmall && !resolvedSmall) {
    resolvedSmall = await resolveExternalImage(client, resolvedAppId, rawSmall);
  }

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
        if (!/^https?:\/\//i.test(validUrl)) {
          validUrl = 'https://' + validUrl;
        }
        try {
          new URL(validUrl);
          const cleanLabel = btn.label.trim().slice(0, 32);
          rpc.addButton(cleanLabel, validUrl);
          validButtons.push({ label: cleanLabel, url: validUrl });
        } catch (e) {}
      }
    });

    // Ensure buttons & metadata also serialize cleanly in Discord gateway payload
    if (validButtons.length > 0 && Array.isArray(rpc.buttons)) {
      rpc.buttons = validButtons.map(b => b.label);
      rpc.metadata = { button_urls: validButtons.map(b => b.url) };
    }
  }

  return rpc;
}

async function loginSessionWithToken(entry, rawToken, attempt = 1) {
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

  return new Promise((resolve, reject) => {
    const client = new Client({
      checkUpdate: false,
      intents: ['GUILDS'],
      ws: {
        properties: {
          browser: 'Discord Client'
        }
      }
    });

    const timeout = setTimeout(() => {
      try { client.destroy(); } catch (e) {}
      reject(new Error('Connection took too long. Click Connect again.'));
    }, 15000);

    client.once('ready', async () => {
      clearTimeout(timeout);
      entry.client = client;
      entry.info = {
        connected: true,
        user: client.user.tag,
        avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
        activeGame: null,
        activeDetails: null
      };

      if (entry.state.activeRPC && entry.state.activeRPC.name) {
        try {
          client.user.setStatus(entry.state.activeRPC.statusType || 'online');
          const rpc = await buildRichPresence(client, entry.state.activeRPC);
          client.user.setActivity(rpc);
          entry.info.activeGame = entry.state.activeRPC.name.trim();
          entry.info.activeDetails = entry.state.activeRPC.details || null;
        } catch (err) {}
      }

      resolve(entry.info);
    });

    client.on('error', () => {});

    client.login(token).catch(async err => {
      clearTimeout(timeout);
      try { client.destroy(); } catch (e) {}

      if (attempt < 3) {
        try {
          await new Promise(r => setTimeout(r, 350));
          const retryRes = await loginSessionWithToken(entry, token, attempt + 1);
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

// Multi-API Anime Search for Crunchyroll (AniList GraphQL + Jikan v4 + Kitsu API)
async function searchAnimeEverywhere(searchTerm) {
  const query = (searchTerm || '').trim();

  // 1. AniList GraphQL API (supports both search query & random trending/popular page when empty)
  try {
    const randomPage = Math.floor(Math.random() * 12) + 1;
    const gqlQuery = query
      ? `
        query ($search: String) {
          Page(page: 1, perPage: 20) {
            media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
              title { romaji english }
              episodes
              coverImage { extraLarge large }
            }
          }
        }
      `
      : `
        query ($page: Int) {
          Page(page: $page, perPage: 20) {
            media(type: ANIME, sort: TRENDING_DESC) {
              title { romaji english }
              episodes
              coverImage { extraLarge large }
            }
          }
        }
      `;
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
          icon: m.coverImage?.extraLarge || m.coverImage?.large || ''
        }));
      }
    }
  } catch (e) {}

  // 2. Jikan v4 (MyAnimeList API)
  try {
    const url = query
      ? `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=20`
      : `https://api.jikan.moe/v4/top/anime?page=${Math.floor(Math.random() * 8) + 1}&limit=20`;
    const jikanResp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 NexusRPC/2.2' }
    });
    if (jikanResp.ok) {
      const jikanData = await jikanResp.json();
      if (Array.isArray(jikanData.data) && jikanData.data.length > 0) {
        return jikanData.data.map(anime => ({
          title: anime.title_english || anime.title,
          episodes: anime.episodes || 24,
          subtitle: anime.episodes ? `Episode 1 of ${anime.episodes} • Crunchyroll` : 'Episode 1 • Crunchyroll',
          album: anime.title,
          icon: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || ''
        }));
      }
    }
  } catch (e) {}

  // 3. Kitsu Anime API
  try {
    const kitsuUrl = query
      ? `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=20`
      : `https://kitsu.io/api/edge/anime?page[limit]=20&page[offset]=${Math.floor(Math.random() * 120)}`;
    const kitsuResp = await fetch(kitsuUrl, {
      headers: { 'Accept': 'application/vnd.api+json' }
    });
    if (kitsuResp.ok) {
      const kitsuData = await kitsuResp.json();
      if (Array.isArray(kitsuData.data) && kitsuData.data.length > 0) {
        return kitsuData.data.map(item => {
          const attr = item.attributes || {};
          const title = attr.titles?.en || attr.titles?.en_jp || attr.canonicalTitle || 'Anime';
          const epCount = attr.episodeCount || 24;
          return {
            title,
            episodes: epCount,
            subtitle: attr.episodeCount ? `Episode 1 of ${attr.episodeCount} • Crunchyroll` : 'Episode 1 • Crunchyroll',
            album: attr.canonicalTitle || title,
            icon: attr.posterImage?.large || attr.posterImage?.medium || attr.posterImage?.original || ''
          };
        });
      }
    }
  } catch (e) {}

  return [];
}

// Random discovery pools when search box is empty (never locked to one static show)
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
      const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(effectiveQuery)}&media=music&limit=24`;
      const resp = await fetch(searchUrl);
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
        const searchUrl = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`;
        const resp = await fetch(searchUrl);
        const data = await resp.json();
        rawShows = (data || []).map(entry => entry.show).filter(Boolean);
      } else {
        const randomPage = Math.floor(Math.random() * 15);
        const pageUrl = `https://api.tvmaze.com/shows?page=${randomPage}`;
        const resp = await fetch(pageUrl);
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

// Real YouTube Video Metadata Resolver (oEmbed + noembed fallback)
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
  getSessionId(req, res);
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
  const sid = getSessionId(req, res);
  const entry = loadUserSession(sid);

  if (!entry.info.connected && entry.state.token) {
    try {
      await loginSessionWithToken(entry, entry.state.token);
    } catch (e) {}
  }

  res.json({
    sessionId: sid,
    session: entry.info,
    activeRPC: entry.state.activeRPC,
    customDraft: entry.state.customDraft
  });
});

app.post('/connect-token', async (req, res) => {
  const sid = getSessionId(req, res);
  const entry = loadUserSession(sid);
  const token = cleanToken(req.body?.token);

  if (!token) {
    return res.status(400).json({ error: 'Please paste your Discord token first.' });
  }

  try {
    const info = await loginSessionWithToken(entry, token);
    entry.state.token = token;
    saveUserSession(entry);
    res.json({
      success: true,
      sessionId: sid,
      session: info,
      activeRPC: entry.state.activeRPC,
      customDraft: entry.state.customDraft
    });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Could not connect with that token.' });
  }
});

app.post('/disconnect', (req, res) => {
  const sid = getSessionId(req, res);
  const entry = loadUserSession(sid);

  if (entry.client) {
    try {
      entry.client.removeAllListeners();
      entry.client.destroy();
    } catch (e) {}
    entry.client = null;
  }

  entry.state.token = null;
  entry.state.activeRPC = null;
  entry.info = defaultInfo();
  saveUserSession(entry);

  res.json({ success: true });
});

app.post('/save-draft', (req, res) => {
  const sid = getSessionId(req, res);
  const entry = loadUserSession(sid);

  if (req.body && typeof req.body === 'object') {
    entry.state.customDraft = { ...entry.state.customDraft, ...req.body };
    saveUserSession(entry);
  }
  res.json({ success: true });
});

app.post('/set-rpc', async (req, res) => {
  const sid = getSessionId(req, res);
  const entry = loadUserSession(sid);

  if (!entry.info.connected || !entry.client) {
    if (entry.state.token) {
      try {
        await loginSessionWithToken(entry, entry.state.token);
      } catch (e) {
        return res.status(400).json({ error: 'Session timed out. Click Connect again.' });
      }
    } else {
      return res.status(400).json({ error: 'Connect your account first.' });
    }
  }

  const payload = req.body;
  if (!payload.name || !payload.name.trim()) {
    return res.status(400).json({ error: 'Give your activity a name first.' });
  }

  try {
    const { gatewayDevice } = resolveDevicePlatform(payload.device);
    entry.client.user.setStatus(payload.statusType || 'online');
    if (typeof entry.client.user.setSettings === 'function') {
      try {
        entry.client.user.setSettings({
          ff: false,
          status: payload.statusType || 'online',
          device: gatewayDevice
        });
      } catch (e) {}
    }

    const rpc = await buildRichPresence(entry.client, payload);
    entry.client.user.setActivity(rpc);

    entry.info.activeGame = payload.name.trim();
    entry.info.activeDetails = payload.details ? payload.details.trim() : null;

    entry.state.activeRPC = payload;
    saveUserSession(entry);

    return res.json({ success: true, session: entry.info, activeRPC: entry.state.activeRPC });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not update your status. Try again.' });
  }
});

app.post('/clear-rpc', (req, res) => {
  const sid = getSessionId(req, res);
  const entry = loadUserSession(sid);

  if (entry.info.connected && entry.client) {
    try {
      entry.client.user.setActivity(null);
    } catch (e) {}
  }
  entry.info.activeGame = null;
  entry.info.activeDetails = null;
  entry.state.activeRPC = null;
  saveUserSession(entry);

  res.json({ success: true, session: entry.info });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running on port ${PORT}`));
