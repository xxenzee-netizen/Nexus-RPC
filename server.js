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

// Pre-fetch all 21,000+ official Discord desktop games on server startup
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
  if (!q) {
    const popular = ['Minecraft', 'Roblox', 'Grand Theft Auto V', 'VALORANT', 'Fortnite', 'Counter-Strike 2', 'League of Legends', 'Genshin Impact', 'Apex Legends', 'Rocket League'];
    return res.json(cachedGames.filter(g => popular.includes(g.name)).slice(0, 20));
  }
  const results = cachedGames.filter(g => g.name.toLowerCase().includes(q)).slice(0, 40);
  res.json(results);
});

app.get('/status', (req, res) => {
  res.json(sessionInfo);
});

// 1. Connect Discord account ONCE
app.post('/connect', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Please paste your Discord token first.' });
  }

  try {
    if (activeClient) {
      activeClient.destroy();
      activeClient = null;
    }

    const client = new Client({ checkUpdate: false });

    client.once('ready', () => {
      activeClient = client;
      sessionInfo = {
        connected: true,
        user: client.user.tag,
        avatar: client.user.displayAvatarURL({ format: 'png', size: 128 }),
        activeGame: null
      };
      res.json({ success: true, session: sessionInfo });
    });

    await client.login(token.trim());
  } catch (err) {
    sessionInfo = { connected: false, user: null, avatar: null, activeGame: null };
    res.status(401).json({ error: 'Invalid token or connection failed.' });
  }
});

// 2. Disconnect Discord account
app.post('/disconnect', (req, res) => {
  if (activeClient) {
    activeClient.destroy();
    activeClient = null;
  }
  sessionInfo = { connected: false, user: null, avatar: null, activeGame: null };
  res.json({ success: true });
});

// 3. Switch games INSTANTLY without reconnecting
app.post('/set-game', (req, res) => {
  if (!activeClient || !sessionInfo.connected) {
    return res.status(400).json({ error: 'Connect your Discord account first!' });
  }

  const { appId, gameName, details, state, statusType, largeImage, buttonLabel, buttonUrl } = req.body;
  if (!appId || !gameName) {
    return res.status(400).json({ error: 'Select a game first.' });
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
    res.status(500).json({ error: 'Failed to update game activity.' });
  }
});

// 4. Clear game activity while staying connected
app.post('/clear-game', (req, res) => {
  if (activeClient && sessionInfo.connected) {
    activeClient.user.setActivity(null);
    sessionInfo.activeGame = null;
  }
  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RPC Panel running on port ${PORT}`));
