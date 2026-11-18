const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

const STATE_FILE = path.join(__dirname, 'nexus_state.json');

let activeClient = null;
let cachedGames = [];

let savedState = {
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

let sessionInfo = {
  connected: false,
  user: null,
  avatar: null,
  activeGame: null,
  activeDetails: null
};

function cleanToken(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.replace(/^["'\s]+|["'\s]+$/g, '').trim();
}

function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      savedState = { ...savedState, ...parsed };
      if (savedState.token) savedState.token = cleanToken(savedState.token);
    }
  } catch (err) {}
}

function saveStateToDisk() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(savedState, null, 2), 'utf-8');
  } catch (err) {}
}

function sanitizeImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/\.svg(\?.*)?$/i.test(trimmed) || trimmed.startsWith('data:')) {
    return '';
  }
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

  let resolvedLarge = rawLarge;
  let resolvedSmall = rawSmall;

  const isLargeHttp = /^https?:\/\//i.test(rawLarge);
  const isSmallHttp = /^https?:\/\//i.test(rawSmall);

  if ((isLargeHttp || isSmallHttp) && typeof RichPresence.getExternal === 'function') {
    try {
      const extAssets = await RichPresence.getExternal(
        client,
        resolvedAppId,
        isLargeHttp ? rawLarge : undefined,
        isSmallHttp ? rawSmall : undefined
      );
      if (Array.isArray(extAssets)) {
        if (isLargeHttp && isSmallHttp) {
          if (extAssets[0]?.external_asset_path) resolvedLarge = extAssets[0].external_asset_path;
          if (extAssets[1]?.external_asset_path) resolvedSmall = extAssets[1].external_asset_path;
        } else if (isLargeHttp) {
          if (extAssets[0]?.external_asset_path) resolvedLarge = extAssets[0].external_asset_path;
        } else if (isSmallHttp) {
          if (extAssets[0]?.external_asset_path) resolvedSmall = extAssets[0].external_asset_path;
        }
      }
    } catch (extErr) {
      if (isLargeHttp) {
        try {
          const singleLarge = await RichPresence.getExternal(client, resolvedAppId, rawLarge);
          resolvedLarge = singleLarge?.[0]?.external_asset_path || '';
        } catch (e) {
          resolvedLarge = '';
        }
      }
      if (isSmallHttp) {
        try {
          const singleSmall = await RichPresence.getExternal(client, resolvedAppId, undefined, rawSmall);
          resolvedSmall = singleSmall?.[0]?.external_asset_path || '';
        } catch (e) {
          resolvedSmall = '';
        }
      }
    }
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
    payload.buttons.slice(0, 2).forEach(btn => {
      if (btn && btn.label && btn.label.trim() && btn.url && btn.url.trim()) {
        let validUrl = btn.url.trim();
        if (!/^https?:\/\//i.test(validUrl)) {
          validUrl = 'https://' + validUrl;
        }
        try {
          new URL(validUrl);
          rpc.addButton(btn.label.trim().slice(0, 32), validUrl);
        } catch (e) {}
      }
    });
  }

  return rpc;
}

async function loginWithToken(rawToken, attempt = 1) {
  const token = cleanToken(rawToken);
  if (!token) throw new Error('Please provide a valid Discord token.');

  if (activeClient) {
    try {
      activeClient.removeAllListeners();
      activeClient.destroy();
    } catch (e) {}
    activeClient = null;
    await new Promise(r => setTimeout(r, 250));
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
      reject(new Error('Gateway connection timed out. Please try again.'));
    }, 15000);

    client.once('ready', async () => {
      clearTimeout(timeout);
      activeClient = client;
      sessionInfo = {
        connected: true,
        user: client.user.tag,
        avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
        activeGame: null,
        activeDetails: null
      };

      if (savedState.activeRPC && savedState.activeRPC.name) {
        try {
          client.user.setStatus(savedState.activeRPC.statusType || 'online');
          const rpc = await buildRichPresence(client, savedState.activeRPC);
          client.user.setActivity(rpc);
          sessionInfo.activeGame = savedState.activeRPC.name.trim();
          sessionInfo.activeDetails = savedState.activeRPC.details || null;
        } catch (err) {}
      }

      resolve(sessionInfo);
    });

    client.on('error', () => {});

    client.login(token).catch(async err => {
      clearTimeout(timeout);
      try { client.destroy(); } catch (e) {}

      if (attempt === 1 && !String(err.message || '').includes('TOKEN_INVALID')) {
        try {
          await new Promise(r => setTimeout(r, 500));
          const retryRes = await loginWithToken(token, 2);
          return resolve(retryRes);
        } catch (retryErr) {
          return reject(new Error('Token rejected by Discord. Make sure you copied the latest token without extra spaces.'));
        }
      }
      reject(new Error('Invalid token or session expired. Copy a fresh token and try again.'));
    });
  });
}

loadStateFromDisk();
if (savedState.token) {
  loginWithToken(savedState.token)
    .then(() => console.log(`Restored session for ${sessionInfo.user}`))
    .catch(() => {
      savedState.token = null;
      savedState.activeRPC = null;
      saveStateToDisk();
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
  const query = (searchTerm || 'Solo Leveling').trim();

  // 1. AniList GraphQL API
  try {
    const gqlQuery = `
      query ($search: String) {
        Page(page: 1, perPage: 20) {
          media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
            title { romaji english }
            episodes
            seasonYear
            coverImage { extraLarge large }
          }
        }
      }
    `;
    const aniResp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query: gqlQuery, variables: { search: query } })
    });
    if (aniResp.ok) {
      const aniData = await aniResp.json();
      const mediaList = aniData?.data?.Page?.media || [];
      if (mediaList.length > 0) {
        return mediaList.map(m => ({
          title: m.title.english || m.title.romaji,
          subtitle: m.episodes ? `Episode 1 of ${m.episodes} • Crunchyroll` : 'Anime Series • Crunchyroll',
          album: m.title.romaji || m.title.english,
          icon: m.coverImage?.extraLarge || m.coverImage?.large || ''
        }));
      }
    }
  } catch (e) {}

  // 2. Jikan v4 (MyAnimeList API)
  try {
    const jikanResp = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=20`, {
      headers: { 'User-Agent': 'Mozilla/5.0 NexusRPC/2.1' }
    });
    if (jikanResp.ok) {
      const jikanData = await jikanResp.json();
      if (Array.isArray(jikanData.data) && jikanData.data.length > 0) {
        return jikanData.data.map(anime => ({
          title: anime.title_english || anime.title,
          subtitle: anime.episodes ? `Episode 1 of ${anime.episodes} • Crunchyroll` : 'Anime Series • Crunchyroll',
          album: anime.title,
          icon: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || ''
        }));
      }
    }
  } catch (e) {}

  // 3. Kitsu Anime API
  try {
    const kitsuResp = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=20`, {
      headers: { 'Accept': 'application/vnd.api+json' }
    });
    if (kitsuResp.ok) {
      const kitsuData = await kitsuResp.json();
      if (Array.isArray(kitsuData.data) && kitsuData.data.length > 0) {
        return kitsuData.data.map(item => {
          const attr = item.attributes || {};
          const title = attr.titles?.en || attr.titles?.en_jp || attr.canonicalTitle || 'Anime';
          const epCount = attr.episodeCount;
          return {
            title,
            subtitle: epCount ? `Episode 1 of ${epCount} • Crunchyroll` : 'Anime Series • Crunchyroll',
            album: attr.canonicalTitle || title,
            icon: attr.posterImage?.large || attr.posterImage?.medium || attr.posterImage?.original || ''
          };
        });
      }
    }
  } catch (e) {}

  return [];
}

app.get('/api/media-search', async (req, res) => {
  const platform = (req.query.platform || 'spotify').toLowerCase();
  const query = (req.query.q || '').trim();

  try {
    if (platform === 'spotify' || platform === 'youtube') {
      const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query || 'The Weeknd')}&media=music&limit=18`;
      const resp = await fetch(searchUrl);
      const data = await resp.json();
      const results = (data.results || []).map(item => ({
        title: item.trackName || item.collectionName,
        subtitle: platform === 'youtube' ? `YouTube • ${item.artistName}` : `by ${item.artistName}`,
        album: item.collectionName || item.trackName,
        icon: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb')
      }));
      return res.json({ results });
    }

    if (platform === 'netflix') {
      const searchUrl = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query || 'Stranger Things')}`;
      const resp = await fetch(searchUrl);
      const data = await resp.json();
      const results = (data || []).slice(0, 18).map(entry => {
        const s = entry.show;
        return {
          title: s.name,
          subtitle: s.genres && s.genres.length ? s.genres.join(' • ') : 'Netflix Series',
          album: s.name,
          icon: s.image ? (s.image.original || s.image.medium) : ''
        };
      });
      return res.json({ results });
    }

    if (platform === 'crunchyroll') {
      const results = await searchAnimeEverywhere(query || 'Solo Leveling');
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
  if (!rawUrl) return res.status(400).json({ error: 'YouTube URL is required.' });

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
    return res.status(400).json({ error: 'Invalid YouTube video link.' });
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
  res.json({
    session: sessionInfo,
    activeRPC: savedState.activeRPC,
    customDraft: savedState.customDraft
  });
});

app.post('/connect-token', async (req, res) => {
  const token = cleanToken(req.body?.token);
  if (!token) {
    return res.status(400).json({ error: 'Please provide a Discord token.' });
  }

  try {
    const info = await loginWithToken(token);
    savedState.token = token;
    saveStateToDisk();
    res.json({
      success: true,
      session: info,
      activeRPC: savedState.activeRPC,
      customDraft: savedState.customDraft
    });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Invalid token or gateway connection failed.' });
  }
});

app.post('/disconnect', (req, res) => {
  if (activeClient) {
    try {
      activeClient.removeAllListeners();
      activeClient.destroy();
    } catch (e) {}
    activeClient = null;
  }
  savedState.token = null;
  savedState.activeRPC = null;
  saveStateToDisk();

  sessionInfo = {
    connected: false,
    user: null,
    avatar: null,
    activeGame: null,
    activeDetails: null
  };
  res.json({ success: true });
});

app.post('/save-draft', (req, res) => {
  if (req.body && typeof req.body === 'object') {
    savedState.customDraft = { ...savedState.customDraft, ...req.body };
    saveStateToDisk();
  }
  res.json({ success: true });
});

app.post('/set-rpc', async (req, res) => {
  if (!sessionInfo.connected || !activeClient) {
    if (savedState.token) {
      try {
        await loginWithToken(savedState.token);
      } catch (e) {
        return res.status(400).json({ error: 'Session expired. Please reconnect your token.' });
      }
    } else {
      return res.status(400).json({ error: 'Not connected to Discord gateway.' });
    }
  }

  const payload = req.body;
  if (!payload.name || !payload.name.trim()) {
    return res.status(400).json({ error: 'Activity name is required.' });
  }

  try {
    const { gatewayDevice } = resolveDevicePlatform(payload.device);
    activeClient.user.setStatus(payload.statusType || 'online');
    if (typeof activeClient.user.setSettings === 'function') {
      try {
        activeClient.user.setSettings({
          ff: false,
          status: payload.statusType || 'online',
          device: gatewayDevice
        });
      } catch (e) {}
    }

    const rpc = await buildRichPresence(activeClient, payload);
    activeClient.user.setActivity(rpc);

    sessionInfo.activeGame = payload.name.trim();
    sessionInfo.activeDetails = payload.details ? payload.details.trim() : null;

    savedState.activeRPC = payload;
    saveStateToDisk();

    return res.json({ success: true, session: sessionInfo, activeRPC: savedState.activeRPC });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to update presence. Try again.' });
  }
});

app.post('/clear-rpc', (req, res) => {
  if (sessionInfo.connected && activeClient) {
    try {
      activeClient.user.setActivity(null);
    } catch (e) {}
  }
  sessionInfo.activeGame = null;
  sessionInfo.activeDetails = null;
  savedState.activeRPC = null;
  saveStateToDisk();

  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running on port ${PORT}`));
