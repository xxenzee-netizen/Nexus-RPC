const express = require('express');
const path = require('path');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

// Fill these in from your Discord Developer Portal OAuth2 tab!
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

// OAuth2 Login Redirect Endpoint
app.get('/auth/discord', (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
  res.redirect(discordAuthUrl);
});

// OAuth2 Callback Endpoint (Handles the login return)
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/callback`;
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

    // Fetch Discord User Profile
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

// If you still need token connection for the selfbot gateway proxy:
app.post('/connect-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    if (activeClient) activeClient.destroy();
    const client = new Client({ checkUpdate: false });
    client.once('ready', () => {
      activeClient = client;
      sessionInfo.connected = true;
      sessionInfo.user = client.user.tag;
      sessionInfo.avatar = client.user.displayAvatarURL({ format: 'png', size: 128 });
      res.json({ success: true, session: sessionInfo });
    });
    await client.login(token.trim());
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/disconnect', (req, res) => {
  if (activeClient) {
    activeClient.destroy();
    activeClient = null;
  }
  sessionInfo = { connected: false, user: null, avatar: null, activeGame: null };
  res.json({ success: true });
});

app.post('/set-game', (req, res) => {
  if (!activeClient) return res.status(400).json({ error: 'Gateway client not initialized.' });
  const { appId, gameName, details, state, statusType, largeImage, buttonLabel, buttonUrl } = req.body;
  
  try {
    activeClient.user.setStatus(statusType || 'online');
    const rpc = new RichPresence(activeClient)
      .setApplicationId(appId.trim())
      .setType('PLAYING')
      .setName(gameName.trim())
      .setStartTimestamp(Date.now());

    if (details) rpc.setDetails(details.trim());
    if (state) rpc.setState(state.trim());
    if (largeImage) rpc.setAssetsLargeImage(largeImage.trim());
    if (buttonLabel && buttonUrl) rpc.addButton(buttonLabel.trim(), buttonUrl.trim());

    activeClient.user.setActivity(rpc);
    sessionInfo.activeGame = gameName.trim();
    res.json({ success: true, session: sessionInfo });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set activity.' });
  }
});

app.post('/clear-game', (req, res) => {
  if (activeClient) {
    activeClient.user.setActivity(null);
    sessionInfo.activeGame = null;
  }
  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
