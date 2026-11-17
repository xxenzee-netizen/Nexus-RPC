const express = require('express');
const { Client, RichPresence } = require('discord.js-selfbot-v13');
const path = require('path');

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID || '1572028430600511649';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'YOUR_DISCORD_CLIENT_SECRET';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://onrender.com';

let activeClient = null;
let sessionInfo = {
  connected: false,
  mode: null,
  user: null,
  avatar: null,
  activeGame: null
};

let cachedGames = [];

async function loadGamesCache() {
  try {
    const response = await fetch('https://discord.com');
    const data = await response.json();
    cachedGames = data
      .filter(g => g.id && g.name)
      .map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon_hash ? `https://discordapp.com{g.id}/${g.icon_hash}.png?size=64` : ''
      }));
    console.log(`Loaded ${cachedGames.length} official Discord games.`);
  } catch (err) {
    console.error('Failed to pre-load games:', err.message);
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
  const limit = 30;

  let filtered = cachedGames;
  if (q) {
    filtered = cachedGames.filter(g => g.name.toLowerCase().includes(q));
  }

  const start = (page - 1) * limit;
  const paginated = filtered.slice(start, start + limit);

  res.json({
    games: paginated,
    hasMore: start + limit < filtered.length
  });
});

app.get('/status', (req, res) => {
  res.json(sessionInfo);
});

// 1. OAuth2 Login (Uses safe 'identify' scope so Discord never rejects it)
app.get('/auth/discord', (req, res) => {
  const discordAuthUrl = `https://discord.com{CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
  res.redirect(discordAuthUrl);
});

// 2. OAuth2 Callback
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await fetch('https://discord.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('OAuth Error:', tokenData);
      return res.redirect('/?error=oauth_failed');
    }

    const userRes = await fetch('https://discord.com', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    if (activeClient) {
      try { activeClient.destroy(); } catch (e) {}
      activeClient = null;
    }

    sessionInfo = {
      connected: true,
      mode: 'oauth',
      user: userData.discriminator && userData.discriminator !== '0'
        ? `${userData.username}#${userData.discriminator}`
        : userData.username,
      avatar: userData.avatar
        ? `https://discordapp.com{userData.id}/${userData.avatar}.png`
        : 'https://discordapp.com',
      activeGame: null
    };

    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/?error=server_error');
  }
});

// 3. Token Login (Required for broadcasting live RPC without official Discord app whitelisting)
app.post('/connect-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required.' });

  if (activeClient) {
    try { activeClient.destroy(); } catch (e) {}
    activeClient = null;
  }

  const client = new Client({ checkUpdate: false });
  let replied = false;

  client.once('ready', () => {
    if (replied) return;
    replied = true;
    activeClient = client;
    sessionInfo = {
      connected: true,
      mode: 'token',
      user: client.user.tag,
      avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
      activeGame: null
    };
    res.json({ success: true, session: sessionInfo });
  });

  try {
    await client.login(token.trim());
  } catch (err) {
    if (!replied) {
      replied = true;
      res.status(401).json({ error: 'Invalid Discord token or login failed.' });
    }
  }
});

// 4. Logout / Disconnect
app.post('/disconnect', (req, res) => {
  if (activeClient) {
    try { activeClient.destroy(); } catch (e) {}
    activeClient = null;
  }
  sessionInfo = {
    connected: false,
    mode: null,
    user: null,
    avatar: null,
    activeGame: null
  };
  res.json({ success: true });
});

// 5. Set Rich Presence Game
app.post('/set-game', (req, res) => {
  if (!sessionInfo.connected) {
    return res.status(401).json({ error: 'Please connect an account first.' });
  }

  const { appId, gameName, details, state, largeImage, buttonLabel, buttonUrl } = req.body;
  if (!gameName) {
    return res.status(400).json({ error: 'Select a valid game.' });
  }

  if (sessionInfo.mode === 'oauth' || !activeClient) {
    return res.status(403).json({
      error: 'OAuth2 login only displays your profile. To broadcast Rich Presence to Discord without a Discord-whitelisted app, please connect via the Token tab.'
    });
  }

  try {
    const rpc = new RichPresence(activeClient)
      .setApplicationId(appId && appId.trim() ? appId.trim() : '112233445566778899')
      .setType('PLAYING')
      .setName(gameName.trim())
      .setStartTimestamp(Date.now());

    if (details && details.trim()) rpc.setDetails(details.trim());
    if (state && state.trim()) rpc.setState(state.trim());
    if (largeImage && largeImage.trim()) {
      rpc.setAssetsLargeImage(largeImage.trim());
      rpc.setAssetsLargeText(gameName.trim());
    }
    if (buttonLabel && buttonLabel.trim() && buttonUrl && buttonUrl.trim()) {
      rpc.addButton(buttonLabel.trim(), buttonUrl.trim());
    }

    activeClient.user.setPresence({ activities: [rpc] });
    sessionInfo.activeGame = gameName.trim();

    res.json({ success: true, session: sessionInfo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to broadcast status.' });
  }
});

// 6. Clear Active Rich Presence
app.post('/clear-game', (req, res) => {
  if (activeClient && activeClient.user) {
    activeClient.user.setPresence({ activities: [] });
  }
  sessionInfo.activeGame = null;
  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC server running on port ${PORT}`));
