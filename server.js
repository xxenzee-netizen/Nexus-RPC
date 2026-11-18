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

function buildRichPresence(client, payload) {
  const resolvedAppId = payload.appId || '1189283746519283746';

  const rpc = new RichPresence(client)
    .setApplicationId(resolvedAppId)
    .setType(payload.activityType || 'PLAYING')
    .setName(payload.name.trim());

  if (payload.details && payload.details.trim()) rpc.setDetails(payload.details.trim());
  if (payload.state && payload.state.trim()) rpc.setState(payload.state.trim());

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

  if (payload.largeImage && payload.largeImage.trim()) {
    rpc.setAssetsLargeImage(payload.largeImage.trim());
    if (payload.largeText && payload.largeText.trim()) {
      rpc.setAssetsLargeText(payload.largeText.trim());
    }
  }

  if (payload.smallImage && payload.smallImage.trim()) {
    rpc.setAssetsSmallImage(payload.smallImage.trim());
    if (payload.smallText && payload.smallText.trim()) {
      rpc.setAssetsSmallText(payload.smallText.trim());
    }
  }

  if (Array.isArray(payload.buttons)) {
    payload.buttons.slice(0, 2).forEach(btn => {
      if (btn.label && btn.label.trim() && btn.url && btn.url.trim()) {
        let validUrl = btn.url.trim();
        if (!/^https?:\/\//i.test(validUrl)) {
          validUrl = 'https://' + validUrl;
        }
        rpc.addButton(btn.label.trim(), validUrl);
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
    }, 10000);

    client.once('ready', () => {
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
          if (typeof client.user.setSettings === 'function') {
            client.user.setSettings({ ff: false, status: savedState.activeRPC.statusType || 'online', device: savedState.activeRPC.device || 'desktop' });
          }
          const rpc = buildRichPresence(client, savedState.activeRPC);
          client.user.setActivity(rpc);
          sessionInfo.activeGame = savedState.activeRPC.name.trim();
          sessionInfo.activeDetails = savedState.activeRPC.details || null;
        } catch (err) {}
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
// Background login so startup is instant and doesn't block /status or page load
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

    const rpc = buildRichPresence(activeClient, payload);
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
