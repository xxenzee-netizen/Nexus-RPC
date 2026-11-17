const express = require('express');
const path = require('path');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';

let activeClient = null;
let oauthSession = null;
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
    const response = await fetch('https://discord.com/api/v9/games/detectable');
    const data = await response.json();
    cachedGames = data
      .filter(g => g.id && g.name)
      .map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon_hash ? `https://cdn.discordapp.com/app-icons/${g.id}/${g.icon_hash}.png?size=64` : ''
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
  const limit = 30;

  let filtered = cachedGames;
  if (q) filtered = cachedGames.filter(g => g.name.toLowerCase().includes(q));

  const start = (page - 1) * limit;
  res.json({
    games: filtered.slice(start, start + limit),
    hasMore: start + limit < filtered.length
  });
});

app.get('/status', (req, res) => {
  res.json(sessionInfo);
});

// Roxydev-style Discord OAuth2 Login Endpoint
app.get('/auth/discord', (req, res) => {
  if (!CLIENT_ID) {
    return res.redirect('/?error=missing_client_id');
  }
  const host = req.get('host');
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const redirectUri = `${protocol}://${host}/auth/callback`;
  
  // Requesting identify and activity scopes similar to Roxydev
  const scopes = 'identify activities.write';
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  res.redirect(discordAuthUrl);
});

// OAuth2 Callback Handler
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=oauth_denied');

  try {
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const redirectUri = `${protocol}://${host}/auth/callback`;

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect('/?error=oauth_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    if (activeClient) {
      activeClient.destroy();
      activeClient = null;
    }

    oauthSession = {
      accessToken: tokenData.access_token
    };

    sessionInfo = {
      connected: true,
      mode: 'oauth',
      user: userData.discriminator && userData.discriminator !== '0'
        ? `${userData.username}#${userData.discriminator}`
        : userData.username,
      avatar: userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
        : 'https://cdn.discordapp.com/embed/avatars/0.png',
      activeGame: null
    };

    res.redirect('/');
  } catch (err) {
    res.redirect('/?error=server_error');
  }
});

// Direct Token Gateway Login (for full selfbot gateway control)
app.post('/connect-token', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Token is required.' });
  }

  try {
    if (activeClient) {
      activeClient.destroy();
      activeClient = null;
    }
    oauthSession = null;

    const client = new Client({ checkUpdate: false });

    client.once('ready', () => {
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

    await client.login(token.trim());
  } catch (err) {
    sessionInfo = { connected: false, mode: null, user: null, avatar: null, activeGame: null };
    res.status(401).json({ error: 'Invalid Discord token provided.' });
  }
});

app.post('/disconnect', (req, res) => {
  if (activeClient) {
    activeClient.destroy();
    activeClient = null;
  }
  oauthSession = null;
  sessionInfo = { connected: false, mode: null, user: null, avatar: null, activeGame: null };
  res.json({ success: true });
});

// Set Game Status (Supports both Token Gateway and OAuth Headless Session)
app.post('/set-game', async (req, res) => {
  if (!sessionInfo.connected) {
    return res.status(400).json({ error: 'Please log in first.' });
  }

  const { appId, gameName, details, state, statusType, largeImage, buttonLabel, buttonUrl } = req.body;
  if (!appId || !gameName) {
    return res.status(400).json({ error: 'Select a game first.' });
  }

  if (sessionInfo.mode === 'token' && activeClient) {
    try {
      activeClient.user.setStatus(statusType || 'online');

      const rpc = new RichPresence(activeClient)
        .setApplicationId(appId.trim())
        .setType('PLAYING')
        .setName(gameName.trim())
        .setStartTimestamp(Date.now());

      if (details && details.trim()) rpc.setDetails(details.trim());
      if (state && state.trim()) rpc.setState(state.trim());
      if (largeImage && largeImage.trim()) rpc.setAssetsLargeImage(largeImage.trim());
      rpc.setAssetsLargeText(gameName.trim());

      if (buttonLabel && buttonLabel.trim() && buttonUrl && buttonUrl.trim()) {
        rpc.addButton(buttonLabel.trim(), buttonUrl.trim());
      }

      activeClient.user.setActivity(rpc);
      sessionInfo.activeGame = gameName.trim();
      return res.json({ success: true, session: sessionInfo });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to update gateway status.' });
    }
  }

  if (sessionInfo.mode === 'oauth' && oauthSession) {
    try {
      const activityPayload = {
        activities: [
          {
            application_id: appId.trim(),
            name: gameName.trim(),
            type: 0,
            details: details && details.trim() ? details.trim() : undefined,
            state: state && state.trim() ? state.trim() : undefined,
            timestamps: { start: Date.now() }
          }
        ]
      };

      const discordRes = await fetch('https://discord.com/api/v10/users/@me/headless-sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oauthSession.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(activityPayload)
      });

      if (!discordRes.ok) {
        return res.status(403).json({
          error: 'OAuth RPC requires Discord Social SDK approval on your App. Use Token Login for instant RPC.'
        });
      }

      const data = await discordRes.json();
      oauthSession.headlessToken = data.token;
      sessionInfo.activeGame = gameName.trim();
      return res.json({ success: true, session: sessionInfo });
    } catch (err) {
      return res.status(500).json({ error: 'OAuth headless session failed.' });
    }
  }

  res.status(400).json({ error: 'Session expired. Please log in again.' });
});

app.post('/clear-game', async (req, res) => {
  if (sessionInfo.mode === 'token' && activeClient) {
    activeClient.user.setActivity(null);
  } else if (sessionInfo.mode === 'oauth' && oauthSession && oauthSession.headlessToken) {
    await fetch('https://discord.com/api/v10/users/@me/headless-sessions/delete', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthSession.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token: oauthSession.headlessToken })
    }).catch(() => {});
    oauthSession.headlessToken = null;
  }
  sessionInfo.activeGame = null;
  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running on port ${PORT}`));
