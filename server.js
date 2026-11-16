const express = require('express');
const path = require('path');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

let activeClient = null;
let currentStatus = { active: false, game: '', user: '' };
let cachedGames = [];

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/games', async (req, res) => {
  try {
    if (cachedGames.length === 0) {
      const response = await fetch('https://discord.com/api/v9/games/detectable');
      const data = await response.json();
      cachedGames = data
        .filter(g => g.id && g.name)
        .map(g => ({
          id: g.id,
          name: g.name,
          icon: g.icon_hash ? `https://cdn.discordapp.com/app-icons/${g.id}/${g.icon_hash}.png?size=64` : ''
        }));
    }
    const q = (req.query.q || '').toLowerCase().trim();
    const results = q
      ? cachedGames.filter(g => g.name.toLowerCase().includes(q)).slice(0, 30)
      : cachedGames.filter(g => ['Minecraft', 'Roblox', 'Grand Theft Auto V', 'VALORANT', 'Fortnite', 'Counter-Strike 2'].includes(g.name)).slice(0, 20);
    res.json(results);
  } catch (e) {
    res.status(500).json([]);
  }
});

app.get('/status', (req, res) => {
  res.json(currentStatus);
});

app.post('/start', async (req, res) => {
  const { token, appId, gameName, details, state, statusType, largeImage, buttonLabel, buttonUrl } = req.body;

  if (!token || !appId || !gameName) {
    return res.status(400).json({ error: 'Token, Game ID, and Game Name are required.' });
  }

  try {
    if (activeClient) {
      activeClient.destroy();
      activeClient = null;
    }

    const client = new Client({ checkUpdate: false });

    client.on('ready', () => {
      client.user.setStatus(statusType || 'online');

      const rpc = new RichPresence(client)
        .setApplicationId(appId.trim())
        .setType('PLAYING')
        .setName(gameName.trim())
        .setStartTimestamp(Date.now());

      if (details && details.trim()) rpc.setDetails(details.trim());
      if (state && state.trim()) rpc.setState(state.trim());
      if (largeImage && largeImage.trim()) rpc.setAssetsLargeImage(largeImage.trim());
      if (gameName) rpc.setAssetsLargeText(gameName.trim());

      if (buttonLabel && buttonLabel.trim() && buttonUrl && buttonUrl.trim()) {
        rpc.addButton(buttonLabel.trim(), buttonUrl.trim());
      }

      client.user.setActivity(rpc);
      activeClient = client;
      currentStatus = {
        active: true,
        game: gameName.trim(),
        user: client.user.tag
      };
    });

    await client.login(token.trim());
    setTimeout(() => {
      res.json({ success: true, status: currentStatus });
    }, 2000);
  } catch (err) {
    currentStatus = { active: false, game: '', user: '' };
    res.status(500).json({ error: 'Failed to connect. Check if your token is valid.' });
  }
});

app.post('/stop', (req, res) => {
  if (activeClient) {
    activeClient.destroy();
    activeClient = null;
  }
  currentStatus = { active: false, game: '', user: '' };
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RPC Panel running on port ${PORT}`));
