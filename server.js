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

      // Add custom buttons if provided
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
