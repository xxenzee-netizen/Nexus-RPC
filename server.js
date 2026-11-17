const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());
app.use(cookieParser());

const STATE_FILE = path.join(__dirname, 'nexus_sessions.json');

// Session store: { sessionId: { token, activeRPC, customDraft, client, device } }
let sessions = {};

function loadSessionsFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      sessions = JSON.parse(raw);
    }
  } catch (err) {
    console.error('Failed to read saved sessions:', err.message);
  }
}

function saveSessionsToDisk() {
  try {
    // Save state without circular client references
    const cleanSessions = {};
    for (const [sid, data] of Object.entries(sessions)) {
      cleanSessions[sid] = {
        token: data.token,
        activeRPC: data.activeRPC,
        customDraft: data.customDraft,
        device: data.device
      };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(cleanSessions, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist sessions:', err.message);
  }
}

loadSessionsFromDisk();

function getSessionId(req, res) {
  let sid = req.cookies.sessionId;
  if (!sid || !sessions[sid]) {
    sid = crypto.randomUUID();
    res.cookie('sessionId', sid, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true });
    sessions[sid] = {
      token: null,
      activeRPC: null,
      device: 'desktop',
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
      },
      client: null,
      sessionInfo: { connected: false, user: null, avatar: null, activeGame: null, activeDetails: null }
    };
  }
  return sid;
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

function applyPresenceToSession(sess, payload) {
  if (!sess.client) return;
  const status = payload.statusType || 'online';
  sess.client.user.setStatus(status);
  const rpc = buildRichPresence(sess.client, payload);
  if (typeof sess.client.user.setPresence === 'function') {
    sess.client.user.setPresence({ status, activities: [rpc] });
  } else {
    sess.client.user.setActivity(rpc);
  }
}

async function loginSessionWithToken(sid, token, deviceOverride = null) {
  const sess = sessions[sid];
  const targetDevice = (deviceOverride || sess.device || 'desktop').toLowerCase();
  sess.device = targetDevice;

  if (sess.client) {
    try { sess.client.destroy(); } catch (e) {}
    sess.client = null;
  }

  return new Promise((resolve, reject) => {
    const client = new Client({
      checkUpdate: false,
      intents: ['GUILDS'],
      ws: { properties: getDeviceProperties(targetDevice) }
    });

    const timeout = setTimeout(() => {
      try { client.destroy(); } catch (e) {}
      reject(new Error('Gateway connection timeout. Token may be invalid or ratelimited.'));
    }, 15000);

    client.once('ready', () => {
      clearTimeout(timeout);
      sess.client = client;
      sess.sessionInfo = {
        connected: true,
        user: client.user.tag,
        avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
        activeGame: null,
        activeDetails: null
      };

      if (sess.activeRPC && sess.activeRPC.name) {
        try {
          applyPresenceToSession(sess, sess.activeRPC);
          sess.sessionInfo.activeGame = sess.activeRPC.name.trim();
          sess.sessionInfo.activeDetails = sess.activeRPC.details || null;
        } catch (err) {
          console.error('Error restoring session RPC:', err.message);
        }
      }

      resolve(sess.sessionInfo);
    });

    client.login(token.trim()).catch(err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Auto-reconnect active session tokens on server boot
for (const [sid, sess] of Object.entries(sessions)) {
  if (sess.token) {
    loginSessionWithToken(sid, sess.token).catch(() => {
      sess.token = null;
      sess.activeRPC = null;
      saveSessionsToDisk();
    });
  }
}

let cachedGames = [];
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
    
    // Inject Grand Theft Auto VI at the top of the library
    const gta6 = {
      id: '1278456123985123456',
      name: 'Grand Theft Auto VI',
      icon: 'https://cdn.discordapp.com/app-icons/1278456123985123456/gtavi_cover.png'
    };
    cachedGames = [gta6, ...cachedGames.filter(g => g.id !== '1278456123985123456')];
  } catch (err) {}
}
loadGamesCache();

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

app.get('/status', (req, res) => {
  const sid = getSessionId(req, res);
  const sess = sessions[sid];
  res.json({
    session: sess.sessionInfo,
    activeRPC: sess.activeRPC,
    customDraft: sess.customDraft
  });
});

app.post('/connect-token', async (req, res) => {
  const sid = getSessionId(req, res);
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Please provide a Discord token.' });
  }

  try {
    const info = await loginSessionWithToken(sid, token.trim());
    sessions[sid].token = token.trim();
    saveSessionsToDisk();
    res.json({
      success: true,
      session: info,
      activeRPC: sessions[sid].activeRPC,
      customDraft: sessions[sid].customDraft
    });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Invalid token or gateway connection failed.' });
  }
});

app.post('/disconnect', (req, res) => {
  const sid = getSessionId(req, res);
  const sess = sessions[sid];
  if (sess.client) {
    try { sess.client.destroy(); } catch (e) {}
    sess.client = null;
  }
  sess.token = null;
  sess.activeRPC = null;
  sess.sessionInfo = { connected: false, user: null, avatar: null, activeGame: null, activeDetails: null };
  saveSessionsToDisk();

  res.json({ success: true });
});

app.post('/save-draft', (req, res) => {
  const sid = getSessionId(req, res);
  if (req.body && typeof req.body === 'object') {
    sessions[sid].customDraft = { ...sessions[sid].customDraft, ...req.body };
    saveSessionsToDisk();
  }
  res.json({ success: true });
});

app.post('/set-rpc', async (req, res) => {
  const sid = getSessionId(req, res);
  const sess = sessions[sid];
  const payload = req.body;

  if (!payload.name || !payload.name.trim()) {
    return res.status(400).json({ error: 'Activity name is required.' });
  }

  const requestedDevice = (payload.device || 'desktop').toLowerCase();

  try {
    if (!sess.sessionInfo.connected || !sess.client || sess.device !== requestedDevice) {
      if (!sess.token) {
        return res.status(400).json({ error: 'Not connected to Discord gateway.' });
      }
      sess.activeRPC = payload;
      await loginSessionWithToken(sid, sess.token, requestedDevice);
    } else {
      applyPresenceToSession(sess, payload);
    }

    sess.sessionInfo.activeGame = payload.name.trim();
    sess.sessionInfo.activeDetails = payload.details ? payload.details.trim() : null;
    sess.activeRPC = payload;
    saveSessionsToDisk();

    return res.json({ success: true, session: sess.sessionInfo, activeRPC: sess.activeRPC });
  } catch (err) {
    console.error('RPC Broadcast Error:', err);
    return res.status(500).json({ error: 'Failed to update presence. Try again.' });
  }
});

app.post('/clear-rpc', (req, res) => {
  const sid = getSessionId(req, res);
  const sess = sessions[sid];
  if (sess.sessionInfo.connected && sess.client) {
    try { sess.client.user.setActivity(null); } catch (e) {}
  }
  sess.sessionInfo.activeGame = null;
  sess.sessionInfo.activeDetails = null;
  sess.activeRPC = null;
  saveSessionsToDisk();

  res.json({ success: true, session: sess.sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running on port ${PORT}`));
      
