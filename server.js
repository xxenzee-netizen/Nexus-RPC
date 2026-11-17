const express = require('express');
const path = require('path');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

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

// Gateway selfbot token connection endpoint
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

app.post('/disconnect', (req, res) => {
  if (activeClient) {
    activeClient.destroy();
    activeClient = null;
  }
  sessionInfo = { connected: false, user: null, avatar: null, activeGame: null };
  res.json({ success: true });
});

app.post('/set-game', (req, res) => {
  if (!activeClient || !sessionInfo.connected) {
    return res.status(400).json({ error: 'Gateway client not connected.' });
  }

  const { appId, gameName, details, state, statusType, largeImage, buttonLabel, buttonUrl } = req.body;
  if (!appId || !gameName) {
    return res.status(400).json({ error: 'Select a valid game.' });
  }

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
    res.json({ success: true, session: sessionInfo });
  } catch (err) {
    res.status(500).json({ error: 'Failed to broadcast status.' });
  }
});

app.post('/clear-game', (req, res) => {
  if (activeClient && sessionInfo.connected) {
    activeClient.user.setActivity(null);
    sessionInfo.activeGame = null;
  }
  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC server running on port ${PORT}`));
