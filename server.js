const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID || '1572028430600511649';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'YOUR_DISCORD_CLIENT_SECRET';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://onrender.com';

let sessionInfo = {
  connected: false,
  user: null,
  avatar: null,
  accessToken: null,
  refreshToken: null,
  activeGame: null,
  headlessSessionToken: null
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

// Paginated & searchable games catalog endpoint
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

// Frontend status check (never exposes tokens to browser)
app.get('/status', (req, res) => {
  res.json({
    connected: sessionInfo.connected,
    user: sessionInfo.user,
    avatar: sessionInfo.avatar,
    activeGame: sessionInfo.activeGame
  });
});

// 1. OAuth2 Login Redirect
app.get('/auth/discord', (req, res) => {
  const scopes = 'rpc.activities.write+rpc+identify';
  const discordAuthUrl = `https://discord.com{CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scopes}`;
  res.redirect(discordAuthUrl);
});

// 2. OAuth2 Callback Endpoint
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
      console.error('Discord OAuth Token Error:', tokenData);
      return res.redirect('/?error=oauth_failed');
    }

    const userRes = await fetch('https://discord.com', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    sessionInfo = {
      connected: true,
      user: userData.discriminator && userData.discriminator !== '0'
        ? `${userData.username}#${userData.discriminator}`
        : userData.username,
      avatar: userData.avatar
        ? `https://discordapp.com{userData.id}/${userData.avatar}.png`
        : 'https://discordapp.com',
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      activeGame: null,
      headlessSessionToken: null
    };

    res.redirect('/');
  } catch (err) {
    console.error('OAuth Callback Error:', err);
    res.redirect('/?error=server_error');
  }
});

// 3. Logout / Disconnect
app.post('/disconnect', async (req, res) => {
  if (sessionInfo.connected && sessionInfo.accessToken && sessionInfo.headlessSessionToken) {
    await fetch('https://discord.com', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionInfo.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token: sessionInfo.headlessSessionToken })
    }).catch(() => {});
  }

  sessionInfo = {
    connected: false,
    user: null,
    avatar: null,
    accessToken: null,
    refreshToken: null,
    activeGame: null,
    headlessSessionToken: null
  };
  res.json({ success: true });
});

// 4. Set Rich Presence via Official OAuth2 Bearer Token
app.post('/set-game', async (req, res) => {
  if (!sessionInfo.connected || !sessionInfo.accessToken) {
    return res.status(401).json({ error: 'Please login with Discord first.' });
  }

  const { appId, gameName, details, state, largeImage, buttonLabel, buttonUrl } = req.body;
  if (!gameName) {
    return res.status(400).json({ error: 'Select a valid game.' });
  }

  try {
    // Delete previous active headless session if one exists
    if (sessionInfo.headlessSessionToken) {
      await fetch('https://discord.com', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionInfo.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token: sessionInfo.headlessSessionToken })
      }).catch(() => {});
    }

    const activity = {
      name: gameName.trim(),
      type: 0, // 0 = Playing
      application_id: appId && appId.trim() ? appId.trim() : CLIENT_ID,
      timestamps: { start: Date.now() }
    };

    if (details && details.trim()) activity.details = details.trim();
    if (state && state.trim()) activity.state = state.trim();
    if (largeImage && largeImage.trim()) {
      activity.assets = {
        large_image: largeImage.trim(),
        large_text: gameName.trim()
      };
    }
    if (buttonLabel && buttonLabel.trim() && buttonUrl && buttonUrl.trim()) {
      activity.buttons = [{ label: buttonLabel.trim(), url: buttonUrl.trim() }];
    }

    const rpcRes = await fetch('https://discord.com', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionInfo.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ activities: [activity] })
    });

    const rpcData = await rpcRes.json();
    if (!rpcRes.ok) {
      console.error('Discord RPC API Error:', rpcData);
      return res.status(rpcRes.status).json({
        error: rpcData.message || 'Discord rejected the RPC request. Check OAuth2 scopes.'
      });
    }

    sessionInfo.activeGame = gameName.trim();
    sessionInfo.headlessSessionToken = rpcData.token || null;

    res.json({
      success: true,
      session: {
        connected: sessionInfo.connected,
        user: sessionInfo.user,
        avatar: sessionInfo.avatar,
        activeGame: sessionInfo.activeGame
      }
    });
  } catch (err) {
    console.error('Set Game Error:', err);
    res.status(500).json({ error: 'Failed to broadcast status.' });
  }
});

// 5. Clear Active Rich Presence
app.post('/clear-game', async (req, res) => {
  if (sessionInfo.connected && sessionInfo.accessToken && sessionInfo.headlessSessionToken) {
    await fetch('https://discord.com', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionInfo.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token: sessionInfo.headlessSessionToken })
    }).catch(() => {});
  }

  sessionInfo.activeGame = null;
  sessionInfo.headlessSessionToken = null;

  res.json({
    success: true,
    session: {
      connected: sessionInfo.connected,
      user: sessionInfo.user,
      avatar: sessionInfo.avatar,
      activeGame: null
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC server running on port ${PORT}`));
      
