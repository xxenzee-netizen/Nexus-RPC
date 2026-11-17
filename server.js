const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

const STATE_FILE = path.join(__dirname, 'nexus_state.json');

let activeClient = null;
let cachedGames = [];

// Default persistent state structure
let savedState = {
  token: null,
  activeRPC: null,
  customDraft: {
    activityType: 'PLAYING',
    statusType: 'online',
    name: '',
    appId: '',
    details: '',
    state: '',
    timestampMode: 'now',
    customTimestamp: '',
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
  } catch (err) {
    console.error('Failed to read saved state:', err.message);
  }
}

function saveStateToDisk() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(savedState, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist state:', err.message);
  }
}

function buildRichPresence(client, payload) {
  const resolvedAppId = (payload.appId && payload.appId.trim())
    ? payload.appId.trim()
    : '1189283746519283746';

  const rpc = new RichPresence(client)
    .setApplicationId(resolvedAppId)
    .setType(payload.activityType || 'PLAYING')
    .setName(payload.name.trim());

  if (payload.details && payload.details.trim()) rpc.setDetails(payload.details.trim());
  if (payload.state && payload.state.trim()) rpc.setState(payload.state.trim());

  if (payload.timestampMode === 'now') {
    rpc.setStartTimestamp(Date.now());
  } else if (payload.timestampMode === 'custom' && payload.customTimestamp) {
    const parsedTime = new Date(payload.customTimestamp).getTime();
    if (!isNaN(parsedTime)) {
      rpc.setStartTimestamp(parsedTime);
    }
  } else if (payload.timestampMode === 'elapsed_1h') {
    rpc.setStartTimestamp(Date.now() - 3600000);
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
    const client = new Client({ checkUpdate: false });

    client.once('ready', () => {
      activeClient = client;
      sessionInfo = {
        connected: true,
        user: client.user.tag,
        avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
        activeGame: null,
        activeDetails: null
      };

      // Automatically restore saved RPC if one was active before restart/reload
      if (savedState.activeRPC && savedState.activeRPC.name) {
        try {
          client.user.setStatus(savedState.activeRPC.statusType || 'online');
          const rpc = buildRichPresence(client, savedState.activeRPC);
          client.user.setActivity(rpc);
          sessionInfo.activeGame = savedState.activeRPC.name.trim();
          sessionInfo.activeDetails = savedState.activeRPC.details || null;
        } catch (err) {
          console.error('Error restoring saved RPC:', err.message);
        }
      }

      resolve(sessionInfo);
    });

    client.login(token.trim()).catch(err => {
      reject(err);
    });
  });
}

// Auto-restore account login on server boot
loadStateFromDisk();
if (savedState.token) {
  loginWithToken(savedState.token)
    .then(() => console.log(`Auto-restored session for ${sessionInfo.user}`))
    .catch(() => {
      console.log('Saved token expired or invalid. Clearing stored token.');
      savedState.token = null;
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
  } catch (err) {
    console.error('Failed to fetch detectable games:', err.message);
  }
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
    res.status(401).json({ error: 'Invalid token or gateway connection failed.' });
  }
});

app.post('/disconnect', (req, res) => {
  if (activeClient) {
    try { activeClient.destroy(); } catch (e) {}
    activeClient = null;
  }
  savedState.token = null;
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

app.post('/set-rpc', (req, res) => {
  if (!sessionInfo.connected || !activeClient) {
    return res.status(400).json({ error: 'Connect your Discord account first.' });
  }

  const payload = req.body;
  if (!payload.name || !payload.name.trim()) {
    return res.status(400).json({ error: 'Activity name is required.' });
  }

  try {
    activeClient.user.setStatus(payload.statusType || 'online');
    const rpc = buildRichPresence(activeClient, payload);
    activeClient.user.setActivity(rpc);

    sessionInfo.activeGame = payload.name.trim();
    sessionInfo.activeDetails = payload.details ? payload.details.trim() : null;

    savedState.activeRPC = payload;
    saveStateToDisk();

    return res.json({ success: true, session: sessionInfo, activeRPC: savedState.activeRPC });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update Discord presence.' });
  }
});

app.post('/clear-rpc', (req, res) => {
  if (sessionInfo.connected && activeClient) {
    activeClient.user.setActivity(null);
  }
  sessionInfo.activeGame = null;
  sessionInfo.activeDetails = null;
  savedState.activeRPC = null;
  saveStateToDisk();

  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running on port ${PORT}`));
