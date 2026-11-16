const express = require('express');
const path = require('path');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.use(express.json());

let activeClient = null;
let currentStatus = { active: false, game: '', user: '' };

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/status', (req, res) => {
  res.json(currentStatus);
});

app.post('/start', async (req, res) => {
  const { token, appId, gameName, details, state, statusType } = req.body;

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
