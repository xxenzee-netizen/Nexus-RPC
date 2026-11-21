const express = require('express');
const path = require('path');
const crypto = require('crypto');
const selfbotLib = require('discord.js-selfbot-v13');
const { Client, RichPresence } = selfbotLib;
const SpotifyRPC = selfbotLib.SpotifyRPC; // native Spotify-style activity (Play on Spotify button + logo)

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
  if (/^data:[a-zA-Z0-9.+\/-]*;base64,/i.test(trimmed)) return trimmed;
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

/* ====================================================================
   IMAGE / GIF PIPELINE (rewritten)
   upload -> public URL -> Discord external-assets -> mp:external/...
   ==================================================================== */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ASSET_CACHE_TTL = 3 * 60 * 60 * 1000;
const MAX_HOSTED_IMAGES = 150;

// Public base URL of THIS server (used for the /i/ self-host fallback).
// Set PUBLIC_URL in your env to force it, otherwise it is learned from incoming requests.
let publicBaseUrl = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

function isPrivateHost(hostWithPort) {
  const h = String(hostWithPort || '').toLowerCase().replace(/:\d+$/, '');
  return !h || h === 'localhost' || h === '[::1]' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

app.use((req, res, next) => {
  if (!process.env.PUBLIC_URL) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host && !isPrivateHost(host)) {
      const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
      publicBaseUrl = `${proto}://${host}`;
    }
  }
  next();
});

function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return '';
  const head6 = buf.slice(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}

function extFromMime(mime) {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[mime] || 'png';
}

function selfHostBuffer(buffer, mime) {
  if (!publicBaseUrl || buffer.length > MAX_IMAGE_BYTES) return '';
  while (hostedMemoryImages.size >= MAX_HOSTED_IMAGES) {
    const oldest = hostedMemoryImages.keys().next().value;
    hostedMemoryImages.delete(oldest);
  }
  const key = `${crypto.randomBytes(8).toString('hex')}.${extFromMime(mime)}`;
  hostedMemoryImages.set(key, { buffer, mime, createdAt: Date.now() });
  return `${publicBaseUrl}/i/${key}`;
}

function makeForm(fields, buffer, mime, filename, fileField) {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  form.append(fileField, new Blob([buffer], { type: mime }), filename);
  return form;
}

// Make sure a host really serves our file back unchanged (some hosts flatten/recompress GIFs)
async function probeHostedUrl(url, mime, origBytes) {
  if (mime !== 'image/gif' && mime !== 'image/webp') return true;
  try {
    const r = await fetchWithTimeout(url, { redirect: 'follow', headers: { 'User-Agent': BROWSER_UA } }, 6000);
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    const got = sniffImageMime(buf);
    if (!got) return false;
    if (got !== mime) return false;               // converted to another format
    if (buf.length < origBytes * 0.5) return false; // truncated / re-encoded
    return true;
  } catch (e) {
    return true; // can't check right now: don't throw away a good upload
  }
}

async function uploadBufferToPublicHost(buffer, mime, names) {
  const filename = `nexus_${Date.now()}.${extFromMime(mime)}`;
  const b64 = () => buffer.toString('base64');
  const okUrl = t => /^https?:\/\/\S+$/i.test(t) && !/error/i.test(t);

  const hosts = {
    catbox: async () => {
      const r = await fetchWithTimeout('https://catbox.moe/user/api.php', {
        method: 'POST',
        headers: { 'User-Agent': BROWSER_UA },
        body: makeForm({ reqtype: 'fileupload' }, buffer, mime, filename, 'fileToUpload')
      }, 5000);
      const t = (await r.text()).trim();
      if (!r.ok || !okUrl(t)) throw new Error('catbox');
      return t;
    },
    freeimage: async () => {
      const body = new URLSearchParams({
        key: '6d207e02198a847aa98d0a2a901485a5', action: 'upload', source: b64(), format: 'json'
      });
      const r = await fetchWithTimeout('https://freeimage.host/api/1/upload', { method: 'POST', body }, 5000);
      const j = await r.json();
      const u = j?.image?.url;
      if (!r.ok || !u || !okUrl(u)) throw new Error('freeimage');
      return u;
    },
    litterbox: async () => {
      const r = await fetchWithTimeout('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        headers: { 'User-Agent': BROWSER_UA },
        body: makeForm({ reqtype: 'fileupload', time: '72h' }, buffer, mime, filename, 'fileToUpload')
      }, 5000);
      const t = (await r.text()).trim();
      if (!r.ok || !okUrl(t)) throw new Error('litterbox');
      return t;
    },
    x0: async () => {
      const r = await fetchWithTimeout('https://0x0.st', {
        method: 'POST',
        headers: { 'User-Agent': 'NexusRPC/2.7 (image host client)' },
        body: makeForm({}, buffer, mime, filename, 'file')
      }, 5000);
      const t = (await r.text()).trim();
      if (!r.ok || !okUrl(t)) throw new Error('0x0');
      return t;
    }
  };

  // Race the hosts; permanent ones start now, backups start a moment later only if nobody has won yet.
  const order = Array.isArray(names) && names.length ? names : ['catbox', 'freeimage', 'litterbox', 'x0'];
  const stagger = Array.isArray(names) && names.length ? {} : { litterbox: 1800, x0: 3000 };
  let settled = false;
  const run = async name => {
    if (stagger[name]) await sleep(stagger[name]);
    if (settled) throw new Error('skipped');
    const url = await hosts[name]();
    if (!(await probeHostedUrl(url, mime, buffer.length))) throw new Error(`${name} altered the file`);
    return url;
  };
  const result = Promise.any(order.map(run));
  result.then(() => { settled = true; }, () => { settled = true; });
  try { return await result; } catch (e) { return ''; }
}

async function uploadDataUrlToPublicHost(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([a-zA-Z0-9.+\/-]*);base64,(.+)$/);
  if (!m) return '';
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return '';
  // Trust the real file bytes, not the declared mime (fixes GIFs mislabeled as png/jpg)
  const mime = sniffImageMime(buffer);
  if (!mime) return ''; // not a real png/jpg/gif/webp

  const hosted = await uploadBufferToPublicHost(buffer, mime);
  if (hosted) return hosted;
  return selfHostBuffer(buffer, mime);
}

function normalizeDiscordCdnUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes('imgur.com') && !u.hostname.startsWith('i.')) {
      const id = u.pathname.replace(/^\/+(gallery\/|a\/)?/, '').split('/')[0].replace(/\.\w+$/, '');
      if (id && /^[a-zA-Z0-9]{5,10}$/.test(id)) {
        return `https://i.imgur.com/${id}.${/gif/i.test(rawUrl) ? 'gif' : 'png'}`;
      }
    }
    if (u.hostname === 'github.com' && u.pathname.includes('/blob/')) {
      return rawUrl.replace('https://github.com/', 'https://raw.githubusercontent.com/').replace('/blob/', '/');
    }
  } catch (e) {}
  return rawUrl;
}

// Discord CDN attachment -> mp:attachments/... (only used as a last resort, these links are signed & expire)
function discordCdnToMp(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'media.discordapp.net' || u.hostname === 'cdn.discordapp.com') {
      const p = u.pathname.replace(/^\/+/, '');
      if (p.startsWith('attachments/') || p.startsWith('ephemeral-attachments/')) return `mp:${p}${u.search || ''}`;
    }
  } catch (e) {}
  return '';
}

async function fetchDiscordExternalAsset(token, appId, imageUrl) {
  try {
    const resp = await fetchWithTimeout(`https://discord.com/api/v9/applications/${appId}/external-assets`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'User-Agent': BROWSER_UA,
        Origin: 'https://discord.com',
        Referer: 'https://discord.com/channels/@me'
      },
      body: JSON.stringify({ urls: [imageUrl] })
    }, 10000);
    if (!resp.ok) return '';
    const data = await resp.json();
    const p = Array.isArray(data) && data[0]?.external_asset_path;
    if (p) return p.startsWith('mp:') ? p : `mp:${p}`;
  } catch (e) {}
  return '';
}

async function getExternalViaLib(client, appId, imageUrl) {
  try {
    if (typeof RichPresence.getExternal !== 'function') return '';
    const res = await Promise.race([
      RichPresence.getExternal(client, appId, imageUrl),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
    ]);
    const p = Array.isArray(res) && res[0]?.external_asset_path;
    if (p) return p.startsWith('mp:') ? p : `mp:${p}`;
  } catch (e) {}
  return '';
}

function firstNonEmpty(promises) {
  return new Promise(resolve => {
    let left = promises.length;
    if (!left) return resolve('');
    promises.forEach(p => p.then(v => {
      if (v) resolve(v);
      else if (--left === 0) resolve('');
    }, () => { if (--left === 0) resolve(''); }));
  });
}

// Ask Discord to proxy this URL. Hedged: start with the user's app id; if it is slow, race backup
// app ids after 2.5s / 5s. The first valid answer wins, so it's fast without hammering Discord.
function resolveViaDiscord(client, appId, token, imageUrl) {
  const ids = [appId, ...FALLBACK_ASSET_APP_IDS.filter(x => x !== appId).slice(0, 2)];
  const attempt = id => firstNonEmpty([
    getExternalViaLib(client, id, imageUrl),
    token ? fetchDiscordExternalAsset(token, id, imageUrl) : Promise.resolve('')
  ]);
  return new Promise(resolve => {
    let done = false, launched = 0, pending = 0;
    const timers = [];
    const finish = v => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      resolve(v || '');
    };
    const launch = () => {
      if (done || launched >= ids.length) return;
      const id = ids[launched++];
      pending++;
      attempt(id).catch(() => '').then(v => {
        pending--;
        if (v) return finish(v);
        if (pending === 0) {
          if (launched >= ids.length) finish('');
          else launch(); // failed fast -> try the next app id right away
        }
      });
    };
    launch();
    timers.push(setTimeout(launch, 2500), setTimeout(launch, 5000));
  });
}

// Check that Discord's proxy can really serve the asset. Only a clear "dead" answer counts as failure
// (404/410/5xx or an html page); anything unclear (403/429/network) is accepted so we never block a good asset.
async function verifyAssetPath(assetPath) {
  const m = /^mp:external\/(.+)$/.exec(String(assetPath || ''));
  if (!m) return true;
  try {
    const r = await fetchWithTimeout(`https://media.discordapp.net/external/${m[1]}`, {
      headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-63' }
    }, 2500);
    if (r.status === 404 || r.status === 410 || r.status >= 500) return false;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) return false;
    return true;
  } catch (e) {
    return true;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function decodeHtml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\\\//g, '/');
}

function extractPageImages(html, baseUrl) {
  const patterns = [
    /"contentUrl"\s*:\s*"([^"]+)"/ig,
    /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/ig,
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/ig,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/ig,
    /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/ig,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/ig
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const abs = new URL(decodeHtml(m[1]), baseUrl).href;
        if (/^https?:\/\//i.test(abs) && !found.includes(abs)) found.push(abs);
      } catch (e) {}
    }
  }
  // Prefer animated results
  return found.sort((a, b) => (/\.gif(\?|$)/i.test(b) ? 1 : 0) - (/\.gif(\?|$)/i.test(a) ? 1 : 0));
}

async function downloadRemote(url, ms = 9000) {
  try {
    const resp = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/gif,image/*,*/*;q=0.8' }
    }, ms);
    if (!resp.ok) return null;
    if (Number(resp.headers.get('content-length') || 0) > MAX_IMAGE_BYTES * 2) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const mime = sniffImageMime(buffer);
    if (mime) return { kind: 'image', buffer, mime };
    if (ct.includes('text/html')) return { kind: 'html', html: buffer.toString('utf8') };
  } catch (e) {}
  return null;
}

const pendingResolves = new Map();

// Same image requested twice at once shares one job. If it takes > 14s we answer "failed" now, but the
// job keeps going and caches its result, so the next broadcast of that image is instant.
async function resolveExternalImage(client, appId, imageInput, token = '', trace = null) {
  const key = String(imageInput || '');
  if (!key) return '';
  let job = pendingResolves.get(key);
  if (!job) {
    job = resolveExternalImageInner(client, appId, imageInput, token, trace).catch(() => '')
      .finally(() => pendingResolves.delete(key));
    pendingResolves.set(key, job);
  }
  let timer;
  const deadline = new Promise(r => { timer = setTimeout(() => r(''), 14000); if (timer.unref) timer.unref(); });
  try { return await Promise.race([job, deadline]); } finally { clearTimeout(timer); }
}

function buildCandidateImageUrls(rawUrl) {
  const candidates = [];
  const add = u => { if (u && /^https?:\/\//i.test(u) && !candidates.includes(u)) candidates.push(u); };
  add(rawUrl);
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes('imgur.com')) {
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      const baseId = last.replace(/\.(png|jpe?g|gif|webp|mp4|gifv)$/i, '');
      if (baseId) {
        const gif = /gif/i.test(rawUrl);
        (gif ? ['.gif', '.png', '.jpg'] : ['.png', '.jpg', '.gif']).forEach(ext => add(`https://i.imgur.com/${baseId}${ext}`));
      }
    }
    if (u.hostname.includes('giphy.com') && !/^media\d*\.giphy\.com$|^i\.giphy\.com$/.test(u.hostname)) {
      const id = (u.pathname.split('-').pop() || '').split('/')[0].replace(/[^a-zA-Z0-9]/g, '');
      if (id.length >= 4) add(`https://media.giphy.com/media/${id}/giphy.gif`);
    }
    // giphy .mp4 / .webp renditions -> .gif
    if (/media\d*\.giphy\.com/.test(u.hostname)) {
      add(rawUrl.replace(/\/[^/]+\.(mp4|webp)(\?.*)?$/i, '/giphy.gif'));
    }
  } catch (e) {}
  return candidates.slice(0, 4);
}

async function resolveExternalImageInner(client, appId, imageInput, token = '', trace = null) {
  const note = m => { if (trace) trace.push(m); };
  if (!imageInput) return '';
  let target = sanitizeImageInput(imageInput);
  if (!target) return '';
  if (target.startsWith('mp:')) return target;

  if (target.startsWith('data:')) {
    target = await uploadDataUrlToPublicHost(target);
    if (!target) return '';
  }
  if (!/^https?:\/\//i.test(target)) return target; // plain asset key name

  const activeToken = token || client?.token || '';
  const cached = externalAssetCache.get(target);
  if (cached && Date.now() - cached.at < ASSET_CACHE_TTL) return cached.path;

  const remember = path => {
    externalAssetCache.set(target, { path, at: Date.now() });
    return path;
  };

  // 1) Page links (tenor/giphy/any site) -> real image URL
  let direct = normalizeDiscordCdnUrl(target);
  const isTenorPage = /(^|\.)tenor\.com$/i.test(new URL(direct).hostname) && !/\.(gif|png|jpe?g|webp)(\?|$)/i.test(direct);
  const isGiphyPage = /(^|\.)giphy\.com$/i.test(new URL(direct).hostname) && /\/gifs?\//i.test(direct);
  if (isTenorPage || isGiphyPage) {
    const page = await downloadRemote(direct);
    if (page?.kind === 'html') {
      const imgs = extractPageImages(page.html, direct);
      if (imgs[0]) direct = imgs[0];
    }
  }

  // 2) Fast path: let Discord proxy the URL(s). One quick retry covers rate limits / slow GIF fetches.
  let unverified = '';
  const candidates = buildCandidateImageUrls(direct);
  for (let i = 0; i < candidates.length; i++) {
    let out = await resolveViaDiscord(client, appId, activeToken, candidates[i]);
    if (!out && i === 0) {
      await sleep(700);
      out = await resolveViaDiscord(client, appId, activeToken, candidates[i]);
    }
    if (out) {
      if (await verifyAssetPath(out)) return remember(out);
      unverified = unverified || out;
    }
  }

  // 3) Slow path: the origin blocks Discord (hotlink protection / page URL / bad headers).
  //    Download it ourselves, then re-host on DIFFERENT hosts one by one until Discord accepts a copy.
  let dl = await downloadRemote(direct);
  if (dl?.kind === 'html') {
    const imgs = extractPageImages(dl.html, direct);
    for (const img of imgs.slice(0, 2)) {
      const viaDiscord = await resolveViaDiscord(client, appId, activeToken, img);
      if (viaDiscord && await verifyAssetPath(viaDiscord)) return remember(viaDiscord);
      dl = await downloadRemote(img);
      if (dl?.kind === 'image') break;
    }
  }
  if (!dl) note('could not download the image from that link');
  else if (dl.kind !== 'image') note('that link is a web page, not an image');
  else if (dl.buffer.length > MAX_IMAGE_BYTES) note('file is over 8 MB');
  else {
    const buf = dl.buffer, mime = dl.mime;
    const attempts = [
      () => selfHostBuffer(buf, mime),
      ...['freeimage', 'litterbox', 'catbox', 'x0'].map(n => () => uploadBufferToPublicHost(buf, mime, [n]))
    ];
    for (const make of attempts) {
      const hostedUrl = await make();
      if (!hostedUrl || hostedUrl === direct) continue;
      const out = await resolveViaDiscord(client, appId, activeToken, hostedUrl);
      if (out && await verifyAssetPath(out)) return remember(out);
      if (out) unverified = unverified || out;
    }
    note('Discord refused every re-hosted copy');
  }

  // 4) Last resort: Discord CDN attachment links, or the first answer Discord gave us even if we couldn't verify it
  const mp = discordCdnToMp(target);
  if (mp) return mp;
  if (unverified) return unverified;

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

async function buildRichPresence(client, payload, fallbackDevice, token = '') {
  const resolvedAppId = (payload.appId && String(payload.appId).trim()) || '463151177836658699';
  const { platform } = resolveDeviceProperties(payload.device || fallbackDevice);

  let spotifyInfo = null;
  if (payload.mediaKind === 'spotify' && typeof SpotifyRPC === 'function' && payload.spotifyLookupUrl) {
    spotifyInfo = await lookupSpotifyTrack(payload.spotifyLookupUrl);
  }
  let rpc = null;
  if (spotifyInfo) {
    try { rpc = new SpotifyRPC(client); } catch (e) { rpc = null; spotifyInfo = null; }
  }
  if (!rpc) {
    rpc = new RichPresence(client)
      .setApplicationId(resolvedAppId)
      .setType(payload.activityType || 'PLAYING')
      .setName(payload.name.trim());
  }

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
  const durationMs = Math.round(Number(payload.durationSec) * 1000);
  const hasProgress = payload.timestampMode === 'progress' && durationMs > 0 && durationMs <= 24 * 3600 * 1000;
  if (hasProgress) {
    if (!payload._anchoredStart) {
      const elapsed = Math.max(0, Math.min(Number(payload.elapsedSec) || 0, Number(payload.durationSec)));
      payload._anchoredStart = now - elapsed * 1000;
    }
    // Loop: jump to the current cycle so the bar restarts seamlessly
    if (payload.loop && now >= payload._anchoredStart + durationMs) {
      payload._anchoredStart += Math.floor((now - payload._anchoredStart) / durationMs) * durationMs;
    }
    payload._anchoredEnd = payload._anchoredStart + durationMs;
  }
  if (!hasProgress && !payload._anchoredStart) {
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
  if (hasProgress) {
    rpc.setEndTimestamp(payload._anchoredEnd);
  } else if (payload.timestampMode === 'custom' && payload.customEndMins !== '' && !isNaN(payload.customEndMins)) {
    if (!payload._anchoredEnd) {
      payload._anchoredEnd = now + (parseFloat(payload.customEndMins) * 60 * 1000);
    }
    rpc.setEndTimestamp(payload._anchoredEnd);
  }

  const rawLarge = sanitizeImageInput(payload.largeImage);
  const rawSmall = sanitizeImageInput(payload.smallImage);

  const traceLarge = [];
  const traceSmall = [];
  let resolvedLarge = '';
  let resolvedSmall = '';
  if (spotifyInfo && spotifyInfo.imageId) {
    resolvedLarge = `spotify:${spotifyInfo.imageId}`; // real Spotify cover: no proxying needed
  } else {
    [resolvedLarge, resolvedSmall] = await Promise.all([
      rawLarge ? resolveExternalImage(client, resolvedAppId, rawLarge, token, traceLarge) : Promise.resolve(''),
      (rawSmall && !spotifyInfo) ? resolveExternalImage(client, resolvedAppId, rawSmall, token, traceSmall) : Promise.resolve('')
    ]);
  }
  if (spotifyInfo) {
    resolvedSmall = ''; // the real Spotify card has no small image
    try {
      if (typeof rpc.setSongId === 'function') rpc.setSongId(spotifyInfo.trackId);
      else rpc.sync_id = spotifyInfo.trackId;
    } catch (e) {}
  }

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

  let activeButtons = [];
  if (Array.isArray(payload.buttons) && !spotifyInfo) {
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

    if (validButtons.length > 0) {
      rpc.buttons = validButtons.map(b => b.label);
      rpc.metadata = { ...(rpc.metadata || {}), button_urls: validButtons.map(b => b.url) };
      activeButtons = validButtons;
    }
  }

  // Newer Discord fields (what the member list shows + clickable lines). Best-effort: added to the
  // outgoing activity only if the library lets us extend it, otherwise silently ignored.
  const extra = {};
  const sdt = { name: 0, state: 1, details: 2 }[String(payload.statusDisplayType || '')];
  if (sdt !== undefined) extra.status_display_type = sdt;
  const cleanLink = u => {
    if (!u || typeof u !== 'string') return '';
    try { return new URL(/^https?:\/\//i.test(u.trim()) ? u.trim() : `https://${u.trim()}`).href; } catch (e) { return ''; }
  };
  const dUrl = cleanLink(payload.detailsUrl);
  const sUrl = cleanLink(payload.stateUrl);
  if (dUrl) extra.details_url = dUrl;
  if (sUrl) extra.state_url = sUrl;
  if (activeButtons.length) {
    // Also put the buttons straight into the outgoing activity, whatever the library does
    extra.buttons = activeButtons.map(b => b.label);
    extra.metadata = { ...(rpc.metadata || {}), button_urls: activeButtons.map(b => b.url) };
  }
  if (Object.keys(extra).length && typeof rpc.toJSON === 'function') {
    const baseToJSON = rpc.toJSON.bind(rpc);
    rpc.toJSON = (...args) => ({ ...baseToJSON(...args), ...extra });
  }

  return {
    rpc,
    spotifyNative: Boolean(spotifyInfo),
    imageWarnings: {
      largeFailed: Boolean(rawLarge && !resolvedLarge),
      smallFailed: Boolean(rawSmall && !resolvedSmall && !spotifyInfo),
      largeReason: traceLarge[traceLarge.length - 1] || '',
      smallReason: traceSmall[traceSmall.length - 1] || ''
    }
  };
}

const spotifyTrackCache = new Map();

// Maps an Apple Music track link to the real Spotify track (id + cover) so Discord can draw the
// native Spotify card with its own logo and "Play on Spotify" button. Returns null if not found.
async function lookupSpotifyTrack(appleUrl) {
  const key = String(appleUrl || '');
  if (!/^https?:\/\//i.test(key)) return null;
  const hit = spotifyTrackCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.info;
  let info = null;
  try {
    const r = await fetchWithTimeout(
      `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(key)}&userCountry=US`,
      { headers: { 'User-Agent': BROWSER_UA } }, 5000);
    if (r.ok) {
      const j = await r.json();
      const link = j?.linksByPlatform?.spotify;
      const uid = String(link?.entityUniqueId || '');
      const trackId = uid.split('::')[1] || (String(link?.url || '').match(/track\/([A-Za-z0-9]+)/) || [])[1] || '';
      const thumb = String(j?.entitiesByUniqueId?.[uid]?.thumbnailUrl || '');
      const imageId = (thumb.match(/i\.scdn\.co\/image\/([a-f0-9]{20,})/i) || [])[1] || '';
      if (trackId) info = { trackId, imageId };
    }
  } catch (e) {}
  while (spotifyTrackCache.size >= 500) spotifyTrackCache.delete(spotifyTrackCache.keys().next().value);
  spotifyTrackCache.set(key, { info, exp: Date.now() + (info ? 6 * 3600 * 1000 : 2 * 60 * 1000) });
  return info;
}

function scheduleMediaLoop(entry) {
  if (entry.loopTimer) { clearTimeout(entry.loopTimer); entry.loopTimer = null; }
  const p = entry.activeRPC;
  if (!p || !p.loop || p.timestampMode !== 'progress' || !p._anchoredEnd || !entry.info.connected) return;
  const delay = Math.max(1500, p._anchoredEnd - Date.now() + 400);
  entry.loopTimer = setTimeout(async () => {
    entry.loopTimer = null;
    if (entry.activeRPC !== p || !entry.client || !entry.info.connected) return;
    try { await syncFullDiscordPresence(entry); } catch (e) {}
  }, delay);
  if (entry.loopTimer.unref) entry.loopTimer.unref();
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
  let spotifyNative = false;

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
    spotifyNative = built.spotifyNative;
    try { entry.lastActivity = JSON.parse(JSON.stringify(typeof built.rpc.toJSON === 'function' ? built.rpc.toJSON() : built.rpc)); } catch (e) {}
    activities.push(built.rpc);
    entry.info.activeGame = entry.activeRPC.name.trim();
    entry.info.activeDetails = entry.activeRPC.details ? entry.activeRPC.details.trim() : null;
  } else {
    entry.info.activeGame = null;
    entry.info.activeDetails = null;
  }

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

  scheduleMediaLoop(entry);
  return { imageWarnings, spotifyNative };
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
  res.setHeader('Content-Length', item.buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(item.buffer);
});

app.post('/api/upload-image', async (req, res) => {
  try {
    const { dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return res.status(400).json({ error: 'Select a valid PNG, JPG, WEBP, or GIF file.' });
    }

    const hostedUrl = await uploadDataUrlToPublicHost(dataUrl);
    if (!hostedUrl) {
      return res.status(502).json({ error: 'Could not upload image right now (max 8 MB). Try again or paste a direct URL.' });
    }
    try {
      const entry = getOrCreateSession(getSessionId(req));
      if (entry && entry.client && entry.info.connected) {
        const appId = (entry.activeRPC && entry.activeRPC.appId) || '463151177836658699';
        resolveExternalImage(entry.client, appId, hostedUrl, entry.token).catch(() => {});
      }
    } catch (e) {}
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
        icon: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
        durationSec: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : 0,
        appleUrl: item.trackViewUrl || ''
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
        icon: s.image ? (s.image.original || s.image.medium) : '',
        durationSec: (s.averageRuntime || s.runtime) ? Math.round((s.averageRuntime || s.runtime) * 60) : 0
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
  if (entry.loopTimer) { clearTimeout(entry.loopTimer); entry.loopTimer = null; }
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

// Shows the exact activity object last built for this session (to check buttons/images are included)
app.get('/api/debug-activity', (req, res) => {
  const entry = getOrCreateSession(getSessionId(req));
  res.json({ activity: entry.lastActivity || null });
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
      prevRpc.timestampMode === payload.timestampMode &&
      (payload.timestampMode !== 'progress' || (
        String(prevRpc.details || '') === String(payload.details || '') &&
        Number(prevRpc.durationSec) === Number(payload.durationSec) &&
        Number(prevRpc.elapsedSec || 0) === Number(payload.elapsedSec || 0)
      ));
    if (sameActivity && !payload.restart && prevRpc._anchoredStart && !payload._anchoredStart) {
      payload._anchoredStart = prevRpc._anchoredStart;
    }
    delete payload.restart;
    delete payload._anchoredEnd;
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
      imageWarnings: syncResult.imageWarnings || {},
      spotifyNative: Boolean(syncResult.spotifyNative)
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

  if (entry.loopTimer) { clearTimeout(entry.loopTimer); entry.loopTimer = null; }
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
    return res.status(413).json({ error: 'Image file is too large. Keep it under 8 MB.' });
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
