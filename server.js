const express = require('express');
const path = require('path');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';

let activeClient = null;
let oauthSession = {
  accessToken: null,
  refreshToken: null,
  headlessToken: null
};

let sessionInfo = {
  connected: false,
  mode: null, // 'oauth' or 'token'
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

// --- ROXYDEV-STYLE OAUTH2 FLOW (With activities.write scope) ---
app.get('/auth/discord', (req, res) => {
  if (!CLIENT_ID) {
    return res.status(400).send('DISCORD_CLIENT_ID is missing in Render Environment Variables.');
  }
  const scopes = encodeURIComponent('identify activities.write');
  const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scopes}`;
  res.redirect(authUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=NoCodeProvided');

  try {
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
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
      return res.redirect('/?error=TokenExchangeFailed');
    }

    const userRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    if (activeClient) {
      activeClient.destroy();
      activeClient = null;
    }

    oauthSession = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      headlessToken: null
    };

    sessionInfo = {
      connected: true,
      mode: 'oauth',
      user: userData.global_name || userData.username,
      avatar: userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
        : 'https://cdn.discordapp.com/embed/avatars/0.png',
      activeGame: null
    };

    res.redirect('/');
  } catch (err) {
    console.error('OAuth Error:', err);
    res.redirect('/?error=OAuthException');
  }
});

// --- MANUAL TOKEN GATEWAY LOGIN (Intact) ---
app.post('/connect-token', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Token missing.' });
  }

  try {
    if (activeClient) {
      activeClient.destroy();
      activeClient = null;
    }
    oauthSession = { accessToken: null, refreshToken: null, headlessToken: null };

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
    res.status(401).json({ error: 'Invalid token or authentication failed.' });
  }
});

app.post('/disconnect', async (req, res) => {
  if (activeClient) {
    activeClient.destroy();
    activeClient = null;
  }
  if (oauthSession.accessToken && oauthSession.headlessToken) {
    try {
      await fetch('https://discord.com/api/v10/users/@me/headless-sessions/delete', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oauthSession.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token: oauthSession.headlessToken })
      });
    } catch (e) {}
  }
  oauthSession = { accessToken: null, refreshToken: null, headlessToken: null };
  sessionInfo = { connected: false, mode: null, user: null, avatar: null, activeGame: null };
  res.json({ success: true });
});

// --- UNIFIED SET-GAME (Supports both OAuth Cloud SDK & Manual Token) ---
app.post('/set-game', async (req, res) => {
  if (!sessionInfo.connected) {
    return res.status(400).json({ error: 'Not connected.' });
  }

  const { appId, gameName, details, state, statusType, largeImage, buttonLabel, buttonUrl } = req.body;
  if (!appId || !gameName) {
    return res.status(400).json({ error: 'Select a valid game.' });
  }

  // MODE 1: RoxyDev Cloud OAuth2 Headless Session API
  if (sessionInfo.mode === 'oauth' && oauthSession.accessToken) {
    try {
      const activityPayload = {
        name: gameName.trim(),
        type: 0,
        application_id: appId.trim(),
        timestamps: { start: Date.now() }
      };

      if (details && details.trim()) activityPayload.details = details.trim();
      if (state && state.trim()) activityPayload.state = state.trim();
      if (largeImage && largeImage.trim()) {
        activityPayload.assets = {
          large_image: largeImage.trim(),
          large_text: gameName.trim()
        };
      }
      if (buttonLabel && buttonLabel.trim() && buttonUrl && buttonUrl.trim()) {
        activityPayload.buttons = [buttonLabel.trim()];
        activityPayload.metadata = { button_urls: [buttonUrl.trim()] };
      }

      const bodyPayload = { activities: [activityPayload] };
      if (oauthSession.headlessToken) {
        bodyPayload.token = oauthSession.headlessToken;
      }

      const rpcRes = await fetch('https://discord.com/api/v10/users/@me/headless-sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oauthSession.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bodyPayload)
      });

      const rpcData = await rpcRes.json();
      if (!rpcRes.ok) {
        return res.status(rpcRes.status).json({
          error: rpcData.message || 'Discord rejected Cloud RPC (ensure your app has activities.write permission).'
        });
      }

      if (rpcData.token) {
        oauthSession.headlessToken = rpcData.token;
      }

      sessionInfo.activeGame = gameName.trim();
      return res.json({ success: true, session: sessionInfo });
    } catch (err) {
      return res.status(500).json({ error: 'Cloud RPC request failed.' });
    }
  }

  // MODE 2: Manual User Token Gateway
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
      return res.status(500).json({ error: 'Failed to broadcast status.' });
    }
  }

  res.status(400).json({ error: 'No active session found.' });
});

app.post('/clear-game', async (req, res) => {
  if (sessionInfo.mode === 'oauth' && oauthSession.accessToken && oauthSession.headlessToken) {
    try {
      await fetch('https://discord.com/api/v10/users/@me/headless-sessions/delete', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${oauthSession.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token: oauthSession.headlessToken })
      });
      oauthSession.headlessToken = null;
    } catch (e) {}
  } else if (sessionInfo.mode === 'token' && activeClient) {
    activeClient.user.setActivity(null);
  }

  sessionInfo.activeGame = null;
  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC server running on port ${PORT}`));
                                              
