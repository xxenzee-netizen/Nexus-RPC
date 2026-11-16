const express = require('express');
const path = require('path');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

const CLIENT_ID = process.env.CLIENT_ID || 'YOUR_DISCORD_CLIENT_ID';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'YOUR_DISCORD_CLIENT_SECRET';

let activeClient = null;
let sessionInfo = {
  connected: false,
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

app.get('/status', (req, res) => {
  res.json(sessionInfo);
});

// Force HTTPS OAuth2 Redirect
app.get('/auth/discord', (req, res) => {
  const host = req.get('host');
  const redirectUri = `https://${host}/auth/callback`;
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
  res.redirect(discordAuthUrl);
});

// OAuth2 Callback Endpoint
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const host = req.get('host');
    const redirectUri = `https://${host}/auth/callback`;
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

    sessionInfo = {
      connected: true,
      user: `${userData.username}#${userData.discriminator || '0'}`,
      avatar: userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png',
      activeGame: null
    };

    res.redirect('/');
  } catch (err) {
    res.redirect('/?error=server_error');
  }
});

// Gateway selfbot connection endpoint
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

    const client = new Client({ checkUpdate: false });

    client.once('ready', () => {
      activeClient = client;
      sessionInfo.connected = true;
      sessionInfo.user = client.user.tag;
      sessionInfo.avatar = client.user.displayAvatarURL({ format: 'png', size: 128 });
      res.json({ success: true, session: sessionInfo });
    });

    await client.login(token.trim());
  } catch (err) {
    res.status(401).json({ error: 'Invalid token or authentication failed.' });
  }
});

app.post('/disconnect
         
