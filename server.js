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

function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      savedState = { ...savedState, ...parsed };
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
  // Discord Rich Presence does NOT support SVG or data URIs
  if (/\.svg(\?.*)?$/i.test(trimmed) || trimmed.startsWith('data:')) {
    return '';
  }
  return trimmed;
}

async function buildRichPresence(client, payload) {
  const resolvedAppId = (payload.appId && String(payload.appId).trim()) || '1189283746519283746';

  const rpc = new RichPresence(client)
    .setApplicationId(resolvedAppId)
    .setType(payload.activityType || 'PLAYING')
    .setName(payload.name.trim());

  if (payload.details && payload.details.trim()) {
    rpc.setDetails(payload.details.trim().slice(0, 128));
  }
  if (payload.state && payload.state.trim()) {
    rpc.setState(payload.state.trim().slice(0, 128));
  }

  // Party support
  const pSize = parseInt(payload.partySize, 10);
  const pMax = parseInt(payload.partyMax, 10);
  if (!isNaN(pSize) && !isNaN(pMax) && pSize > 0 && pMax >= pSize) {
    rpc.setParty({ max: pMax, current: pSize });
  }

  // Timestamps
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

  // Resolve external images via RichPresence.getExternal so Discord never throws INVALID_URL
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
      // Fallback: if one of the images failed proxy (e.g. bad host), try resolving individually
      if (isLargeHttp) {
        try {
          const singleLarge = await RichPresence.getExternal(client, resolvedAppId, rawLarge);
          if (Array.isArray(singleLarge) && singleLarge[0]?.external_asset_path) {
            resolvedLarge = singleLarge[0].external_asset_path;
          } else {
            resolvedLarge = '';
          }
        } catch (e) {
          resolvedLarge = '';
        }
      }
      if (isSmallHttp) {
        try {
          const singleSmall = await RichPresence.getExternal(client, resolvedAppId, undefined, rawSmall);
          if (Array.isArray(singleSmall) && singleSmall[0]?.external_asset_path) {
            resolvedSmall = singleSmall[0].external_asset_path;
          } else {
            resolvedSmall = '';
          }
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

async function loginWithToken(token) {
  if (activeClient) {
    try { activeClient.destroy(); } catch (e) {}
    activeClient = null;
  }

  return new Promise((resolve, reject) => {
    const client = new Client({
      checkUpdate: false,
      intents: ['GUILDS']
    });

    const timeout = setTimeout(() => {
      try { client.destroy(); } catch (e) {}
      reject(new Error('Gateway connection timeout.'));
    }, 12000);

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
        } catch (err) {
          console.error('Auto-restore RPC error:', err);
        }
      }

      resolve(sessionInfo);
    });

    client.login(token.trim()).catch(err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

loadStateFromDisk();
if (savedState.token) {
  loginWithToken(savedState.token)
    .then(() => console.log(`Auto-restored session for ${sessionInfo.user}`))
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

// Server-side Media Search Proxy (eliminates browser CORS / rate-limit blocks for Crunchyroll, Netflix, Spotify, YouTube)
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
        subtitle: platform === 'youtube' ? `YouTube Music • ${item.artistName}` : `by ${item.artistName}`,
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
          subtitle: s.genres && s.genres.length ? s.genres.join(' • ') : 'Netflix Original Series',
          album: s.name,
          icon: s.image ? (s.image.original || s.image.medium) : ''
        };
      });
      return res.json({ results });
    }

    if (platform === 'crunchyroll') {
      const searchTerm = query || 'Solo Leveling';
      // Try Jikan v4 first, fallback to AniList GraphQL API (ultra fast, no rate-limit issues)
      try {
        const jikanResp = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchTerm)}&limit=18`, {
          headers: { 'User-Agent': 'NexusRPC/2.0' }
        });
        if (jikanResp.ok) {
          const jikanData = await jikanResp.json();
          if (Array.isArray(jikanData.data) && jikanData.data.length > 0) {
            const results = jikanData.data.map(anime => ({
              title: anime.title_english || anime.title,
              subtitle: anime.episodes ? `Episode 1 of ${anime.episodes} • Crunchyroll` : 'Anime Series • Crunchyroll',
              album: anime.title,
              icon: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || ''
            }));
            return res.json({ results });
          }
        }
      } catch (e) {}

      // AniList GraphQL fallback (real-time, reliable, high-res cover images)
      const gqlQuery = `
        query ($search: String) {
          Page(page: 1, perPage: 18) {
            media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
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
        body: JSON.stringify({ query: gqlQuery, variables: { search: searchTerm } })
      });
      const aniData = await aniResp.json();
      const mediaList = aniData?.data?.Page?.media || [];
      const results = mediaList.map(m => ({
        title: m.title.english || m.title.romaji,
        subtitle: m.episodes ? `Episode 1 of ${m.episodes} • Crunchyroll` : 'Anime Series • Crunchyroll',
        album: m.title.romaji || m.title.english,
        icon: m.coverImage?.extraLarge || m.coverImage?.large || ''
      }));
      return res.json({ results });
    }

    return res.json({ results: [] });
  } catch (err) {
    return res.json({ results: [] });
  }
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
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Please provide a Discord token.' });
  }

  try {
    const info = await loginWithToken(token.trim());
    savedState.token = token.trim();
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
    try { activeClient.destroy(); } catch (e) {}
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
    activeClient.user.setStatus(payload.statusType || 'online');
    if (typeof activeClient.user.setSettings === 'function') {
      try {
        activeClient.user.setSettings({ ff: false, status: payload.statusType || 'online', device: payload.device || 'desktop' });
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
    console.error('RPC Broadcast Error:', err);
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
