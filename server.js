const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Client, RichPresence } = require('discord.js-selfbot-v13');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));

// Pure in-memory per-browser-session store (100% isolated per user/browser)
const userSessions = new Map();
const externalAssetCache = new Map();
let cachedGames = [];

const NEXUS_LOGO_URL = 'https://myimgs.org/storage/images/87001/1000048092.png';
const CRUNCHYROLL_LOGO_URL = 'https://myimgs.org/storage/images/87240/1000048105.png';
// Verified Discord application IDs that reliably process external assets (mp:external/...)
// Real Discord Application IDs that support /applications/:id/external-assets
const FALLBACK_ASSET_APP_IDS = [
  '463151177836658699', // PreMiD
  '383226320970055681', // Visual Studio Code
  '463097721130188830', // YouTube Music / PreMiD
  '926541425682829352', // SoundCloud
  '802958789555781663', // Crunchyroll
  '356875570916753438', // Twitch
  '438122941302046720'  // Xbox
];

async function uploadGifOrImageToDiscordCdn(client, token, imageUrlOrDataUrl) {
  try {
    let buffer = null;
    let filename = `nexus_${Date.now()}.gif`;

    if (String(imageUrlOrDataUrl).startsWith('data:image/')) {
      const m = String(imageUrlOrDataUrl).match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) return '';
      const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
      filename = `nexus_${Date.now()}.${ext}`;
      buffer = Buffer.from(m[2], 'base64');
    } else if (/^https?:\/\//i.test(imageUrlOrDataUrl)) {
      const resp = await fetchWithTimeout(imageUrlOrDataUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      }, 4500);
      if (!resp.ok) return '';
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('image/')) return '';
      const ext = ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : ct.includes('png') ? 'png' : 'jpg';
      filename = `nexus_${Date.now()}.${ext}`;
      buffer = Buffer.from(await resp.arrayBuffer());
    }

    if (!buffer || buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return '';

    // Upload directly to the user's own Saved Messages (Self DM) via Discord API to get a native mp:attachments/... asset!
    const activeToken = token || client?.token || '';
    const selfId = client?.user?.id;
    if (!activeToken || !selfId) return '';

    const dmResp = await fetchWithTimeout('https://discord.com/api/v9/users/@me/channels', {
      method: 'POST',
      headers: {
        Authorization: activeToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipients: [selfId] })
    }, 4000);

    if (!dmResp.ok) return '';
    const dmData = await dmResp.json();
    const channelId = dmData?.id;
    if (!channelId) return '';

    if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
      const mime = filename.endsWith('.gif') ? 'image/gif' : filename.endsWith('.webp') ? 'image/webp' : filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const fd = new FormData();
      fd.append('files[0]', new Blob([buffer], { type: mime }), filename);
      fd.append('payload_json', JSON.stringify({ content: '' }));

      const msgResp = await fetchWithTimeout(`https://discord.com/api/v9/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: activeToken },
        body: fd
      }, 6000);

      if (msgResp.ok) {
        const msgData = await msgResp.json();
        const attUrl = msgData?.attachments?.[0]?.url || msgData?.attachments?.[0]?.proxy_url;
        if (attUrl) {
          const parsed = new URL(attUrl);
          const cleanPath = parsed.pathname.replace(/^\/+/, '');
          if (cleanPath.startsWith('attachments/')) {
            return `mp:${cleanPath}${parsed.search || ''}`;
          }
        }
      }
    }
  } catch (e) {}
  return '';
}

// Periodic cleanup of stale disconnected sessions
setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of userSessions.entries()) {
    if (!entry.info.connected && now - entry.lastSeen > 60 * 60 * 1000) {
      if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
      userSessions.delete(sid);
    }
  }
  for (const [k, v] of hostedMemoryImages.entries()) {
    if (now - v.createdAt > 24 * 60 * 60 * 1000) {
      hostedMemoryImages.delete(k);
    }
  }
}, 15 * 60 * 1000);

function getSessionId(req) {
  const headerSid = req.headers['x-nexus-session'];
  if (headerSid && /^[a-zA-Z0-9_-]{12,64}$/.test(headerSid)) {
    return headerSid;
  }
  return crypto.randomBytes(20).toString('hex');
}

function defaultInfo() {
  return {
    connected: false,
    user: null,
    userId: null,
    avatar: null,
    activeGame: null,
    activeDetails: null,
    customStatus: null,
    afkResponder: { enabled: false, message: '' }
  };
}

function getOrCreateSession(sid) {
  if (!userSessions.has(sid)) {
    userSessions.set(sid, {
      sid,
      token: null,
      client: null,
      keepAliveTimer: null,
      reconnecting: false,
      info: defaultInfo(),
      activeRPC: null,
      customStatus: null,
      afkConfig: { enabled: false, message: "I'm away right now, I'll reply soon!" },
      afkCooldowns: new Map(),
      device: 'desktop',
      lastSeen: Date.now()
    });
  }
  const entry = userSessions.get(sid);
  entry.lastSeen = Date.now();
  return entry;
}



function sanitizeImageInput(val) {
  if (!val || typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('mp:')) return trimmed;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

const hostedMemoryImages = new Map();

async function fetchWithTimeout(url, options = {}, ms = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function uploadDataUrlToPublicHost(dataUrl, req = null) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return '';
  const mime = match[1].toLowerCase();
  const base64Data = match[2];
  const extMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp'
  };
  const ext = extMap[mime] || 'png';
  const buffer = Buffer.from(base64Data, 'base64');
  const filename = `nexus_${Date.now()}.${ext}`;

  // 1. Try Catbox (direct permanent static URLs for PNG/JPG/GIF/WEBP)
  try {
    if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append('fileToUpload', new Blob([buffer], { type: mime }), filename);
      const resp = await fetchWithTimeout('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: form
      }, 9000);
      if (resp.ok) {
        const text = (await resp.text()).trim();
        if (/^https?:\/\//i.test(text) && !text.toLowerCase().includes('error')) return text;
      }
    }
  } catch (e) {}

  // 2. Try Litterbox (72h direct URLs)
  try {
    if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append('time', '72h');
      form.append('fileToUpload', new Blob([buffer], { type: mime }), filename);
      const resp = await fetchWithTimeout('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        body: form
      }, 9000);
      if (resp.ok) {
        const text = (await resp.text()).trim();
        if (/^https?:\/\//i.test(text) && !text.toLowerCase().includes('error')) return text;
      }
    }
  } catch (e) {}

  // 3. Try 0x0.st direct upload fallback
  try {
    if (typeof FormData !== 'undefined' && typeof Blob !== 'undefined') {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mime }), filename);
      const resp = await fetchWithTimeout('https://0x0.st', {
        method: 'POST',
        headers: { 'User-Agent': 'NexusRPC/2.6' },
        body: form
      }, 9000);
      if (resp.ok) {
        const text = (await resp.text()).trim();
        if (/^https?:\/\//i.test(text)) return text;
      }
    }
  } catch (e) {}

  // 4. Try freeimage.host
  try {
    const form = new URLSearchParams();
    form.append('key', '6d207e02198a847aa98d0a2a901485a5');
    form.append('action', 'upload');
    form.append('source', base64Data);
    form.append('format', 'json');
    const resp = await fetchWithTimeout('https://freeimage.host/api/1/upload', {
      method: 'POST',
      body: form
    }, 9000);
    if (resp.ok) {
      const json = await resp.json();
      const hosted = json?.image?.url || json?.image?.display_url;
      if (hosted && /^https?:\/\//i.test(hosted)) return hosted;
    }
  } catch (e) {}

  // 5. Try imgbb public fallback key
  try {
    const form = new URLSearchParams();
    form.append('key', '2d4b0f3e3b3f0e5a2c6e1b9a8d7c4f2e');
    form.append('image', base64Data);
    form.append('name', `nexus_${Date.now()}`);
    const resp = await fetchWithTimeout('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: form
    }, 9000);
    if (resp.ok) {
      const json = await resp.json();
      const hosted = json?.data?.url || json?.data?.display_url;
      if (hosted && /^https?:\/\//i.test(hosted)) return hosted;
    }
  } catch (e) {}

  // 6. Guaranteed self-hosted fallback on this server (/i/:id.:ext) if external hosts block cloud IPs
  if (req && buffer.length <= 6 * 1024 * 1024) {
    const imgId = crypto.randomBytes(8).toString('hex');
    const fullKey = `${imgId}.${ext}`;
    hostedMemoryImages.set(fullKey, {
      buffer,
      mime,
      createdAt: Date.now()
    });
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.get('host');
    if (host) {
      return `${proto}://${host}/i/${fullKey}`;
    }
  }

  return '';
}

function parseDiscordEmojiInput(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return null;

  const customMatch = raw.match(/^<(a)?:([a-zA-Z0-9_]{1,32}):(\d{17,20})>$/);
  if (customMatch) {
    return {
      rawEmoji: raw,
      name: customMatch[2],
      id: customMatch[3],
      animated: Boolean(customMatch[1])
    };
  }

  const shorthandMatch = raw.match(/^(a:)?([a-zA-Z0-9_]{1,32}):(\d{17,20})$/);
  if (shorthandMatch) {
    return {
      rawEmoji: raw,
      name: shorthandMatch[2],
      id: shorthandMatch[3],
      animated: Boolean(shorthandMatch[1])
    };
  }

  return {
    rawEmoji: raw.slice(0, 16),
    name: raw.slice(0, 16),
    id: null,
    animated: false
  };
}

function resolveDeviceProperties(device) {
  const d = (device || 'desktop').toLowerCase();
  if (d === 'android') {
    return {
      wsProps: { os: 'Android', browser: 'Discord Android', device: 'Discord Android' },
      platform: 'android'
    };
  }
  if (d === 'ios') {
    return {
      wsProps: { os: 'iOS', browser: 'Discord iOS', device: 'Discord iOS' },
      platform: 'ios'
    };
  }
  if (d === 'browser' || d === 'web') {
    return {
      wsProps: { os: 'Windows', browser: 'Chrome', device: '' },
      platform: 'desktop'
    };
  }
  if (d === 'ps4' || d === 'ps5' || d === 'playstation') {
    return {
      wsProps: { os: 'Windows', browser: 'Discord Client', device: '' },
      platform: d === 'ps4' ? 'ps4' : 'ps5'
    };
  }
  if (d === 'xbox') {
    return {
      wsProps: { os: 'Windows', browser: 'Discord Client', device: '' },
      platform: 'xbox'
    };
  }
  return {
    wsProps: { os: 'Windows', browser: 'Discord Client', device: '' },
    platform: 'desktop'
  };
}

function normalizeDiscordCdnUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'media.discordapp.net' || u.hostname === 'cdn.discordapp.com') {
      const cleanPath = u.pathname.replace(/^\/+/, '');
      if (cleanPath.startsWith('attachments/') || cleanPath.startsWith('ephemeral-attachments/')) {
        return `mp:${cleanPath}${u.search || ''}`;
      }
      return rawUrl;
    }
    if (u.hostname.includes('imgur.com') && !u.hostname.startsWith('i.')) {
      const id = u.pathname.replace(/^\/+(gallery\/|a\/)?/, '').split('/')[0];
      if (id && /^[a-zA-Z0-9]{5,10}$/.test(id)) {
        const isGif = /\.gif/i.test(rawUrl) || u.pathname.toLowerCase().includes('gif');
        return `https://i.imgur.com/${id}.${isGif ? 'gif' : 'png'}`;
      }
    }
  } catch (e) {}
  return rawUrl;
}

async function fetchDiscordExternalAsset(token, appId, imageUrl) {
  try {
    const resp = await fetchWithTimeout(`https://discord.com/api/v9/applications/${appId}/external-assets`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({ urls: [imageUrl] })
    }, 3500);
    if (!resp.ok) return '';
    const data = await resp.json();
    if (Array.isArray(data) && data[0]?.external_asset_path) {
      const p = data[0].external_asset_path;
      return p.startsWith('mp:') ? p : `mp:${p}`;
    }
  } catch (e) {}
  return '';
}

function buildCandidateImageUrls(rawUrl) {
  const candidates = [];
  const add = u => {
    if (u && /^https?:\/\//i.test(u) && !candidates.includes(u)) {
      candidates.push(u);
    }
  };
  add(rawUrl);

  try {
    const u = new URL(rawUrl);
    const isGifHint = /\.gif(\?|&|$)/i.test(rawUrl) || u.hostname.includes('tenor.com') || u.hostname.includes('giphy.com');

    if (u.hostname.includes('imgur.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      const baseId = last.replace(/\.(png|jpe?g|gif|webp|mp4)$/i, '');
      if (baseId) {
        const order = isGifHint
          ? ['.gif', '.webp', '.png', '.jpg', '.jpeg']
          : ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
        order.forEach(ext => add(`https://i.imgur.com/${baseId}${ext}`));
      }
    }

    if (u.hostname.includes('tenor.com')) {
      const slug = u.pathname.split('-').pop() || '';
      const digits = slug.match(/(\d{5,})/);
      if (digits && digits[1]) {
        add(`https://media.tenor.com/images/${digits[1]}/tenor.gif`);
        add(`https://c.tenor.com/${digits[1]}/tenor.gif`);
        add(`https://media1.tenor.com/m/${digits[1]}/tenor.gif`);
      }
    }

    if (u.hostname.includes('giphy.com')) {
      const parts = u.pathname.split('-').filter(Boolean);
      const lastSegment = parts[parts.length - 1] || '';
      const gifId = lastSegment.split('/')[0].replace(/[^a-zA-Z0-9]/g, '');
      if (gifId && gifId.length >= 4) {
        add(`https://media.giphy.com/media/${gifId}/giphy.gif`);
        add(`https://i.giphy.com/media/${gifId}/giphy.gif`);
      }
    }

    if (u.hostname === 'github.com' && u.pathname.includes('/blob/')) {
      add(rawUrl.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/'));
    }
  } catch (e) {}

  return candidates.slice(0, 5);
}

async function resolveSingleUrlFast(client, candidateApps, activeToken, candUrl) {
  // Race getExternal & REST external-assets across candidate apps in parallel for fast resolution
  const tasks = [];

  for (const candidateId of candidateApps) {
    if (typeof RichPresence.getExternal === 'function') {
      tasks.push(
        Promise.race([
          RichPresence.getExternal(client, candidateId, candUrl),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2200))
        ])
          .then(res => {
            if (Array.isArray(res) && res[0]?.external_asset_path) {
              const p = res[0].external_asset_path;
              return p.startsWith('mp:') ? p : `mp:${p}`;
            }
            return '';
          })
          .catch(() => '')
      );
    }

    if (activeToken) {
      tasks.push(
        fetchDiscordExternalAsset(activeToken, candidateId, candUrl).catch(() => '')
      );
    }
  }

  if (tasks.length === 0) return '';

  // Return the first non-empty resolved asset immediately
  return new Promise(resolve => {
    let settled = false;
    let remaining = tasks.length;
    tasks.forEach(p => {
      p.then(val => {
        if (val && !settled) {
          settled = true;
          resolve(val);
        } else {
          remaining--;
          if (remaining <= 0 && !settled) {
            settled = true;
            resolve('');
          }
        }
      });
    });
  });
}

async function resolveExternalImage(client, appId, imageInput, token = '') {
  if (!imageInput) return '';
  let targetUrl = sanitizeImageInput(imageInput);
  if (!targetUrl) return '';

  if (targetUrl.startsWith('data:')) {
    const uploaded = await uploadDataUrlToPublicHost(targetUrl);
    if (!uploaded) return '';
    targetUrl = uploaded;
  }

  if (targetUrl.startsWith('mp:')) return targetUrl;
  if (!/^https?:\/\//i.test(targetUrl)) return targetUrl;

  const normalizedDirect = normalizeDiscordCdnUrl(targetUrl);
  if (normalizedDirect.startsWith('mp:')) return normalizedDirect;

  const urlCandidates = buildCandidateImageUrls(normalizedDirect);
  const candidateApps = Array.from(new Set([appId, ...FALLBACK_ASSET_APP_IDS]));
  const activeToken = token || client?.token || '';

  for (const candUrl of urlCandidates) {
    const cacheKey = `${appId}:${candUrl}`;
    const cached = externalAssetCache.get(cacheKey);
    if (cached && (!/\.gif/i.test(candUrl) || cached.includes('.gif') || cached.includes('external'))) {
      return cached;
    }

    const resolved = await resolveSingleUrlFast(client, candidateApps, activeToken, candUrl);
    if (resolved) {
      externalAssetCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  // Guaranteed Discord CDN native asset fallback (uploads GIF/image directly to Discord CDN -> mp:attachments/...)
  const nativeDiscordAsset = await uploadGifOrImageToDiscordCdn(client, activeToken, urlCandidates[0] || normalizedDirect);
  if (nativeDiscordAsset) {
    externalAssetCache.set(`${appId}:${normalizedDirect}`, nativeDiscordAsset);
    return nativeDiscordAsset;
  }

  return '';
}

async function buildRichPresence(client, payload, fallbackDevice, token = '') {
  const resolvedAppId = (payload.appId && String(payload.appId).trim()) || '463151177836658699';
  const { platform } = resolveDeviceProperties(payload.device || fallbackDevice);

  const rpc = new RichPresence(client)
    .setApplicationId(resolvedAppId)
    .setType(payload.activityType || 'PLAYING')
    .setName(payload.name.trim());

  if (typeof rpc.setPlatform === 'function' && (platform === 'ps4' || platform === 'ps5' || platform === 'xbox')) {
    try { rpc.setPlatform(platform); } catch (e) {}
  }

  if (payload.details && payload.details.trim()) {
    rpc.setDetails(payload.details.trim().slice(0, 128));
  }
  if (payload.state && payload.state.trim()) {
    rpc.setState(payload.state.trim().slice(0, 128));
  }

  const pSize = parseInt(payload.partySize, 10);
  const pMax = parseInt(payload.partyMax, 10);
  const cleanPartyId = (payload.partyId && String(payload.partyId).trim())
    ? String(payload.partyId).trim().slice(0, 128)
    : '';
  const cleanPartySecret = (payload.partySecret && String(payload.partySecret).trim())
    ? String(payload.partySecret).trim().slice(0, 128)
    : '';

  const hasValidPartySize = !isNaN(pSize) && !isNaN(pMax) && pSize > 0 && pMax >= pSize;
  if (hasValidPartySize || cleanPartyId) {
    const partyObj = {};
    if (hasValidPartySize) {
      partyObj.max = pMax;
      partyObj.current = pSize;
    }
    if (cleanPartyId) {
      partyObj.id = cleanPartyId;
    }
    try {
      rpc.setParty(partyObj);
    } catch (e) {}
  }

  if (cleanPartySecret) {
    if (typeof rpc.setSecrets === 'function') {
      try {
        rpc.setSecrets({ join: cleanPartySecret });
      } catch (e) {}
    } else {
      rpc.secrets = { ...(rpc.secrets || {}), join: cleanPartySecret };
    }
  }

  const now = Date.now();
  if (!payload._anchoredStart) {
    if (payload.timestampMode === 'now') {
      payload._anchoredStart = now;
    } else if (payload.timestampMode === 'elapsed_1h') {
      payload._anchoredStart = now - 3600000;
    } else if (payload.timestampMode === 'custom') {
      if (payload.customStartMins !== '' && !isNaN(payload.customStartMins)) {
        payload._anchoredStart = now - (parseFloat(payload.customStartMins) * 60 * 1000);
      } else {
        payload._anchoredStart = now;
      }
    }
  }
  if (payload.timestampMode && payload.timestampMode !== 'none' && payload._anchoredStart) {
    rpc.setStartTimestamp(payload._anchoredStart);
  }
  if (payload.timestampMode === 'custom' && payload.customEndMins !== '' && !isNaN(payload.customEndMins)) {
    if (!payload._anchoredEnd) {
      payload._anchoredEnd = now + (parseFloat(payload.customEndMins) * 60 * 1000);
    }
    rpc.setEndTimestamp(payload._anchoredEnd);
  }

  const rawLarge = sanitizeImageInput(payload.largeImage);
  const rawSmall = sanitizeImageInput(payload.smallImage);

  const [resolvedLarge, resolvedSmall] = await Promise.all([
    rawLarge ? resolveExternalImage(client, resolvedAppId, rawLarge, token) : Promise.resolve(''),
    rawSmall ? resolveExternalImage(client, resolvedAppId, rawSmall, token) : Promise.resolve('')
  ]);

  if (resolvedLarge) {
    rpc.setAssetsLargeImage(resolvedLarge);
    if (payload.largeText && payload.largeText.trim()) {
      rpc.setAssetsLargeText(payload.largeText.trim().slice(0, 128));
    }
  }

  if (resolvedSmall) {
    rpc.setAssetsSmallImage(resolvedSmall);
    if (payload.smallText && payload.smallText.trim()) {
      rpc.setAssetsSmallText(payload.smallText.trim().slice(0, 128));
    }
  }

  if (Array.isArray(payload.buttons)) {
    const validButtons = [];
    payload.buttons.slice(0, 2).forEach(btn => {
      if (btn && btn.label && btn.label.trim() && btn.url && btn.url.trim()) {
        let validUrl = btn.url.trim();
        if (!/^https?:\/\//i.test(validUrl)) validUrl = 'https://' + validUrl;
        try {
          new URL(validUrl);
          const cleanLabel = btn.label.trim().slice(0, 32);
          rpc.addButton(cleanLabel, validUrl);
          validButtons.push({ label: cleanLabel, url: validUrl });
        } catch (e) {}
      }
    });

    if (validButtons.length > 0 && Array.isArray(rpc.buttons)) {
      rpc.buttons = validButtons.map(b => b.label);
      rpc.metadata = { button_urls: validButtons.map(b => b.url) };
    }
  }

  return {
    rpc,
    imageWarnings: {
      largeFailed: Boolean(rawLarge && !resolvedLarge),
      smallFailed: Boolean(rawSmall && !resolvedSmall)
    }
  };
}

async function syncFullDiscordPresence(entry) {
  if (!entry.client || !entry.info.connected) return { imageWarnings: {} };

  const statusVal = (entry.activeRPC && entry.activeRPC.statusType)
    || (entry.customStatus && entry.customStatus.statusType)
    || 'online';

  try {
    entry.client.user.setStatus(statusVal);
  } catch (e) {}

  const activities = [];
  let imageWarnings = {};

  if (entry.customStatus && (entry.customStatus.text || entry.customStatus.emoji)) {
    const customAct = {
      name: 'Custom Status',
      type: 4,
      state: (entry.customStatus.text || '').trim().slice(0, 128) || undefined
    };
    if (entry.customStatus.emojiId) {
      customAct.emoji = {
        id: entry.customStatus.emojiId,
        name: entry.customStatus.emoji || 'emoji',
        animated: Boolean(entry.customStatus.emojiAnimated)
      };
    } else if (entry.customStatus.emoji && entry.customStatus.emoji.trim()) {
      customAct.emoji = { name: entry.customStatus.emoji.trim() };
    }
    activities.push(customAct);
    entry.info.customStatus = entry.customStatus;
  } else {
    entry.info.customStatus = null;
  }

  if (entry.activeRPC && entry.activeRPC.name && entry.activeRPC.name.trim()) {
    const built = await buildRichPresence(entry.client, entry.activeRPC, entry.device, entry.token);
    imageWarnings = built.imageWarnings;
    activities.push(built.rpc);
    entry.info.activeGame = entry.activeRPC.name.trim();
    entry.info.activeDetails = entry.activeRPC.details ? entry.activeRPC.details.trim() : null;
  } else {
    entry.info.activeGame = null;
    entry.info.activeDetails = null;
  }

  // Clear stale activity first so Discord never keeps stuck/old image assets when changing images or GIFs
  try {
    entry.client.user.setActivity(null);
  } catch (e) {}

  try {
    entry.client.user.setPresence({
      status: statusVal,
      activities
    });
  } catch (e) {
    if (activities.length > 0) {
      entry.client.user.setActivity(activities[activities.length - 1]);
    } else {
      entry.client.user.setActivity(null);
    }
  }

  return { imageWarnings };
}

function start247KeepAlive(entry) {
  if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
  entry.keepAliveTimer = setInterval(async () => {
    if (!entry.token) return;
    if (!entry.client || !entry.info.connected) {
      if (!entry.reconnecting) {
        entry.reconnecting = true;
        try {
          await loginSessionWithToken(entry, entry.token, 1, entry.device);
        } catch (e) {}
        entry.reconnecting = false;
      }
    }
  }, 4 * 60 * 1000);
}

function cleanToken(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/^(Bearer|Bot|mfa\.)\s+/i, (m, p1) => (p1.toLowerCase() === 'mfa.' ? 'mfa.' : ''))
    .replace(/^["'`\s\u200B-\u200D\uFEFF]+|["'`\s\u200B-\u200D\uFEFF]+$/g, '')
    .trim();
}

async function verifyDiscordTokenViaRest(token) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetchWithTimeout('https://discord.com/api/v9/users/@me', {
        headers: {
          Authorization: token,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        }
      }, 8000);
      if (resp.status === 401) {
        throw new Error('Invalid or expired Discord token. Copy a fresh token and try again.');
      }
      if (resp.status === 429 && attempt < 3) {
        await new Promise(r => setTimeout(r, 400 * attempt));
        continue;
      }
      if (resp.ok) {
        return await resp.json();
      }
      // If Discord REST temporarily blocks cloud IP (403/5xx), still allow Gateway login to proceed
      if (attempt === 3) {
        return { id: 'discord-user', username: 'Discord User', avatar: null };
      }
    } catch (e) {
      if (e.message && e.message.includes('Invalid or expired')) throw e;
      if (attempt === 3) {
        return { id: 'discord-user', username: 'Discord User', avatar: null };
      }
      await new Promise(r => setTimeout(r, 300 * attempt));
    }
  }
  return { id: 'discord-user', username: 'Discord User', avatar: null };
}

async function loginSessionWithToken(entry, rawToken, attempt = 1, deviceOverride = null) {
  const token = cleanToken(rawToken);
  if (!token) throw new Error('Please paste your Discord token first.');

  // Fast REST check first so invalid tokens or Discord blocks report immediately & accurately
  const userProfile = await verifyDiscordTokenViaRest(token);

  if (entry.client) {
    try {
      entry.client.removeAllListeners();
      entry.client.destroy();
    } catch (e) {}
    entry.client = null;
    await new Promise(r => setTimeout(r, 200));
  }

  const activeDevice = deviceOverride || entry.device || 'desktop';
  const { wsProps } = resolveDeviceProperties(activeDevice);

  return new Promise((resolve, reject) => {
    let settled = false;
    const client = new Client({
      checkUpdate: false,
      ws: {
        properties: wsProps
      }
    });

    const finishSuccess = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      entry.token = token;
      entry.client = client;
      entry.device = activeDevice;

      const fallbackAvatar = userProfile.avatar
        ? `https://cdn.discordapp.com/avatars/${userProfile.id}/${userProfile.avatar}.${userProfile.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
        : 'https://cdn.discordapp.com/embed/avatars/0.png';

      entry.info = {
        connected: true,
        user: client.user?.tag || userProfile.username || 'Discord User',
        userId: client.user?.id || userProfile.id,
        avatar: client.user ? client.user.displayAvatarURL({ format: 'png', size: 128 }) : fallbackAvatar,
        activeGame: null,
        activeDetails: null,
        customStatus: entry.customStatus,
        afkResponder: { ...entry.afkConfig }
      };

      try {
        await syncFullDiscordPresence(entry);
      } catch (e) {}
      start247KeepAlive(entry);
      resolve(entry.info);
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch (e) {}
      reject(new Error('Discord Gateway timed out. Click Connect again.'));
    }, 25000);

    client.once('ready', finishSuccess);
    client.once('shardReady', finishSuccess);

    client.on('messageCreate', async (msg) => {
      try {
        if (!entry.afkConfig?.enabled) return;
        if (!msg.author || msg.author.id === client.user?.id || msg.author.bot) return;
        if (msg.channel?.type !== 'DM') return;

        const now = Date.now();
        const lastReply = entry.afkCooldowns.get(msg.author.id) || 0;
        if (now - lastReply < 5 * 60 * 1000) return;

        entry.afkCooldowns.set(msg.author.id, now);
        const replyText = (entry.afkConfig.message || "I'm away right now, I'll reply soon!").trim();
        if (replyText) {
          await msg.channel.send(replyText);
        }
      } catch (e) {}
    });

    client.on('disconnect', () => {
      entry.info.connected = false;
    });

    client.on('error', () => {});

    client.login(token).catch(async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { client.destroy(); } catch (e) {}

      const rawMsg = String(err?.message || '');
      if (/TOKEN_INVALID|Incorrect login details/i.test(rawMsg)) {
        return reject(new Error('Invalid or expired Discord token. Copy a fresh token and try again.'));
      }

      if (attempt < 2) {
        try {
          await new Promise(r => setTimeout(r, 400));
          const retryRes = await loginSessionWithToken(entry, token, attempt + 1, activeDevice);
          return resolve(retryRes);
        } catch (retryErr) {
          return reject(retryErr);
        }
      }

      reject(new Error(rawMsg ? `Discord Gateway error: ${rawMsg}` : 'Could not connect to Discord Gateway. Try again.'));
    });
  });
}

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
  } catch (err) {}
}
loadGamesCache();

async function searchAnimeEverywhere(searchTerm) {
  const query = (searchTerm || '').trim();

  try {
    const randomPage = Math.floor(Math.random() * 12) + 1;
    const gqlQuery = query
      ? `query ($search: String) { Page(page: 1, perPage: 20) { media(search: $search, type: ANIME, sort: POPULARITY_DESC) { title { romaji english } episodes coverImage { extraLarge large } } } }`
      : `query ($page: Int) { Page(page: $page, perPage: 20) { media(type: ANIME, sort: TRENDING_DESC) { title { romaji english } episodes coverImage { extraLarge large } } } }`;
    const aniResp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        query: gqlQuery,
        variables: query ? { search: query } : { page: randomPage }
      })
    });
    if (aniResp.ok) {
      const aniData = await aniResp.json();
      const mediaList = aniData?.data?.Page?.media || [];
      if (mediaList.length > 0) {
        return mediaList.map(m => ({
          title: m.title.english || m.title.romaji,
          episodes: m.episodes || 24,
          subtitle: m.episodes ? `Episode 1 of ${m.episodes} • Crunchyroll` : 'Episode 1 • Crunchyroll',
          album: m.title.romaji || m.title.english,
          icon: m.coverImage?.extraLarge || m.coverImage?.large || CRUNCHYROLL_LOGO_URL
        }));
      }
    }
  } catch (e) {}

  try {
    const url = query
      ? `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=20`
      : `https://api.jikan.moe/v4/top/anime?page=${Math.floor(Math.random() * 8) + 1}&limit=20`;
    const jikanResp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 NexusRPC/3.0' } });
    if (jikanResp.ok) {
      const jikanData = await jikanResp.json();
      if (Array.isArray(jikanData.data) && jikanData.data.length > 0) {
        return jikanData.data.map(anime => ({
          title: anime.title_english || anime.title,
          episodes: anime.episodes || 24,
          subtitle: anime.episodes ? `Episode 1 of ${anime.episodes} • Crunchyroll` : 'Episode 1 • Crunchyroll',
          album: anime.title,
          icon: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || CRUNCHYROLL_LOGO_URL
        }));
      }
    }
  } catch (e) {}

  return [];
}

const RANDOM_MUSIC_SEEDS = ['pop', 'rock', 'lofi', 'synthwave', 'hip hop', 'electronic', 'indie', 'jazz', 'chill', 'night'];
const RANDOM_SHOW_SEEDS = ['star', 'night', 'dark', 'love', 'world', 'city', 'fire', 'shadow', 'king', 'time', 'game', 'war'];

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Discord OAuth2 Config (set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and optional DISCORD_REDIRECT_URI in env)
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '1575508109617668147').trim();
const DISCORD_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || '').trim();
const DISCORD_OAUTH_SCOPES = 'identify sdk.social_layer_presence openid';
const oauthStateStore = new Map();

function getSessionFromReqOrQuery(req) {
  const qSid = req.query?.sid;
  if (qSid && /^[a-zA-Z0-9_-]{12,64}$/.test(String(qSid))) {
    return String(qSid);
  }
  return getSessionId(req);
}

function getOAuthRedirectUri(req) {
  if (process.env.DISCORD_REDIRECT_URI && process.env.DISCORD_REDIRECT_URI.trim()) {
    return process.env.DISCORD_REDIRECT_URI.trim();
  }
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  if (!host || host.includes('nexus-rpc.onrender.com')) {
    return 'https://nexus-rpc.onrender.com/auth/discord/callback';
  }
  return `${proto}://${host}/auth/discord/callback`;
}

app.get('/auth/discord/config', (req, res) => {
  res.json({
    enabled: Boolean(DISCORD_CLIENT_ID),
    clientId: DISCORD_CLIENT_ID,
    clientIdConfigured: Boolean(DISCORD_CLIENT_ID),
    secretConfigured: Boolean(DISCORD_CLIENT_SECRET),
    scopes: DISCORD_OAUTH_SCOPES,
    redirectUri: getOAuthRedirectUri(req)
  });
});

app.get('/auth/discord/login', (req, res) => {
  const sid = getSessionFromReqOrQuery(req);
  getOrCreateSession(sid);
  const state = crypto.randomBytes(20).toString('hex');
  oauthStateStore.set(state, { sid, createdAt: Date.now() });
  // Purge expired states (>10 mins)
  for (const [k, v] of oauthStateStore.entries()) {
    if (Date.now() - v.createdAt > 10 * 60 * 1000) oauthStateStore.delete(k);
  }
  const redirectUri = getOAuthRedirectUri(req);
  const authUrl = new URL('https://discord.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', DISCORD_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', DISCORD_OAUTH_SCOPES);
  authUrl.searchParams.set('state', state);
  return res.redirect(authUrl.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) {
    return res.redirect('/?auth_error=' + encodeURIComponent(String(error)));
  }
  if (!code || !state || !oauthStateStore.has(String(state))) {
    return res.redirect('/?auth_error=' + encodeURIComponent('Invalid or expired OAuth state. Please try again.'));
  }
  const stateData = oauthStateStore.get(String(state));
  oauthStateStore.delete(String(state));
  const sid = stateData.sid || getSessionId(req);
  const entry = getOrCreateSession(sid);

  try {
    const redirectUri = getOAuthRedirectUri(req);
    let oauthUser = null;
    let accessToken = null;

    if (DISCORD_CLIENT_SECRET) {
      const tokenResp = await fetchWithTimeout('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: redirectUri
        })
      }, 8000);

      if (tokenResp.ok) {
        const tokenJson = await tokenResp.json();
        accessToken = tokenJson?.access_token || null;
      }
    }

    if (accessToken) {
      const meResp = await fetchWithTimeout('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` }
      }, 8000);
      if (meResp.ok) {
        oauthUser = await meResp.json();
      }
    }

    if (!oauthUser || !oauthUser.id) {
      const codeDigest = crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 12);
      oauthUser = {
        id: codeDigest,
        username: 'Discord Member',
        global_name: 'Discord Member',
        avatar: null
      };
    }

    const avatarUrl = oauthUser.avatar
      ? `https://cdn.discordapp.com/avatars/${oauthUser.id}/${oauthUser.avatar}.${oauthUser.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${(BigInt('0x' + Buffer.from(String(oauthUser.id)).toString('hex').slice(-8)) >> 22n) % 6n}.png`;

    entry.oauthAccessToken = accessToken;
    entry.oauthUser = {
      id: oauthUser.id,
      username: oauthUser.global_name || oauthUser.username || 'Discord User',
      tag: oauthUser.discriminator && oauthUser.discriminator !== '0'
        ? `${oauthUser.username}#${oauthUser.discriminator}`
        : (oauthUser.global_name || oauthUser.username || 'Discord User'),
      avatar: avatarUrl
    };

    entry.info = {
      ...entry.info,
      connected: true,
      oauthConnected: true,
      user: entry.oauthUser.tag,
      userId: entry.oauthUser.id,
      avatar: entry.oauthUser.avatar
    };

    return res.redirect(`/?oauth_success=1&sid=${encodeURIComponent(sid)}`);
  } catch (e) {
    return res.redirect('/?auth_error=' + encodeURIComponent('Discord OAuth login failed. Try again.'));
  }
});

app.get('/favicon.ico', (req, res) => {
  res.redirect(302, NEXUS_LOGO_URL);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

/* --- UPLOAD IMAGE / GIF ENDPOINT --- */
app.get('/i/:file', (req, res) => {
  const fileKey = String(req.params.file || '').replace(/[^a-zA-Z0-9._-]/g, '');
  const item = hostedMemoryImages.get(fileKey);
  if (!item) {
    return res.status(404).send('Not found');
  }
  res.setHeader('Content-Type', item.mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.send(item.buffer);
});

app.post('/api/upload-image', async (req, res) => {
  try {
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Select a valid PNG, JPG, WEBP, or GIF file.' });
    }

    const hostedUrl = await uploadDataUrlToPublicHost(dataUrl, req);
    if (!hostedUrl) {
      return res.status(502).json({ error: 'Could not upload image right now. Try again or paste a direct URL.' });
    }
    return res.json({ success: true, url: hostedUrl });
  } catch (e) {
    return res.status(500).json({ error: 'Upload failed. Try again.' });
  }
});

/* --- EXTRA TAB ENDPOINTS (Per-Session Isolated) --- */
app.post('/api/extra/custom-status', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const { text, emoji, statusType, clear } = req.body || {};
  if (clear) {
    entry.customStatus = null;
  } else {
    const parsedEmoji = parseDiscordEmojiInput(emoji);
    entry.customStatus = {
      text: String(text || '').trim().slice(0, 128),
      rawEmoji: parsedEmoji ? parsedEmoji.rawEmoji : '',
      emoji: parsedEmoji ? parsedEmoji.name : '',
      emojiId: parsedEmoji ? parsedEmoji.id : null,
      emojiAnimated: parsedEmoji ? parsedEmoji.animated : false,
      statusType: statusType || (entry.activeRPC && entry.activeRPC.statusType) || 'online'
    };
  }

  await syncFullDiscordPresence(entry);
  return res.json({ success: true, session: entry.info });
});

app.post('/api/extra/afk', (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const { enabled, message } = req.body || {};
  entry.afkConfig = {
    enabled: Boolean(enabled),
    message: String(message || "I'm away right now, I'll reply soon!").trim().slice(0, 400)
  };
  entry.afkCooldowns.clear();
  entry.info.afkResponder = { ...entry.afkConfig };

  return res.json({ success: true, session: entry.info });
});

app.post('/api/extra/hypesquad', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.token) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const houseMap = { bravery: 1, brilliance: 2, balance: 3 };
  const houseKey = String(req.body?.house || '').toLowerCase();

  try {
    if (houseKey === 'none') {
      const resp = await fetch('https://discord.com/api/v9/hypesquad/online', {
        method: 'DELETE',
        headers: { Authorization: entry.token }
      });
      if (!resp.ok && resp.status !== 204) {
        return res.status(400).json({ error: 'Could not update HypeSquad badge.' });
      }
      return res.json({ success: true, house: 'none' });
    }

    const houseId = houseMap[houseKey];
    if (!houseId) {
      return res.status(400).json({ error: 'Select a valid HypeSquad house.' });
    }

    const resp = await fetch('https://discord.com/api/v9/hypesquad/online', {
      method: 'POST',
      headers: {
        Authorization: entry.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ house_id: houseId })
    });

    if (!resp.ok && resp.status !== 204) {
      return res.status(400).json({ error: 'Discord rejected the HypeSquad change.' });
    }

    return res.json({ success: true, house: houseKey });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update HypeSquad house.' });
  }
});

app.get('/api/media-search', async (req, res) => {
  const platform = (req.query.platform || 'spotify').toLowerCase();
  const query = (req.query.q || '').trim();

  try {
    if (platform === 'spotify' || platform === 'youtube') {
      const effectiveQuery = query || RANDOM_MUSIC_SEEDS[Math.floor(Math.random() * RANDOM_MUSIC_SEEDS.length)];
      const resp = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(effectiveQuery)}&media=music&limit=24`);
      const data = await resp.json();
      let results = (data.results || []).map(item => ({
        title: item.trackName || item.collectionName,
        subtitle: platform === 'youtube' ? `YouTube • ${item.artistName}` : `by ${item.artistName}`,
        album: item.collectionName || item.trackName,
        icon: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb')
      }));
      if (!query) results = shuffleArray(results).slice(0, 18);
      return res.json({ results });
    }

    if (platform === 'netflix') {
      let rawShows = [];
      if (query) {
        const resp = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
        const data = await resp.json();
        rawShows = (data || []).map(entry => entry.show).filter(Boolean);
      } else {
        const randomPage = Math.floor(Math.random() * 15);
        const resp = await fetch(`https://api.tvmaze.com/shows?page=${randomPage}`);
        if (resp.ok) {
          const pageData = await resp.json();
          rawShows = shuffleArray(pageData || []).slice(0, 20);
        }
        if (rawShows.length === 0) {
          const fallbackSeed = RANDOM_SHOW_SEEDS[Math.floor(Math.random() * RANDOM_SHOW_SEEDS.length)];
          const fbResp = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(fallbackSeed)}`);
          const fbData = await fbResp.json();
          rawShows = (fbData || []).map(entry => entry.show).filter(Boolean);
        }
      }

      const results = rawShows.slice(0, 20).map(s => ({
        title: s.name,
        subtitle: s.genres && s.genres.length ? s.genres.join(' • ') : 'Netflix Series',
        album: s.name,
        icon: s.image ? (s.image.original || s.image.medium) : ''
      }));
      return res.json({ results });
    }

    if (platform === 'crunchyroll') {
      let results = await searchAnimeEverywhere(query);
      if (!query) results = shuffleArray(results);
      return res.json({ results });
    }

    return res.json({ results: [] });
  } catch (err) {
    return res.json({ results: [] });
  }
});

app.get('/api/youtube-info', async (req, res) => {
  const rawUrl = (req.query.url || '').trim();
  if (!rawUrl) return res.status(400).json({ error: 'Paste a YouTube video link first.' });

  let videoId = null;
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    if (u.hostname.includes('youtu.be')) {
      videoId = u.pathname.replace('/', '').split('/')[0];
    } else if (u.searchParams.get('v')) {
      videoId = u.searchParams.get('v');
    } else if (u.pathname.includes('/shorts/')) {
      videoId = u.pathname.split('/shorts/')[1]?.split('/')[0];
    } else if (u.pathname.includes('/live/')) {
      videoId = u.pathname.split('/live/')[1]?.split('/')[0];
    }
  } catch (e) {}

  if (!videoId) {
    return res.status(400).json({ error: 'That does not look like a valid YouTube link.' });
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const fallbackThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const oembedResp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`);
    if (oembedResp.ok) {
      const data = await oembedResp.json();
      return res.json({
        videoId,
        url: canonicalUrl,
        title: data.title || 'YouTube Video',
        author: data.author_name || 'YouTube Creator',
        thumbnail: data.thumbnail_url || fallbackThumb
      });
    }
  } catch (e) {}

  try {
    const noembedResp = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(canonicalUrl)}`);
    if (noembedResp.ok) {
      const data = await noembedResp.json();
      return res.json({
        videoId,
        url: canonicalUrl,
        title: data.title || 'YouTube Video',
        author: data.author_name || 'YouTube Creator',
        thumbnail: data.thumbnail_url || fallbackThumb
      });
    }
  } catch (e) {}

  return res.json({
    videoId,
    url: canonicalUrl,
    title: 'Watching YouTube Video',
    author: 'YouTube',
    thumbnail: fallbackThumb
  });
});

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
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  res.json({
    sessionId: sid,
    session: entry.info,
    oauthUser: entry.oauthUser || null,
    activeRPC: entry.activeRPC
  });
});

app.post('/connect-token', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);
  const token = cleanToken(req.body?.token);

  if (!token) {
    return res.status(400).json({ error: 'Please paste your Discord token first.' });
  }

  try {
    const info = await loginSessionWithToken(entry, token);
    res.json({
      success: true,
      sessionId: sid,
      session: info,
      activeRPC: entry.activeRPC
    });
  } catch (err) {
    res.status(401).json({ error: err.message || 'Could not connect with that token.' });
  }
});

app.post('/disconnect', (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
  if (entry.client) {
    try {
      entry.client.removeAllListeners();
      entry.client.destroy();
    } catch (e) {}
    entry.client = null;
  }

  entry.token = null;
  entry.activeRPC = null;
  entry.info = defaultInfo();
  res.json({ success: true });
});

app.post('/set-rpc', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  const payload = req.body;
  if (!payload.name || !payload.name.trim()) {
    return res.status(400).json({ error: 'Give your activity a name first.' });
  }

  try {
    const prevDevice = entry.device || 'desktop';
    const nextDevice = payload.device || prevDevice;
    const prevRpc = entry.activeRPC;
    const sameActivity = prevRpc && prevRpc.name && payload.name &&
      prevRpc.name.trim().toLowerCase() === payload.name.trim().toLowerCase() &&
      prevRpc.timestampMode === payload.timestampMode;
    if (sameActivity && prevRpc._anchoredStart && !payload._anchoredStart) {
      payload._anchoredStart = prevRpc._anchoredStart;
    }
    entry.device = nextDevice;
    entry.activeRPC = payload;

    let syncResult = { imageWarnings: {} };
    if (nextDevice !== prevDevice && entry.token) {
      await loginSessionWithToken(entry, entry.token, 1, nextDevice);
    } else {
      syncResult = await syncFullDiscordPresence(entry);
    }

    return res.json({
      success: true,
      session: entry.info,
      activeRPC: entry.activeRPC,
      imageWarnings: syncResult.imageWarnings || {}
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not update your status. Try again.' });
  }
});

async function forceClearActivityOnClient(entry) {
  if (!entry || !entry.client) return;
  const statusVal = (entry.customStatus && entry.customStatus.statusType) || 'online';
  const activities = [];
  if (entry.customStatus && (entry.customStatus.text || entry.customStatus.emoji)) {
    const customAct = {
      name: 'Custom Status',
      type: 4,
      state: (entry.customStatus.text || '').trim().slice(0, 128) || undefined
    };
    if (entry.customStatus.emojiId) {
      customAct.emoji = {
        id: entry.customStatus.emojiId,
        name: entry.customStatus.emoji || 'emoji',
        animated: Boolean(entry.customStatus.emojiAnimated)
      };
    } else if (entry.customStatus.emoji && entry.customStatus.emoji.trim()) {
      customAct.emoji = { name: entry.customStatus.emoji.trim() };
    }
    activities.push(customAct);
  }
  try { entry.client.user.setActivity(null); } catch (e) {}
  try {
    entry.client.user.setPresence({ status: statusVal, activities });
  } catch (e) {}
  try {
    if (entry.client.ws && entry.client.ws.shards) {
      entry.client.ws.shards.forEach(shard => {
        try {
          if (shard && typeof shard.send === 'function') {
            shard.send({
              op: 3,
              d: {
                since: statusVal === 'idle' ? Date.now() : null,
                activities,
                status: statusVal,
                afk: statusVal === 'idle'
              }
            });
          }
        } catch (e) {}
      });
    }
  } catch (e) {}
}

app.post('/clear-rpc', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  entry.activeRPC = null;
  entry.info.activeGame = null;
  entry.info.activeDetails = null;

  if (entry.info.connected && entry.client) {
    await forceClearActivityOnClient(entry);
    await new Promise(r => setTimeout(r, 120));
    await forceClearActivityOnClient(entry);
  }

  res.json({
    success: true,
    session: entry.info
  });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Image file is too large. Keep it under 10 MB.' });
  }
  if (!res.headersSent) {
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
  return next();
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.message || err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus RPC running 24/7 on port ${PORT}`));
