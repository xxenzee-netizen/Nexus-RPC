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
  activeGame: null,
  activeDetails: null
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
        icon: g.icon_hash
          ? `https://cdn.discordapp.com/app-icons/${g.id}/${g.icon_hash}.png?size=128`
          : ''
      }));
  } catch (err) {
    console.error('Failed to fetch detectable games:', err.message);
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
  const limit = 36;

  let filtered = cachedGames;
  if (q) {
    filtered = cachedGames.filter(g => g.name.toLowerCase().includes(q));
  }

  const start = (page - 1) * limit;
  res.json({
    games: filtered.slice(start, start + limit),
    hasMore: start + limit < filtered.length
  });
});

app.get('/status', (req, res) => {
  res.json(sessionInfo);
});

app.post('/connect-token', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.trim()) {
    return res.status(400).json({ error: 'Please provide a Discord token.' });
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
        activeGame: null,
        activeDetails: null
      };
      res.json({ success: true, session: sessionInfo });
    });

    await client.login(token.trim());
  } catch (err) {
    res.status(401).json({ error: 'Invalid token or gateway connection failed.' });
  }
});

app.post('/disconnect', (req, res) => {
  if (activeClient) {
    activeClient.destroy();
    activeClient = null;
  }
  sessionInfo = {
    connected: false,
    user: null,
    avatar: null,
    activeGame: null,
    activeDetails: null
  };
  res.json({ success: true });
});

app.post('/set-rpc', (req, res) => {
  if (!sessionInfo.connected || !activeClient) {
    return res.status(400).json({ error: 'Connect your Discord account first.' });
  }

  const {
    appId,
    activityType,
    name,
    details,
    state,
    statusType,
    largeImage,
    largeText,
    smallImage,
    smallText,
    timestampMode,
    customTimestamp,
    buttons
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Activity name is required.' });
  }

  try {
    activeClient.user.setStatus(statusType || 'online');

    // Default fallback Application ID if user leaves Custom RPC App ID blank
    const resolvedAppId = (appId && appId.trim()) ? appId.trim() : '1189283746519283746';

    const rpc = new RichPresence(activeClient)
      .setApplicationId(resolvedAppId)
      .setType(activityType || 'PLAYING')
      .setName(name.trim());

    if (details && details.trim()) rpc.setDetails(details.trim());
    if (state && state.trim()) rpc.setState(state.trim());

    // Timestamps
    if (timestampMode === 'now') {
      rpc.setStartTimestamp(Date.now());
    } else if (timestampMode === 'custom' && customTimestamp) {
      const parsedTime = new Date(customTimestamp).getTime();
      if (!isNaN(parsedTime)) {
        rpc.setStartTimestamp(parsedTime);
      }
    } else if (timestampMode === 'elapsed_1h') {
      rpc.setStartTimestamp(Date.now() - 3600000);
    }

    // Images & Hover Texts
    if (largeImage && largeImage.trim()) {
      rpc.setAssetsLargeImage(largeImage.trim());
      if (largeText && largeText.trim()) {
        rpc.setAssetsLargeText(largeText.trim());
      }
    }

    if (smallImage && smallImage.trim()) {
      rpc.setAssetsSmallImage(smallImage.trim());
      if (smallText && smallText.trim()) {
        rpc.setAssetsSmallText(smallText.trim());
      }
    }

    // Up to 2 Buttons
    if (Array.isArray(buttons)) {
      buttons.slice(0, 2).forEach(btn => {
        if (btn.label && btn.label.trim() && btn.url && btn.url.trim()) {
          let validUrl = btn.url.trim();
          if (!/^https?:\/\//i.test(validUrl)) {
            validUrl = 'https://' + validUrl;
          }
          rpc.addButton(btn.label.trim(), validUrl);
        }
      });
    }

    activeClient.user.setActivity(rpc);
    sessionInfo.activeGame = name.trim();
    sessionInfo.activeDetails = details ? details.trim() : null;

    return res.json({ success: true, session: sessionInfo });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update Discord presence.' });
  }
});

app.post('/clear-rpc', (req, res) => {
  if (sessionInfo.connected && activeClient) {
    activeClient.user.setActivity(null);
  }
  sessionInfo.activeGame = null;
  sessionInfo.activeDetails = null;
  res.json({ success: true, session: sessionInfo });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running on port ${PORT}`));
               
