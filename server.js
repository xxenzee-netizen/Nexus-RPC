const express = require('express');
const path = require('path');
const fs = require('fs');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

const STATE_FILE = path.join(__dirname, 'nexus_state.json');

let activeClient = null;
let currentDevice = 'desktop';
let cachedGames = [];

let savedState = {
  token: null,
  activeRPC: null,
  customDraft: {
    appId: '',
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

function getDeviceProperties(device) {
  switch ((device || 'desktop').toLowerCase()) {
    case 'xbox':
      return { os: 'Xbox', browser: 'Discord Embedded', device: 'Xbox' };
    case 'android':
      return { os: 'Android', browser: 'Discord Android', device: 'Android' };
    case 'ios':
      return { os: 'iOS', browser: 'Discord iOS', device: 'iPhone' };
    case 'browser':
    case 'web':
      return { os: 'Windows', browser: 'Discord Web', device: '' };
    case 'desktop':
    default:
      return { os: 'Windows', browser: 'Discord Client', device: '' };
  }
}

function buildRichPresence(client, payload) {
  const cleanAppId = payload.appId && String(payload.appId).trim();
  const resolvedAppId = cleanAppId || '1189283746519283746';

  const rpc = new RichPresence(client)
    .setApplicationId(resolvedAppId)
    .setType(payload.activityType || 'PLAYING')
    .setName(payload.name.trim());

  if (payload.device && payload.device.toLowerCase() === 'xbox') {
    rpc.setPlatform('xbox');
  }

  if (payload.details && payload.details.trim()) rpc.setDetails(payload.details.trim());
  if (payload.state && payload.state.trim()) rpc.setState(payload.state.trim());

  const pSize = parseInt(payload.partySize, 10);
  const pMax = parseInt(payload.partyMax, 10);
  if (!isNaN(pSize) && !isNaN(pMax) && pSize > 0 && pMax >= pSize) {
    rpc.setParty({
      id: 'nexus_party_' + resolvedAppId,
      current: pSize,
      max: pMax
    });
  }

  const now = Date.now();
  if (payload.timestampMode === 'now') {
    rpc.setStartTimestamp(now);
  } else if (payload.timestampMode === 'elapsed_1h') {
    rpc.setStartTimestamp(now - 3600000);
  } else if (payload.timestampMode === 'custom') {
    if (payload.customStartMins !== '' && !isNaN(payload.customStartMins)) {
      const startMs = now - (parseFloat(payload.customStartMins) * 60 * 1000);
      rpc.setStartTimestamp(startMs);
    }
    if (payload.customEndMins !== '' && !isNaN(payload.customEndMins)) {
      const endMs = now + (parseFloat(payload.customEndMins) * 60 * 1000);
      rpc.setEndTimestamp(endMs);
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

function applyPresenceToClient(client, payload) {
  const status = payload.statusType || 'online';
  client.user.setStatus(status);
  const rpc = buildRichPresence(client, payload);
  if (typeof client.user.setPresence === 'function') {
    client.user.setPresence({
      status,
      activities: [rpc]
    });
  } else {
    client.user.setActivity(rpc);
  }
}

async function loginWithToken(token, deviceOverride = null) {
  const targetDevice = (deviceOverride || (savedState.activeRPC && savedState.activeRPC.device) || 'desktop').toLowerCase();

  if (activeClient) {
    try { activeClient.destroy(); } catch (e) {}
    activeClient = null;
  }

  return new Promise((resolve, reject) => {
    const client = new Client({
      checkUpdate: false,
      intents: ['GUILDS'],
      ws: {
        properties: getDeviceProperties(targetDevice)
      }
    });

    const timeout = setTimeout(() => {
      try { client.destroy(); } catch (e) {}
      reject(new Error('Gateway connection timeout. Token may be invalid or ratelimited.'));
    }, 15000);

    client.once('ready', () => {
      clearTimeout(timeout);
      activeClient = client;
      currentDevice = targetDevice;

      sessionInfo = {
        connected: true,
        user: client.user.tag,
        avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
        activeGame: null,
        activeDetails: null
      };

      if (savedState.activeRPC && savedState.activeRPC.name) {
        try {
          applyPresenceToClient(client, savedState.activeRPC);
          sessionInfo.activeGame = savedState.activeRPC.name.trim();
          sessionInfo.activeDetails = savedState.activeRPC.details || null;
        } catch (err) {
          console.error('Error restoring saved RPC:', err.message);
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

// Auto-restore on boot
loadStateFromDisk();
if (savedState.token) {
  loginWithToken(savedState.token)
    .then(() => console.log(`Auto-restored session for ${sessionInfo.user}`))
    .catch(() => {
      console.log('Saved token failed to connect. Clearing.');
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
  const payload = req.body;
  if (!payload.name || !payload.name.trim()) {
    return res.status(400).json({ error: 'Activity name is required.' });
  }

  const requestedDevice = (payload.device || 'desktop').toLowerCase();

  try {
    if (!sessionInfo.connected || !activeClient || currentDevice !== requestedDevice) {
      if (!savedState.token) {
        return res.status(400).json({ error: 'Not connected to Discord gateway.' });
      }
      savedState.activeRPC = payload;
      await loginWithToken(savedState.token, requestedDevice);
    } else {
      applyPresenceToClient(activeClient, payload);
    }

    sessionInfo.activeGame = payload.name.trim();
    sessionInfo.activeDetails = payload.details ? payload.details.trim() : null;

    savedState.activeRPC = payload;
    saveStateToDisk();

    return res.json({ success: true, session: sessionInfo, activeRPC: savedState.activeRPC });
  } catch (err) {
    console.error('RPC Broadcast Error:', err);
    return res.status(500).json({ error: 'Failed to update presence. Try again.' });
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

