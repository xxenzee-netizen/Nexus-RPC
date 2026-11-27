const express = require('express');
const path = require('path');
const crypto = require('crypto');
const selfbotLib = require('discord.js-selfbot-v13');
const { Client, RichPresence } = selfbotLib;
const SpotifyRPC = selfbotLib.SpotifyRPC; // native Spotify-style activity (Play on Spotify button + logo)

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));

// Pure in-memory per-browser-session store (100% isolated per user/browser)
const userSessions = new Map();
const externalAssetCache = new Map();
let cachedGames = [];

const NEXUS_LOGO_URL = 'https://myimgs.org/storage/images/87001/1000048092.png';
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
    // sessions with a saved token keep trying to reconnect for 24h; others are dropped after 1h
    if (!entry.info.connected && now - entry.lastSeen > (entry.token ? 24 : 1) * 60 * 60 * 1000) {
      if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
      if (entry.rotationTimer) clearInterval(entry.rotationTimer);
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
      slots: { game: null, media: null },
      lastSlot: 'game',
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
  let s = val.trim();
  if (!s) return '';
  if (s.startsWith('mp:')) return s;
  if (/^data:[a-zA-Z0-9.+\/-]*;base64,/i.test(s)) return s;

  // links the server can never open (they only exist inside your phone/browser)
  if (/^(blob|javascript|file|ftp|about|chrome|content|intent):/i.test(s)) return '';

  // a single link whose file name has spaces ("https://x.com/my pic.gif"): keep it whole, spaces get encoded
  if (/^https?:\/\//i.test(s) && !/[\n<>"'`]/.test(s) && /\.(png|jpe?g|gif|webp|avif|bmp|heic|tiff?)(\?\S*)?$/i.test(s)) {
    try { return new URL(s).href; } catch (e) {}
  }

  // pull the link out of messy pasted text: "<url>", [label](url), "quotes", several lines, text around it
  const m = s.match(/https?:\/\/[^\s<>"'`\])]+/i);
  if (m) s = m[0].replace(/[.,;:!?]+$/, '');
  else if (s.startsWith('//')) s = `https:${s.split(/\s/)[0]}`;
  else if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/\S*)?$/.test(s.split(/\s/)[0])) s = `https://${s.split(/\s/)[0]}`;
  else if (/^[A-Za-z0-9_.-]{1,64}$/.test(s)) return s; // a plain Discord asset name
  else return '';

  try {
    return new URL(s).href; // encodes spaces / non-English characters the way Discord expects
  } catch (e) {
    return '';
  }
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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;      // what we hand to Discord / hosts
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;    // what users may upload (big GIFs get auto-shrunk)
const MAX_HOSTED_BYTES = 120 * 1024 * 1024;   // total RAM budget for the /i/ self-host fallback
const DOWNLOAD_CAP = MAX_UPLOAD_BYTES;
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

/* --- Automatic GIF optimizer (sharp is optional; without it GIFs are used as-is) --- */
let sharpLib = null;
try {
  sharpLib = require('sharp');
  sharpLib.cache(false);
  sharpLib.concurrency(1);
} catch (e) {
  sharpLib = null;
}

const SHRINK_TARGET_BYTES = 1.5 * 1024 * 1024; // small files load fast in Discord
let shrinkChain = Promise.resolve();

// Only one shrink at a time, so a burst of uploads can't spike CPU/RAM and crash the server
function runShrinkJob(fn) {
  const job = shrinkChain.then(fn, fn);
  shrinkChain = job.catch(() => {});
  return job;
}

async function shrinkGifNow(buffer, opts) {
  const input = () => sharpLib(buffer, { animated: true, limitInputPixels: 120e6 });
  const meta = await input().metadata();
  const w = meta.width || 0;
  const pageH = meta.pageHeight || meta.height || 0;
  const pages = meta.pages || 1;
  if (!w || !pageH) return buffer;
  const maxSide = Math.max(w, pageH);
  const needs = opts.force || buffer.length > SHRINK_TARGET_BYTES || maxSide > 480 || pages > 120;
  if (!needs) return buffer; // small, normal GIFs are left untouched (best quality)
  if (w * pageH * pages * 4 > 450 * 1024 * 1024) return buffer; // would need too much RAM
  const startDim = Math.min(opts.maxDim || 400, maxSide);
  const steps = [startDim, 400, 320, 256, 192].filter((d, i, a) => d <= startDim && a.indexOf(d) === i);
  let best = buffer;
  for (const dim of steps) {
    const out = await input()
      .resize({ width: dim, height: dim, fit: 'inside', withoutEnlargement: true })
      .gif({ effort: 3, colours: dim <= 256 ? 128 : 256 })
      .toBuffer();
    if (sniffImageMime(out) !== 'image/gif') continue;
    if (out.length < best.length) best = out;
    if (out.length <= SHRINK_TARGET_BYTES) break;
  }
  return best;
}

async function shrinkStaticNow(buffer, mime) {
  const open = () => sharpLib(buffer, { limitInputPixels: 120e6 });
  const meta = await open().metadata();
  if ((meta.pages || 1) > 1) return buffer; // animated webp etc: leave alone
  const maxSide = Math.max(meta.width || 0, meta.height || 0);
  if (!maxSide || (buffer.length <= 1024 * 1024 && maxSide <= 1024)) return buffer;
  let pipe = open().rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true });
  if (mime === 'image/png') pipe = pipe.png({ compressionLevel: 9, effort: 6 });
  else if (mime === 'image/jpeg') pipe = pipe.jpeg({ quality: 86, mozjpeg: true });
  else pipe = pipe.webp({ quality: 86 });
  const out = await pipe.toBuffer();
  return out.length < buffer.length && sniffImageMime(out) === mime ? out : buffer;
}

// Big PNG/JPG/WEBP files are resized too (RPC art is shown small, so 512px is plenty and loads much faster)
async function optimizeStatic(buffer, mime) {
  if (!sharpLib || mime === 'image/gif') return buffer;
  let timer;
  try {
    return await Promise.race([
      runShrinkJob(() => shrinkStaticNow(buffer, mime)),
      new Promise(r => { timer = setTimeout(() => r(buffer), 15000); if (timer.unref) timer.unref(); })
    ]);
  } catch (e) {
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function optimizeGif(buffer, opts = {}) {
  if (!sharpLib || sniffImageMime(buffer) !== 'image/gif') return buffer;
  let timer;
  try {
    return await Promise.race([
      runShrinkJob(() => shrinkGifNow(buffer, opts)),
      new Promise(r => { timer = setTimeout(() => r(buffer), 25000); if (timer.unref) timer.unref(); })
    ]);
  } catch (e) {
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/* --- Safe downloading of user-supplied links (blocks internal addresses, caps size) --- */
const dnsPromises = require('dns').promises;

function isPrivateIp(ip) {
  const v = String(ip || '').toLowerCase();
  if (!v) return true;
  if (v.includes(':')) {
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
      /^::ffff:(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v);
  }
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n))) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
}

async function isSafePublicUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPrivateIp(host);
    const addrs = await dnsPromises.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
  } catch (e) {
    return false;
  }
}

async function readCapped(resp, cap) {
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length > cap ? null : buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      try { await reader.cancel(); } catch (e) {}
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// AVIF / HEIF / TIFF / JPEG-XL photos (phones, screenshots) are turned into PNG so Discord can always show them.
// (SVG is deliberately not rendered: it could be abused to read files from the server.)
async function toSupportedImage(buffer) {
  const mime = sniffImageMime(buffer);
  if (mime) return { buffer, mime };
  if (!sharpLib) return null;
  try {
    const meta = await sharpLib(buffer, { limitInputPixels: 120e6 }).metadata();
    if (!['heif', 'avif', 'tiff', 'jxl', 'jp2'].includes(meta.format)) return null;
    const out = await runShrinkJob(() => sharpLib(buffer, { limitInputPixels: 120e6 })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer());
    return sniffImageMime(out) === 'image/png' ? { buffer: out, mime: 'image/png' } : null;
  } catch (e) {
    return null;
  }
}

function selfHostBuffer(buffer, mime) {
  if (!publicBaseUrl || buffer.length > MAX_IMAGE_BYTES) return '';
  const usedBytes = () => { let n = 0; for (const v of hostedMemoryImages.values()) n += v.buffer.length; return n; };
  while (hostedMemoryImages.size >= MAX_HOSTED_IMAGES ||
         (hostedMemoryImages.size > 0 && usedBytes() + buffer.length > MAX_HOSTED_BYTES)) {
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
    const r = await fetchWithTimeout(url, {
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-1023' }
    }, 4000);
    if (!r.ok) return false; // 200 or 206 are both fine
    let head;
    if (r.body && typeof r.body.getReader === 'function') {
      const rd = r.body.getReader();
      const { value } = await rd.read();
      try { await rd.cancel(); } catch (e) {}
      head = Buffer.from(value || []);
    } else {
      head = Buffer.from(await r.arrayBuffer());
    }
    if (sniffImageMime(head) !== mime) return false; // converted to another format
    const range = r.headers.get('content-range'); // e.g. "bytes 0-1023/12345"
    const total = range ? Number(String(range).split('/')[1]) : Number(r.headers.get('content-length') || 0);
    if (total && total < origBytes * 0.5) return false; // truncated / re-encoded
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
  const stagger = Array.isArray(names) && names.length ? {} : { litterbox: 1000, x0: 2000 };
  let settled = false;
  const run = async name => {
    if (stagger[name]) await sleep(stagger[name]);
    if (settled) throw new Error('skipped');
    const url = await hosts[name]();
    // catbox/litterbox/0x0 store files untouched; only freeimage may recompress, so only it is checked
    if (name === 'freeimage' && !(await probeHostedUrl(url, mime, buffer.length))) throw new Error('freeimage altered the file');
    return url;
  };
  const result = Promise.any(order.map(run));
  result.then(() => { settled = true; }, () => { settled = true; });
  try { return await result; } catch (e) { return ''; }
}

async function uploadDataUrlToPublicHost(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([a-zA-Z0-9.+\/-]*);base64,(.+)$/);
  if (!m) return '';
  const rawBuffer = Buffer.from(m[2], 'base64');
  if (!rawBuffer.length || rawBuffer.length > MAX_UPLOAD_BYTES) return '';
  // Trust the real file bytes, not the declared mime (fixes GIFs mislabeled as png/jpg); odd formats become PNG
  const supported = await toSupportedImage(rawBuffer);
  if (!supported) return ''; // not a picture we can use
  const original = supported.buffer;
  const mime = supported.mime;
  // Big / oversized GIFs are shrunk automatically so Discord can always load them
  const buffer = mime === 'image/gif' ? await optimizeGif(original) : await optimizeStatic(original, mime);
  if (buffer.length > MAX_IMAGE_BYTES) return '';

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

// Discord-hosted image -> "mp:" path. Public assets (game icons, avatars, emojis...) never expire and need no
// request to Discord at all. Attachments are signed links that expire, so they keep their query string.
function discordCdnToMp(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname === 'media.discordapp.net' || u.hostname === 'cdn.discordapp.com') {
      const p = u.pathname.replace(/^\/+/, '');
      if (/^(ephemeral-)?attachments\//.test(p)) return `mp:${p}${u.search || ''}`;
      if (/^(app-icons|app-assets|avatars|icons|banners|emojis|stickers|role-icons|guild-events|splashes|discovery-splashes|channel-icons|clan-badges|avatar-decoration-presets)\//.test(p)) return `mp:${p}`;
    }
  } catch (e) {}
  return '';
}

// What Discord last answered when we asked it to proxy an image (shown to the user when everything fails)
const assetDiag = { last: '' };
let workingAssetAppId = ''; // the application id that last worked for external assets (asset paths work with any id)

async function fetchDiscordExternalAsset(token, appId, imageUrl) {
  for (let attempt = 0; attempt < 2; attempt++) {
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
      if (resp.status === 429) {
        // rate limited: wait the time Discord asks for (max 4s), then try once more
        let wait = 1500;
        try { const j = await resp.json(); wait = Math.min(4000, Math.max(300, Number(j.retry_after) * 1000 || 1500)); } catch (e) {}
        await sleep(wait);
        continue;
      }
      if (!resp.ok) {
        let msg = '';
        try { const j = await resp.json(); msg = String(j.message || j.captcha_key || (j.code ? `code ${j.code}` : '')).slice(0, 80); } catch (e) {}
        assetDiag.last = `HTTP ${resp.status}${msg ? ` ${msg}` : ''}`;
        return '';
      }
      const data = await resp.json();
      const p = Array.isArray(data) && data[0]?.external_asset_path;
      if (p) { workingAssetAppId = appId; return p.startsWith('mp:') ? p : `mp:${p}`; }
      assetDiag.last = 'empty answer';
      return '';
    } catch (e) {
      assetDiag.last = String(e && e.message || 'network error').slice(0, 60);
      return '';
    }
  }
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
    if (p) { workingAssetAppId = appId; return p.startsWith('mp:') ? p : `mp:${p}`; }
  } catch (e) {
    assetDiag.last = String(e && e.message || 'library error').slice(0, 80);
  }
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
// app ids after 1.5s / 3s. The first valid answer wins, so it's fast without hammering Discord.
function resolveViaDiscord(client, appId, token, imageUrl) {
  // start with the id that worked last time (the asset path works for any application id)
  const ids = [...new Set([workingAssetAppId, appId, ...FALLBACK_ASSET_APP_IDS].filter(Boolean))].slice(0, 3);
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
    timers.push(setTimeout(launch, 1500), setTimeout(launch, 3000));
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
    }, 1500); // a slow answer just means Discord is still fetching: treated as OK
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

async function downloadRemote(url, ms = 7000) {
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!(await isSafePublicUrl(current))) return null;
      const resp = await fetchWithTimeout(current, {
        redirect: 'manual',
        headers: { 'User-Agent': BROWSER_UA, Accept: 'image/avif,image/webp,image/gif,image/*,*/*;q=0.8' }
      }, ms);
      const loc = resp.status >= 300 && resp.status < 400 && resp.headers.get('location');
      if (loc) { current = new URL(loc, current).href; continue; }
      if (!resp.ok) return null;
      if (Number(resp.headers.get('content-length') || 0) > DOWNLOAD_CAP) return null;
      const buffer = await readCapped(resp, DOWNLOAD_CAP);
      if (!buffer) return null;
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const mime = sniffImageMime(buffer);
      if (mime) return { kind: 'image', buffer, mime };
      if (ct.includes('text/html')) return { kind: 'html', html: buffer.toString('utf8') };
      const converted = await toSupportedImage(buffer); // avif / heif / tiff ...
      if (converted) return { kind: 'image', buffer: converted.buffer, mime: converted.mime };
      return null;
    }
  } catch (e) {}
  return null;
}

const pendingResolves = new Map();

// Same image requested twice at once shares one job. If it takes > 22s we answer "failed" now, but the
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
  const deadline = new Promise(r => { timer = setTimeout(() => r(''), 22000); if (timer.unref) timer.unref(); });
  try { return await Promise.race([job, deadline]); } finally { clearTimeout(timer); }
}

// Links that stop working later (Discord attachments, signed/expiring links): copy them to a permanent host
function isExpiringLink(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if ((u.hostname === 'cdn.discordapp.com' || u.hostname === 'media.discordapp.net') && /^\/(ephemeral-)?attachments\//.test(u.pathname)) return true;
    return /(^|&)(X-Amz-Expires|X-Amz-Signature|Expires|Signature|ex|hm)=/i.test(u.search.replace(/^\?/, ''));
  } catch (e) {
    return false;
  }
}

function buildCandidateImageUrls(rawUrl) {
  const candidates = [];
  const add = u => { if (u && /^https?:\/\//i.test(u) && !candidates.includes(u)) candidates.push(u); };
  if (/^http:\/\//i.test(rawUrl)) add(rawUrl.replace(/^http:/i, 'https:')); // Discord prefers https
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

  // Discord's own public images: use the media proxy path directly (instant, can't fail)
  const directMp = discordCdnToMp(target);
  if (directMp && !/^mp:(ephemeral-)?attachments\//.test(directMp)) return directMp;

  const cached = externalAssetCache.get(target);
  if (cached && Date.now() - cached.at < ASSET_CACHE_TTL) return cached.path;

  const remember = path => {
    while (externalAssetCache.size >= 2000) externalAssetCache.delete(externalAssetCache.keys().next().value);
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
  //    (Expiring links skip it: they would work today and break tomorrow, so they are saved permanently below.)
  let unverified = '';
  const expiring = isExpiringLink(direct);
  const candidates = expiring ? [] : buildCandidateImageUrls(direct);
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
  if (!dl && /^http:\/\//i.test(target)) dl = await downloadRemote(target); // the site may only speak plain http
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
  else {
    let buf = dl.buffer;
    const mime = dl.mime;
    buf = mime === 'image/gif' ? await optimizeGif(buf) : await optimizeStatic(buf, mime); // only acts on big files
    if (buf.length > MAX_IMAGE_BYTES) {
      note('file is over 8 MB');
    } else {
      if (expiring) {
        // permanent copy first (catbox / freeimage), so the picture keeps working after the original link expires
        const permanentUrl = await uploadBufferToPublicHost(buf, mime, ['catbox', 'freeimage']);
        if (permanentUrl) {
          const out = await resolveViaDiscord(client, appId, activeToken, permanentUrl);
          if (out && await verifyAssetPath(out)) return remember(out);
          if (out) unverified = unverified || out;
        }
      }
      const pipeline = makeUrl => (async () => {
        try {
          const hostedUrl = await makeUrl();
          if (!hostedUrl || hostedUrl === direct) return '';
          const out = await resolveViaDiscord(client, appId, activeToken, hostedUrl);
          if (!out) return '';
          if (await verifyAssetPath(out)) return out;
          unverified = unverified || out;
        } catch (e) {}
        return '';
      })();
      // GIF Discord keeps refusing: a much smaller copy
      const tiny = async () => {
        if (mime !== 'image/gif') return '';
        const small = await optimizeGif(buf, { force: true, maxDim: 256 });
        if (small === buf || small.length >= buf.length) return '';
        return selfHostBuffer(small, mime) || await uploadBufferToPublicHost(small, mime);
      };
      // Try several independent copies at the same time; the first one Discord accepts wins
      let found = await firstNonEmpty([
        pipeline(() => selfHostBuffer(buf, mime)),
        pipeline(() => uploadBufferToPublicHost(buf, mime, ['freeimage'])),
        pipeline(() => uploadBufferToPublicHost(buf, mime, ['litterbox'])),
        pipeline(() => uploadBufferToPublicHost(buf, mime, ['catbox']))
      ]);
      if (!found) {
        found = await firstNonEmpty([
          pipeline(tiny),
          pipeline(() => uploadBufferToPublicHost(buf, mime, ['x0']))
        ]);
      }
      if (found) return remember(found);
      note(`Discord refused every re-hosted copy${assetDiag.last ? ` - Discord said: ${assetDiag.last}` : ''}`);
    }
  }

  // 4) Last resort: Discord CDN attachment links, or the first answer Discord gave us even if we couldn't verify it
  const mp = directMp;
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

async function buildRichPresence(client, payload, fallbackDevice, token = '', opts = {}) {
  const resolvedAppId = isDiscordId(payload.appId) ? String(payload.appId).trim() : '463151177836658699';
  const { platform } = resolveDeviceProperties(payload.device || fallbackDevice);

  let spotifyInfo = null;
  const budget = Number(opts.budgetMs) || 0;
  let spotifyMatched = false;
  if (payload.mediaKind === 'spotify' && typeof SpotifyRPC === 'function') {
    const lookupP = lookupSpotifyTrack(payload.spotifyLookupUrl, payload.appleTrackId, {
      title: payload.details, artist: payload.state, durationSec: payload.durationSec
    }, { fresh: Boolean(payload._spotifyFresh) });
    payload._spotifyFresh = false;
    let found = null;
    if (budget) {
      found = await Promise.race([lookupP, delayUnref(budget).then(() => null)]);
      if (!found && typeof opts.onLate === 'function') {
        lookupP.then(v => { if (v) opts.onLate(); }).catch(() => {});
      }
    } else {
      found = await lookupP;
    }
    spotifyMatched = Boolean(found);
    // Always the native Spotify activity (logo, progress bar, native Play on Spotify button). Found -> real song id,
    // album, artists, cover and length. Not found (yet) -> a placeholder song id, so the card and the button still
    // look exactly real; the server keeps searching and swaps in the real song by itself.
    spotifyInfo = found || { trackId: '', imageId: '', artistIds: [], artistNames: [], title: '', placeholder: true };
    // use Spotify's own length so the progress bar matches the real song (e.g. 07:39)
    if (spotifyInfo && spotifyInfo.durationSec > 0) payload.durationSec = spotifyInfo.durationSec;
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

  // Native Spotify card: exact Spotify title and "Artist 1, Artist 2" like the real one
  const detailsText = (spotifyInfo && spotifyInfo.title) ? spotifyInfo.title : payload.details;
  const stateText = (spotifyInfo && spotifyInfo.artistNames && spotifyInfo.artistNames.length)
    ? spotifyInfo.artistNames.join(', ')
    : payload.state;
  if (detailsText && String(detailsText).trim()) {
    rpc.setDetails(String(detailsText).trim().slice(0, 128));
  }
  if (stateText && String(stateText).trim()) {
    rpc.setState(String(stateText).trim().slice(0, 128));
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
  if (hasProgress && payload.timeStyle !== 'elapsed') {
    rpc.setEndTimestamp(payload._anchoredEnd);
  } else if (payload.timestampMode === 'custom' && payload.customEndMins !== '' && !isNaN(payload.customEndMins)) {
    if (!payload._anchoredEnd) {
      payload._anchoredEnd = now + (parseFloat(payload.customEndMins) * 60 * 1000);
    }
    rpc.setEndTimestamp(payload._anchoredEnd);
  }

  const rawLarge = sanitizeImageInput(payload.largeImage);
  const largeInvalid = Boolean(String(payload.largeImage || '').trim() && !rawLarge);
  const rawSmall = sanitizeImageInput(payload.smallImage);

  const traceLarge = [];
  const traceSmall = [];
  let resolvedLarge = '';
  let resolvedSmall = '';
  let imagePending = false;
  let spotifyCoverId = spotifyInfo ? spotifyInfo.imageId : '';
  if (spotifyInfo && !spotifyCoverId) spotifyCoverId = await findSpotifyAlbumCover(payload.largeText, payload.state);
  if (spotifyInfo && spotifyCoverId) {
    resolvedLarge = `spotify:${spotifyCoverId}`; // real Spotify cover: the Spotify card only shows these
  } else {
    const wantSmall = Boolean(rawSmall && !spotifyInfo);
    const pLarge = rawLarge ? resolveExternalImage(client, resolvedAppId, rawLarge, token, traceLarge) : Promise.resolve('');
    const pSmall = wantSmall ? resolveExternalImage(client, resolvedAppId, rawSmall, token, traceSmall) : Promise.resolve('');
    let doneLarge = !rawLarge, doneSmall = !wantSmall;
    pLarge.then(v => { resolvedLarge = v || ''; doneLarge = true; }).catch(() => { doneLarge = true; });
    pSmall.then(v => { resolvedSmall = v || ''; doneSmall = true; }).catch(() => { doneSmall = true; });
    const both = Promise.all([pLarge, pSmall]).catch(() => null);
    if (budget) await Promise.race([both, delayUnref(budget)]); else await both;
    imagePending = !(doneLarge && doneSmall);
    if (imagePending && typeof opts.onLate === 'function') both.then(() => opts.onLate());
  }
  if (spotifyInfo) {
    resolvedSmall = ''; // the real Spotify card has no small image
    try {
      const songId = spotifyInfo.trackId || fakeSpotifyId(`${payload.details}|${payload.state}`);
      if (typeof rpc.setSongId === 'function') rpc.setSongId(songId);
      else rpc.sync_id = songId;
      if (spotifyInfo.artistIds && spotifyInfo.artistIds.length && typeof rpc.setArtistIds === 'function') {
        rpc.setArtistIds(...spotifyInfo.artistIds);
      }
      if (spotifyInfo.albumId && typeof rpc.setAlbumId === 'function') rpc.setAlbumId(spotifyInfo.albumId);
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
        validUrl = validUrl.replace(/^http:\/\//i, 'https://'); // Discord only accepts https button links
        try {
          if (new URL(validUrl).protocol !== 'https:' || validUrl.length > 512) throw new Error('bad link');
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

  // Streaming activity: Discord only shows the purple badge for Twitch / YouTube links
  let streamUrl = '';
  if (String(payload.activityType || '').toUpperCase() === 'STREAMING' && payload.streamUrl) {
    try {
      const raw = String(payload.streamUrl).trim();
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();
      const ok = host === 'twitch.tv' || host.endsWith('.twitch.tv') || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
      if (ok) streamUrl = u.href;
    } catch (e) {}
  }
  if (streamUrl) {
    try {
      if (typeof rpc.setURL === 'function') rpc.setURL(streamUrl);
      else rpc.url = streamUrl;
    } catch (e) {}
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
  if (streamUrl) { extra.url = streamUrl; extra.type = 1; }
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
    spotifyMatched,
    imagePending,
    imageWarnings: {
      largeFailed: Boolean(!imagePending && ((rawLarge && !resolvedLarge) || largeInvalid)),
      smallFailed: Boolean(!imagePending && rawSmall && !resolvedSmall && !spotifyInfo),
      largeReason: traceLarge[traceLarge.length - 1] || (largeInvalid ? 'that is not a valid image link' : ''),
      smallReason: traceSmall[traceSmall.length - 1] || ''
    }
  };
}

const spotifyTrackCache = new Map();

async function odesliLookup(query) {
  const call = () => fetchWithTimeout(`https://api.song.link/v1-alpha.1/links?${query}&userCountry=US`,
    { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }, 6000);
  let r = await call();
  if (r.status === 429) { // asked to slow down: wait a moment and ask once more
    const asked = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 0;
    await sleep(Math.min(3000, asked ? asked * 1000 : 1200));
    r = await call();
  }
  if (!r.ok) throw new Error(`odesli ${r.status}`);
  const j = await r.json();
  const link = j?.linksByPlatform?.spotify;
  const uid = String(link?.entityUniqueId || '');
  const trackId = uid.split('::')[1] || (String(link?.url || '').match(/track\/([A-Za-z0-9]+)/) || [])[1] || '';
  if (!trackId) throw new Error('no spotify match');
  const entity = j?.entitiesByUniqueId?.[uid] || {};
  const thumb = String(entity.thumbnailUrl || '');
  const imageId = (thumb.match(/\/image\/([a-f0-9]{40})/i) || [])[1] || '';
  const artistNames = String(entity.artistName || '').split(/\s*,\s*/).filter(Boolean);
  return { trackId, imageId, title: String(entity.title || ''), artistNames };
}

// Spotify's public embed page lists the artists, cover and length of a track (no login needed)
async function fetchSpotifyEmbed(trackId) {
  try {
    const r = await fetchWithTimeout(`https://open.spotify.com/embed/track/${encodeURIComponent(trackId)}`,
      { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' } }, 4500);
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return null;
    const ent = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
    if (!ent) return null;
    const artistIds = (ent.artists || []).map(a => String(a.uri || '').split(':')[2]).filter(Boolean);
    const artistNames = (ent.artists || []).map(a => String(a.name || '')).filter(Boolean);
    const cover = (ent.coverArt?.sources || []).map(s => s.url).find(u => /\/image\/[a-f0-9]{40}/i.test(u)) || '';
    const imageId = (cover.match(/\/image\/([a-f0-9]{40})/i) || [])[1] || '';
    const durationSec = Math.round(Number(ent.duration || ent.duration_ms || 0) / 1000) || 0;
    const albumUri = String((ent.albumOfTrack && ent.albumOfTrack.uri) || (ent.album && ent.album.uri) || '');
    return { artistIds, artistNames, imageId, durationSec, albumId: albumUri.split(':')[2] || '', title: String(ent.name || ent.title || '') };
  } catch (e) {
    return null;
  }
}

// Search text for a song: no quotes, no "(From ...)" / "- Remastered" tails, only the first artist
// 22-character Spotify-style id (same song -> same id), used only when the real song can't be found
function fakeSpotifyId(seed) {
  const digest = crypto.createHash('sha256').update(String(seed || 'song')).digest();
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 22; i++) out += alphabet[digest[i] % alphabet.length];
  return out;
}

function songQuery(title, artist) {
  const t = String(title || '').replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s+-\s+.*$/, '').replace(/["“”`]/g, '').replace(/\s+/g, ' ').trim();
  const a = String(artist || '').split(/\s*(?:,|&|;|\band\b|\bfeat\.?\b|\bft\.?\b|\bx\b)\s*/i)[0].replace(/^by\s+/i, '').replace(/["“”`]/g, '').trim();
  return { t: t || String(title || '').trim(), a };
}

// Genius lists the Spotify link of most songs (public search, no account needed)
async function spotifyViaGenius(title, artist) {
  const sq = songQuery(title, artist);
  const headers = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };
  const s = await fetchJson(`https://genius.com/api/search/multi?per_page=5&q=${encodeURIComponent(`${sq.t} ${sq.a}`.trim())}`, { headers }, 6000);
  const songs = (s?.response?.sections || []).flatMap(sec => sec.hits || []).filter(h => h.type === 'song').map(h => h.result).slice(0, 4);
  const tokens = x => normSongTitle(x).split(' ').filter(Boolean);
  const overlap = (a, b) => { const A = tokens(a), B = new Set(tokens(b)); return A.length ? A.filter(w => B.has(w)).length / A.length : 0; };
  for (const song of songs) {
    const artistOk = !sq.a || normSongTitle(song.primary_artist && song.primary_artist.name || '').includes(normSongTitle(sq.a).split(' ')[0] || '~');
    if (!(sameSong(song.title, title) || sameSong(song.title_with_featured, title) || (artistOk && overlap(song.title, sq.t) >= 0.6))) continue;
    const d = await fetchJson(`https://genius.com/api/songs/${song.id}`, { headers }, 6000);
    for (const m of d?.response?.song?.media || []) {
      const mm = String(m.native_uri || m.url || '').match(/spotify[:/]+track[:/]+([A-Za-z0-9]{22})/);
      if (mm) return { trackId: mm[1], imageId: '', artistIds: [] };
    }
  }
  throw new Error('no genius spotify link');
}

// The public track page (the one used for link previews) lists the album, artists, cover and length
async function fetchSpotifyTrackPage(trackId) {
  try {
    const r = await fetchWithTimeout(`https://open.spotify.com/track/${encodeURIComponent(trackId)}`,
      { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' } }, 5000);
    if (!r.ok) return null;
    const html = await r.text();
    const all = prop => {
      const out = [];
      const a = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*?content=["']([^"']*)["']`, 'gi');
      const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${prop}["']`, 'gi');
      for (const m of html.matchAll(a)) out.push(m[1]);
      for (const m of html.matchAll(b)) out.push(m[1]);
      return out;
    };
    const one = prop => all(prop)[0] || '';
    const albumId = (one('music:album').match(/album\/([A-Za-z0-9]{22})/) || [])[1] || '';
    const artistIds = all('music:musician').map(u => (u.match(/artist\/([A-Za-z0-9]{22})/) || [])[1]).filter(Boolean);
    const durationSec = Number(one('music:duration')) || 0;
    const imageId = (one('og:image').match(/\/image\/([a-f0-9]{40})/i) || [])[1] || '';
    const title = decodeHtml(one('og:title'));
    if (!albumId && !artistIds.length && !durationSec && !imageId) return null;
    return { albumId, artistIds, durationSec, imageId, title };
  } catch (e) {
    return null;
  }
}

// same song = equal titles, ignoring "(feat. ...)" / "- Remastered" tails (never a loose "contains")
const normSongTitle = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function cleanSongTitle(t) {
  return normSongTitle(String(t || '').replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s+-\s+.*$/, ''));
}
function sameSong(a, b) {
  const x = cleanSongTitle(a), y = cleanSongTitle(b);
  const fx = normSongTitle(a), fy = normSongTitle(b);
  return Boolean(x && y && (x === y || fx === fy)); // exact (after removing the bracket/remaster tails): "Song 2" is not "Song"
}

// MusicBrainz (free, public): songs often have their Spotify link attached
async function spotifyViaMusicBrainz(title, artist) {
  const headers = { 'User-Agent': 'NexusRPC/1.0 (discord rpc website)', Accept: 'application/json' };
  const sq = songQuery(title, artist);
  const q = `recording:"${sq.t}" AND artist:"${sq.a}"`;
  const found = await fetchJson(`https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=5`, { headers }, 6000);
  const recs = (found.recordings || []).filter(r => sameSong(r.title, title)).slice(0, 3);
  for (const rec of recs) {
    const d = await fetchJson(`https://musicbrainz.org/ws/2/recording/${rec.id}?inc=url-rels&fmt=json`, { headers }, 6000);
    for (const rel of d.relations || []) {
      const m = String(rel.url && rel.url.resource || '').match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/);
      if (m) return { trackId: m[1], imageId: '', artistIds: [] };
    }
  }
  throw new Error('no musicbrainz spotify link');
}

// Finds Spotify track ids in a search results page: plain links, redirect links (Yahoo/DuckDuckGo), Bing's
// base64 links, and the printed address "open.spotify.com > track > ID"
function extractSpotifyIds(html, kind = 'track') {
  let text = String(html || '');
  try { text = decodeURIComponent(text); } catch (e) {}
  for (const m of String(html || '').matchAll(/[?&;]u=a1([A-Za-z0-9_-]{20,})/g)) {
    try { text += ` ${Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')}`; } catch (e) {}
  }
  const ids = [];
  const add = id => { if (id && !ids.includes(id)) ids.push(id); };
  for (const m of text.matchAll(new RegExp(`open\\.spotify\\.com\\/(?:intl-[a-z-]+\\/)?${kind}\\/([A-Za-z0-9]{22})`, 'g'))) add(m[1]);
  for (const m of text.matchAll(new RegExp(`open\\.spotify\\.com(?:\\s|&nbsp;|&rsaquo;|&#8250;|›|\\/)+${kind}(?:\\s|&nbsp;|&rsaquo;|&#8250;|›|\\/)+([A-Za-z0-9]{22})`, 'g'))) add(m[1]);
  return ids.slice(0, 5);
}
const extractSpotifyTrackIds = html => extractSpotifyIds(html, 'track');

// the web-search part shared by the song search and the album-cover search
async function searchSpotifyPageIds(queryText, kind) {
  const q = `site:open.spotify.com/${kind} ${queryText}`.trim();
  const pages = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}`,
    `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`,
    `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`
  ];
  const fetchPage = async u => {
    const r = await fetchWithTimeout(u, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' } }, 6000);
    if (!r.ok) throw new Error(`search ${r.status}`);
    const ids = extractSpotifyIds(await r.text(), kind);
    if (!ids.length) throw new Error('no spotify links');
    return ids;
  };
  return Promise.any(pages.map(fetchPage));
}

// Spotify's public oEmbed: title + cover of a track / album page
async function fetchSpotifyOEmbed(kind, id) {
  try {
    const r = await fetchWithTimeout(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${kind}/${id}`)}`,
      { headers: { 'User-Agent': BROWSER_UA } }, 5000);
    if (!r.ok) return null;
    const j = await r.json();
    return { title: String(j.title || ''), imageId: (String(j.thumbnail_url || '').match(/\/image\/([a-f0-9]{40})/i) || [])[1] || '' };
  } catch (e) {
    return null;
  }
}

// A real Spotify cover even when the song itself isn't found: find the ALBUM on Spotify instead
const albumCoverCache = new Map();
async function findSpotifyAlbumCover(album, artist) {
  const sq = songQuery(album, artist);
  if (!sq.t) return '';
  const key = `${sq.t}|${sq.a}`.toLowerCase();
  const hit = albumCoverCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.id;
  let id = '';
  try {
    const ids = await searchSpotifyPageIds(`${sq.t} ${sq.a}`, 'album');
    for (const albumId of ids) {
      const o = await fetchSpotifyOEmbed('album', albumId);
      if (o && o.imageId && sameSong(o.title, album)) { id = o.imageId; break; }
    }
  } catch (e) {}
  while (albumCoverCache.size >= 300) albumCoverCache.delete(albumCoverCache.keys().next().value);
  albumCoverCache.set(key, { id, exp: Date.now() + (id ? 6 * 3600 * 1000 : 60 * 1000) });
  return id;
}

// No account or keys needed: find the song's public Spotify page through a web search, then check it with
// Spotify's public oEmbed (title + cover) so we never pick a wrong song.
async function spotifySearchScrape(title, artist) {
  const sq = songQuery(title, artist);
  const ids = await searchSpotifyPageIds(`${sq.t} ${sq.a}`, 'track');
  for (const id of ids) {
    const o = await fetchSpotifyOEmbed('track', id);
    if (!o || !sameSong(o.title, title)) continue;
    return { trackId: id, imageId: o.imageId, artistIds: [] };
  }
  throw new Error('no matching spotify page');
}

// Maps an Apple Music / iTunes track to the real Spotify track (id, cover, artists) so Discord can draw the
// native Spotify card. Returns null if not found.
const spotifyLookupInflight = new Map();
async function lookupSpotifyTrack(appleUrl, appleTrackId, hint = {}, opts = {}) {
  const k = `${String(appleTrackId || '').replace(/\D/g, '') || String(appleUrl || '')}|${hint && hint.title ? `${hint.title}|${hint.artist || ''}` : ''}|${opts.fresh ? 'f' : ''}`;
  let job = spotifyLookupInflight.get(k);
  if (!job) {
    job = lookupSpotifyTrackInner(appleUrl, appleTrackId, hint, opts).finally(() => spotifyLookupInflight.delete(k));
    spotifyLookupInflight.set(k, job);
  }
  return job;
}

async function lookupSpotifyTrackInner(appleUrl, appleTrackId, hint = {}, opts = {}) {
  const url = String(appleUrl || '');
  const itunesId = String(appleTrackId || '').replace(/\D/g, '');
  const hasHint = Boolean(hint && hint.title);
  if (!itunesId && !/^https?:\/\//i.test(url) && !hasHint) return null;
  const key = `${itunesId || url}|${hasHint ? `${hint.title}|${hint.artist || ''}` : ''}`;
  const hit = spotifyTrackCache.get(key);
  if (!opts.fresh && hit && hit.exp > Date.now()) return hit.info;

  const odesliChain = async () => {
    const calls = [];
    if (itunesId) calls.push(odesliLookup(`platform=itunes&type=song&id=${itunesId}`));
    if (/^https?:\/\//i.test(url)) {
      let clean = url;
      try { const u = new URL(url); const i = u.searchParams.get('i'); clean = `${u.origin}${u.pathname}${i ? `?i=${i}` : ''}`; } catch (e) {}
      calls.push(odesliLookup(`url=${encodeURIComponent(clean)}`));
    }
    if (calls.length) {
      try { return await Promise.any(calls); } catch (e) {}
    }
    if (itunesId) return odesliLookup(`platform=appleMusic&type=song&id=${itunesId}`); // same song, other id type
    throw new Error('no odesli match');
  };
  const sources = () => {
    const list = [];
    if (itunesId || /^https?:\/\//i.test(url)) list.push(odesliChain());
    if (hasHint) {
      list.push(spotifySearchScrape(String(hint.title), String(hint.artist || '')));
      list.push(spotifyViaMusicBrainz(String(hint.title), String(hint.artist || '')));
      list.push(spotifyViaGenius(String(hint.title), String(hint.artist || '')));
    }
    return list;
  };
  let info = null;
  try {
    const first = sources();
    if (first.length) info = await Promise.any(first);
  } catch (e) {
    await sleep(600); // one more try (rate limit / hiccup)
    try {
      const retry = sources();
      if (retry.length) info = await Promise.any(retry);
    } catch (e2) {}
  }
  if (info) {
    // the real Spotify page: exact title, artists, cover and length
    const [extra, page, oembed] = await Promise.all([fetchSpotifyEmbed(info.trackId), fetchSpotifyTrackPage(info.trackId), fetchSpotifyOEmbed('track', info.trackId)]);
    const pick = (...lists) => lists.find(l => Array.isArray(l) && l.length) || [];
    info = {
      ...info,
      imageId: info.imageId || extra?.imageId || page?.imageId || oembed?.imageId || '',
      artistIds: pick(info.artistIds, extra?.artistIds, page?.artistIds),
      artistNames: (extra?.artistNames && extra.artistNames.length) ? extra.artistNames : (info.artistNames || []),
      durationSec: extra?.durationSec || page?.durationSec || 0,
      albumId: info.albumId || extra?.albumId || page?.albumId || '',
      title: extra?.title || page?.title || info.title || ''
    };
  }
  while (spotifyTrackCache.size >= 500) spotifyTrackCache.delete(spotifyTrackCache.keys().next().value);
  spotifyTrackCache.set(key, { info, exp: Date.now() + (info ? 6 * 3600 * 1000 : 5 * 1000) });
  return info;
}

/* ---------- Streaming apps: the server builds the activity (so "next episode"/"random" work 24/7) ---------- */
const MEDIA_CONFIG = {
  spotify: { name: 'Spotify', type: 'LISTENING', appId: process.env.APP_ID_SPOTIFY || '463151177836658699', button: 'Play on Spotify', defaultEnd: 'restart' },
  netflix: { name: 'Netflix', type: 'WATCHING', appId: process.env.APP_ID_NETFLIX || '926541425682829352', button: 'Watch on Netflix', defaultEnd: 'next' },
  crunchyroll: { name: 'Crunchyroll', type: 'WATCHING', appId: process.env.APP_ID_CRUNCHYROLL || '765315211329994762', button: 'Watch', defaultEnd: 'next' },
  youtube: { name: 'YouTube', type: 'WATCHING', appId: process.env.APP_ID_YOUTUBE || '463097721130188830', button: 'Watch Video', defaultEnd: 'restart' }
};
const NETFLIX_LOGO_URL = 'https://www.google.com/s2/favicons?domain=netflix.com&sz=128';
const MEDIA_END_MODES = ['restart', 'stop', 'next', 'random', 'none'];
const clipText = (v, n) => String(v == null ? '' : v).slice(0, n);

function sanitizeMediaItem(it) {
  it = it && typeof it === 'object' ? it : {};
  const out = {
    title: clipText(it.title, 150),
    subtitle: clipText(it.subtitle, 150),
    album: clipText(it.album, 150),
    icon: clipText(it.icon, 600),
    iconAlt: clipText(it.iconAlt, 600),
    durationSec: Math.max(0, Math.min(Number(it.durationSec) || 0, 24 * 3600)),
    appleUrl: clipText(it.appleUrl, 600),
    appleTrackId: Number(it.appleTrackId) || 0,
    showId: Number(it.showId) || 0,
    episodes: Math.max(0, Math.min(Number(it.episodes) || 0, 5000)),
    videoUrl: clipText(it.videoUrl, 300),
    authorUrl: clipText(it.authorUrl, 300),
    episodeTitles: {}
  };
  if (it.episodeTitles && typeof it.episodeTitles === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(it.episodeTitles)) {
      if (++n > 400) break;
      if (/^\d+$/.test(k)) out.episodeTitles[k] = clipText(v, 150);
    }
  }
  return out;
}

const isDiscordId = v => /^\d{17,20}$/.test(String(v || '').trim());

function buildMediaPayload(spec) {
  const media = spec && spec.media && typeof spec.media === 'object' ? spec.media : {};
  const kind = MEDIA_CONFIG[media.kind] ? media.kind : 'spotify';
  const cfg = MEDIA_CONFIG[kind];
  const appId = cfg.appId; // the built-in Discord application of each service (name + icon)
  const item = sanitizeMediaItem(media.item);
  const ep = media.episode && typeof media.episode === 'object' ? media.episode : {};
  const epNumber = Math.max(1, Math.min(parseInt(ep.number, 10) || 1, 5000));
  const nf = kind === 'netflix' && ep.netflix && ep.netflix.season ? {
    season: Math.max(1, Math.min(parseInt(ep.netflix.season, 10) || 1, 200)),
    number: Math.max(1, Math.min(parseInt(ep.netflix.number, 10) || 1, 5000)),
    name: clipText(ep.netflix.name, 150),
    runtime: Math.max(0, Math.min(Number(ep.netflix.runtime) || 0, 600))
  } : null;

  const title = item.title;
  const artist = item.subtitle.replace(/^by\s+/i, '').replace(/^YouTube\s•\s/, '');
  const q = encodeURIComponent(`${title} ${artist}`.trim());
  let state = item.subtitle;
  let hover = item.album || title;
  let duration = 0;
  let buttons = [];

  if (kind === 'spotify') {
    state = item.subtitle.replace(/^by\s+/i, '').replace(/\s+&\s+/g, ', ');
    duration = item.durationSec || 210;
    buttons = [{ label: cfg.button, url: `https://open.spotify.com/search/${q}` }];
  } else if (kind === 'crunchyroll') {
    state = item.episodeTitles[epNumber] || `Episode ${epNumber}`;
    hover = `Season 1, Episode ${epNumber}`; // this wording is what makes Discord draw the visible "S1E5" line
    duration = item.durationSec || 1440;
    buttons = [{ label: cfg.button, url: `https://www.crunchyroll.com/search?q=${encodeURIComponent(title)}` }];
  } else if (kind === 'netflix') {
    if (nf) { state = nf.name; hover = `Season ${nf.season}, Episode ${nf.number}`; }
    duration = (nf && nf.runtime ? nf.runtime * 60 : 0) || item.durationSec || 2700; // 45 min when unknown
    buttons = [{ label: cfg.button, url: `https://www.netflix.com/search?q=${encodeURIComponent(title)}` }];
  } else {
    state = /^YouTube\s•\s/.test(item.subtitle) ? `by ${item.subtitle.replace(/^YouTube\s•\s/, '')}` : item.subtitle;
    duration = item.durationSec || 600; // 10 min when the video length is unknown
    buttons = [{ label: cfg.button, url: item.videoUrl || `https://www.youtube.com/results?search_query=${q}` }];
    if (item.authorUrl) buttons.push({ label: 'View Channel', url: item.authorUrl });
  }
  if (!title) buttons = [];

  let onEnd = MEDIA_END_MODES.includes(spec.onEnd) ? spec.onEnd : cfg.defaultEnd;
  if (onEnd === 'next' && !(kind === 'crunchyroll' || kind === 'netflix')) onEnd = 'restart';
  if (!(duration > 0)) onEnd = 'none';

  return {
    slot: 'media',
    mediaKind: kind,
    appId,
    activityType: cfg.type,
    name: cfg.name,
    details: title,
    state,
    statusType: clipText(spec.statusType || 'online', 12),
    device: clipText(spec.device || 'desktop', 12),
    largeImage: item.icon,
    largeText: hover || title,
    smallImage: kind === 'netflix' ? NETFLIX_LOGO_URL : '', // only Netflix has a small image: its logo
    smallText: kind === 'netflix' ? 'Netflix' : '',
    timestampMode: duration > 0 ? 'progress' : 'now',
    // Spotify + Crunchyroll show a progress bar (start + end). Netflix + YouTube send only the start time, so
    // Discord shows an elapsed timer (no bar); the end time is still tracked here for "when it ends".
    timeStyle: (kind === 'netflix' || kind === 'youtube') ? 'elapsed' : 'bar',
    durationSec: duration,
    elapsedSec: 0,
    loop: onEnd === 'restart' && duration > 0,
    onEnd,
    restart: Boolean(spec.restart),
    statusDisplayType: 'name',
    detailsUrl: '',
    buttons,
    spotifyLookupUrl: kind === 'spotify' ? item.appleUrl : '',
    appleTrackId: kind === 'spotify' ? item.appleTrackId : 0,
    media: { kind, item, episode: { number: epNumber, index: Number.isInteger(ep.index) ? ep.index : null, netflix: nf } }
  };
}

const showEpisodeCache = new Map();
async function fetchShowEpisodes(showId) {
  const id = String(showId || '').replace(/\D/g, '').slice(0, 9);
  if (!id) return [];
  const hit = showEpisodeCache.get(id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.episodes;
  const data = await fetchJson(`https://api.tvmaze.com/shows/${id}/episodes`, {}, 6000);
  const episodes = (Array.isArray(data) ? data : [])
    .filter(e => e && e.season && e.number)
    .slice(0, 600)
    .map(e => ({ season: e.season, number: e.number, name: String(e.name || `Episode ${e.number}`).slice(0, 120), runtime: e.runtime || 0 }));
  while (showEpisodeCache.size >= 100) showEpisodeCache.delete(showEpisodeCache.keys().next().value);
  showEpisodeCache.set(id, { at: Date.now(), episodes });
  return episodes;
}

async function nextMediaSpec(p) {
  const m = p.media;
  if (!m) return null;
  const base = { slot: 'media', statusType: p.statusType, device: p.device, onEnd: p.onEnd, restart: true };
  if (m.kind === 'crunchyroll') {
    const total = m.item.episodes || 0;
    const n = (m.episode.number || 1) + 1;
    if (total && n > total) return null;
    return { ...base, media: { kind: m.kind, item: m.item, episode: { number: n } } };
  }
  if (m.kind === 'netflix') {
    if (!m.item.showId || !Number.isInteger(m.episode.index)) return null;
    const list = await fetchShowEpisodes(m.item.showId);
    const idx = m.episode.index + 1;
    if (idx >= list.length) return null;
    return { ...base, media: { kind: m.kind, item: m.item, episode: { number: 1, index: idx, netflix: list[idx] } } };
  }
  return null;
}

async function randomMediaSpec(p) {
  const m = p.media;
  if (!m) return null;
  let items = [];
  try {
    if (m.kind === 'spotify' || m.kind === 'youtube') items = await searchMusic(m.kind, '');
    else if (m.kind === 'netflix') items = await searchShows('');
    else if (m.kind === 'crunchyroll') items = await searchAnimeEverywhere('');
  } catch (e) {}
  if (!items.length) items = fallbackResults(m.kind, '');
  items = items.filter(i => i && i.title && i.title !== m.item.title);
  if (!items.length) return null;
  const picked = items[Math.floor(Math.random() * items.length)];
  let episode = { number: 1 };
  if (m.kind === 'netflix') {
    episode = {};
    try {
      const list = picked.showId ? await fetchShowEpisodes(picked.showId) : [];
      if (list.length) episode = { number: 1, index: 0, netflix: list[0] };
    } catch (e) {}
  }
  return { slot: 'media', statusType: p.statusType, device: p.device, onEnd: p.onEnd, restart: true, media: { kind: m.kind, item: picked, episode } };
}

/* ---------- Icons for your own Discord apps (Discord shows the APP's icon next to your name and in voice) ---------- */
// Your large image as a square 512x512 app icon (first frame if it is a GIF)
async function renderAppIcon(url) {
  if (!sharpLib || !/^https?:\/\//i.test(String(url || ''))) return null;
  const dl = await downloadRemote(String(url), 9000);
  if (!dl || dl.kind !== 'image') return null;
  try {
    return await runShrinkJob(() => sharpLib(dl.buffer, { limitInputPixels: 120e6 }).rotate().resize(512, 512, { fit: 'cover' }).png().toBuffer());
  } catch (e) {
    return null; // not a picture sharp can read
  }
}

app.get('/api/img', async (req, res) => {
  try {
    const u = typeof req.query.u === 'string' ? req.query.u.trim() : '';
    if (!/^https?:\/\//i.test(u) || u.length > 1500) return res.status(400).send('Bad link');
    const dl = await downloadRemote(u, 9000);
    if (!dl || dl.kind !== 'image') return res.status(404).send('Could not load that picture');
    return res.set({ 'Content-Type': dl.mime, 'Cache-Control': 'public, max-age=86400' }).send(dl.buffer);
  } catch (e) {
    return res.status(500).send('Could not load that picture');
  }
});

app.get('/api/app-icon', async (req, res) => {
  try {
    const png = await renderAppIcon(req.query.url);
    if (!png) return res.status(404).send('Could not read that image. Upload it first, then try again.');
    return res.set({ 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="my-app-icon.png"', 'Cache-Control': 'no-store' }).send(png);
  } catch (e) {
    return res.status(500).send('Could not make the icon');
  }
});

// Two activities can be live at once, like real Discord: "game" (Playing...) and "media" (Listening / Watching)
const SLOT_NAMES = ['game', 'media'];
function liveSlots(entry) {
  return SLOT_NAMES
    .map(s => [s, entry.slots[s]])
    .filter(([, p]) => p && p.name && String(p.name).trim());
}
function refreshPrimary(entry) {
  entry.activeRPC = entry.slots.game || entry.slots.media || null; // kept for older code paths / responses
}
const lateResyncSeen = new WeakSet();
// An image/song that was still loading when presence went live: update presence once it is ready
function queueLateResync(entry, slot, payload) {
  if (lateResyncSeen.has(payload)) return;
  lateResyncSeen.add(payload);
  const t = setTimeout(() => {
    if (entry.slots[slot] !== payload || !entry.client || !entry.info.connected) return;
    syncFullDiscordPresence(entry, { late: true }).catch(() => {});
  }, 30);
  if (t.unref) t.unref();
}
const delayUnref = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

/* --- Rotating presets: cycles the "game" activity through a list on a timer (one timer per session) --- */
function stopRotation(entry) {
  if (entry.rotationTimer) { clearInterval(entry.rotationTimer); entry.rotationTimer = null; }
  entry.rotation = null;
}

async function startRotation(entry, payloads, everyMs) {
  stopRotation(entry);
  const list = payloads
    .filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
    .slice(0, 10)
    .map(p => ({ ...p, slot: 'game' }));
  if (list.length < 2) throw new Error('Pick at least 2 presets to rotate.');
  entry.rotation = { count: list.length, everyMs };
  let i = 0;
  const step = async () => {
    if (!entry.rotation || !entry.client || !entry.info.connected) return;
    const p = { ...list[i % list.length] };
    i++;
    delete p._anchoredStart;
    delete p._anchoredEnd;
    entry.slots.game = p;
    entry.lastSlot = 'game';
    refreshPrimary(entry);
    try { await syncFullDiscordPresence(entry, { focusSlot: 'game' }); } catch (e) {}
  };
  await step();
  entry.rotationTimer = setInterval(step, everyMs);
  if (entry.rotationTimer.unref) entry.rotationTimer.unref();
}

// What happens when the progress bar ends: restart / stop / next episode / random / nothing
function scheduleMediaLoop(entry) {
  if (entry.loopTimer) { clearTimeout(entry.loopTimer); entry.loopTimer = null; }
  if (entry.prepTimer) { clearTimeout(entry.prepTimer); entry.prepTimer = null; }
  const p = entry.slots.media;
  if (!p || p.timestampMode !== 'progress' || !p._anchoredEnd || !entry.info.connected) return;
  const onEnd = p.onEnd || (p.loop ? 'restart' : 'none');
  if (onEnd === 'none') return;
  const msLeft = p._anchoredEnd - Date.now();
  entry.loopTimer = setTimeout(() => {
    entry.loopTimer = null;
    runMediaEnd(entry, p, onEnd, 0);
  }, Math.max(250, msLeft + 150));
  if (entry.loopTimer.unref) entry.loopTimer.unref();
  // the next item is prepared ~45s early (search, cover, Spotify match), so the switch itself is instant
  if (onEnd === 'random' || onEnd === 'next') {
    entry.prepTimer = setTimeout(() => {
      entry.prepTimer = null;
      prepareNextForEnd(entry, p, onEnd).catch(() => {});
    }, Math.max(0, msLeft - 45000));
    if (entry.prepTimer.unref) entry.prepTimer.unref();
  }
}

// runs the "when it ends" action; if the connection is down for a moment (or something fails) it tries again
function runMediaEnd(entry, p, onEnd, attempt) {
  const retry = () => {
    if (attempt >= 3 || entry.slots.media !== p) return;
    entry.loopTimer = setTimeout(() => { entry.loopTimer = null; runMediaEnd(entry, p, onEnd, attempt + 1); }, 5000);
    if (entry.loopTimer.unref) entry.loopTimer.unref();
  };
  handleMediaEnd(entry, p, onEnd).then(done => { if (done === false) retry(); }).catch(retry);
}

async function prepareNextForEnd(entry, p, onEnd) {
  if (entry.slots.media !== p || !entry.client) return;
  const spec = onEnd === 'next' ? await nextMediaSpec(p) : await randomMediaSpec(p);
  if (!spec || entry.slots.media !== p) return;
  const np = buildMediaPayload(spec);
  entry.prepared = { from: p, payload: np };
  // warm everything the new card needs, so nothing has to be fetched when the song/episode ends
  if (np.largeImage) resolveExternalImage(entry.client, np.appId, np.largeImage, entry.token).catch(() => {});
  if (np.smallImage) resolveExternalImage(entry.client, np.appId, np.smallImage, entry.token).catch(() => {});
  if (np.mediaKind === 'spotify') {
    lookupSpotifyTrack(np.spotifyLookupUrl, np.appleTrackId, { title: np.details, artist: np.state, durationSec: np.durationSec }).catch(() => {});
  }
}

async function settleAfterRemoval(entry) {
  if (liveSlots(entry).length > 0) { await syncFullDiscordPresence(entry); return; }
  entry.info.activeGame = null;
  entry.info.activeDetails = null;
  entry.info.activeSlots = { game: null, media: null };
  await forceClearActivityOnClient(entry);
}

async function handleMediaEnd(entry, p, onEnd) {
  if (entry.slots.media !== p) return true; // already changed by you: nothing to do
  if (!entry.client || !entry.info.connected) return false; // connection is down right now: try again shortly
  if (onEnd === 'restart') { await syncFullDiscordPresence(entry); return true; }
  if (onEnd === 'stop') {
    entry.slots.media = null;
    refreshPrimary(entry);
    await settleAfterRemoval(entry);
    return true;
  }
  // next episode / random: use the item that was prepared in advance, or build it now
  let np = null;
  const prep = entry.prepared;
  entry.prepared = null;
  if (prep && prep.from === p) np = prep.payload;
  if (!np) {
    let nextSpec = null;
    try { nextSpec = onEnd === 'next' ? await nextMediaSpec(p) : await randomMediaSpec(p); } catch (e) {}
    if (!nextSpec) {
      if (onEnd === 'next') { // last episode watched
        entry.slots.media = null;
        refreshPrimary(entry);
        await settleAfterRemoval(entry);
      } else {
        await syncFullDiscordPresence(entry); // random failed: just restart this one
      }
      return true;
    }
    np = buildMediaPayload(nextSpec);
  }
  entry.slots.media = np;
  entry.lastSlot = 'media';
  refreshPrimary(entry);
  await syncFullDiscordPresence(entry, { focusSlot: 'media' });
  return true;
}


async function syncFullDiscordPresence(entry, syncOpts = {}) {
  if (!entry.client || !entry.info.connected) return { imageWarnings: {}, bySlot: {} };

  const syncSeq = (entry.syncSeq = (entry.syncSeq || 0) + 1);
  const live = liveSlots(entry);
  const lastPayload = entry.slots[entry.lastSlot];
  const statusVal = (lastPayload && lastPayload.statusType)
    || (live.map(([, p]) => p.statusType).find(Boolean))
    || (entry.customStatus && entry.customStatus.statusType)
    || 'online';

  try {
    entry.client.user.setStatus(statusVal);
  } catch (e) {}

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
    entry.info.customStatus = entry.customStatus;
  } else {
    entry.info.customStatus = null;
  }

  // Build every live activity at the same time. Images that are slow to prepare don't hold up going live:
  // presence is sent right away and updated again as soon as they are ready.
  const results = await Promise.allSettled(live.map(([slot, payload]) =>
    buildRichPresence(entry.client, payload, entry.device, entry.token, {
      budgetMs: syncOpts.late ? 6000 : 0, // 0 = wait until the image/GIF is fully ready before going live
      onLate: () => queueLateResync(entry, slot, payload)
    })
  ));

  // A newer update started while this one was preparing images: let the newer one be the only one that
  // is sent, so an old, slower update can never overwrite it with stale data.
  if (syncSeq !== entry.syncSeq) {
    const stale = {};
    results.forEach((r, i) => { if (r.status === 'fulfilled') stale[live[i][0]] = r.value; });
    const sf = stale[syncOpts.focusSlot] || {};
    return { imageWarnings: sf.imageWarnings || {}, spotifyNative: Boolean(sf.spotifyNative), imagePending: false, bySlot: stale, superseded: true };
  }

  const bySlot = {};
  entry.lastActivityBySlot = {};
  results.forEach((r, i) => {
    const slot = live[i][0];
    if (r.status === 'fulfilled') {
      bySlot[slot] = r.value;
      activities.push(r.value.rpc);
      try {
        entry.lastActivityBySlot[slot] = JSON.parse(JSON.stringify(typeof r.value.rpc.toJSON === 'function' ? r.value.rpc.toJSON() : r.value.rpc));
      } catch (e) {}
    } else if (slot === syncOpts.focusSlot) {
      throw r.reason; // the activity the user just set failed: tell them
    }
    // another slot failing must not take down the one that works
  });
  entry.lastActivity = entry.lastActivityBySlot[entry.slots.game ? 'game' : 'media'] || null;

  const primary = entry.slots.game || entry.slots.media;
  entry.info.activeGame = primary && primary.name ? primary.name.trim() : null;
  entry.info.activeDetails = primary && primary.details ? String(primary.details).trim() : null;
  entry.info.activeSlots = {
    game: entry.slots.game && entry.slots.game.name ? entry.slots.game.name.trim() : null,
    media: entry.slots.media && entry.slots.media.name ? entry.slots.media.name.trim() : null
  };

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

  // image/GIF still missing after everything: quietly try again in 15s and 60s (host or Discord may recover)
  entry.imageRetryTimers = entry.imageRetryTimers || {};
  for (const [slot, built] of Object.entries(bySlot)) {
    const w = built.imageWarnings || {};
    if (entry.imageRetryTimers[slot]) { clearTimeout(entry.imageRetryTimers[slot]); entry.imageRetryTimers[slot] = null; }
    const attempt = (syncOpts.retryAttempt || 0) + 1;
    if ((w.largeFailed || w.smallFailed) && attempt <= 2) {
      const payload = entry.slots[slot];
      const t = setTimeout(() => {
        entry.imageRetryTimers[slot] = null;
        if (entry.slots[slot] !== payload || !entry.client || !entry.info.connected) return;
        syncFullDiscordPresence(entry, { retryAttempt: attempt }).catch(() => {});
      }, attempt === 1 ? 15000 : 60000);
      if (t.unref) t.unref();
      entry.imageRetryTimers[slot] = t;
    }
  }

  // a Spotify song that wasn't found yet: try again after 20s and 70s, then switch to the real Spotify card
  entry.spotifyRetryTimers = entry.spotifyRetryTimers || {};
  for (const [slot, built] of Object.entries(bySlot)) {
    const pl = entry.slots[slot];
    if (entry.spotifyRetryTimers[slot]) { clearTimeout(entry.spotifyRetryTimers[slot]); entry.spotifyRetryTimers[slot] = null; }
    const attempt = (syncOpts.spotifyAttempt || 0) + 1;
    if (pl && pl.mediaKind === 'spotify' && built.spotifyMatched === false && typeof SpotifyRPC === 'function' && attempt <= 2) {
      const t = setTimeout(() => {
        entry.spotifyRetryTimers[slot] = null;
        if (entry.slots[slot] !== pl || !entry.client || !entry.info.connected) return;
        pl._spotifyFresh = true;
        syncFullDiscordPresence(entry, { spotifyAttempt: attempt }).catch(() => {});
      }, attempt === 1 ? 20000 : 70000);
      if (t.unref) t.unref();
      entry.spotifyRetryTimers[slot] = t;
    }
  }

  const focus = bySlot[syncOpts.focusSlot] || bySlot[SLOT_NAMES.find(s => bySlot[s])] || {};
  return {
    imageWarnings: focus.imageWarnings || {},
    spotifyNative: Boolean(focus.spotifyNative),
    spotifyMatched: Boolean(focus.spotifyMatched),
    imagePending: Boolean(focus.imagePending),
    bySlot
  };
}

// If an account has "Display current activity as a status message" turned off, NO ONE can see its RPC.
// That is why it showed up on some accounts and not on others. Check it and switch it on.
async function ensureActivitySharing(entry) {
  const out = { checked: false, enabled: null, fixed: false };
  if (!entry.token) return out;
  const headers = {
    Authorization: entry.token,
    'Content-Type': 'application/json',
    'User-Agent': BROWSER_UA,
    Origin: 'https://discord.com',
    Referer: 'https://discord.com/channels/@me'
  };
  try {
    const r = await fetchWithTimeout('https://discord.com/api/v9/users/@me/settings', { headers }, 6000);
    if (!r.ok) return out;
    const s = await r.json();
    out.checked = true;
    out.enabled = s.show_current_game !== false;
    if (s.show_current_game === false) {
      const p = await fetchWithTimeout('https://discord.com/api/v9/users/@me/settings', {
        method: 'PATCH', headers, body: JSON.stringify({ show_current_game: true })
      }, 6000);
      if (p.ok) { out.enabled = true; out.fixed = true; }
    }
  } catch (e) {}
  return out;
}

function start247KeepAlive(entry) {
  if (entry.keepAliveTimer) clearInterval(entry.keepAliveTimer);
  entry.reconnectFails = 0;
  entry.nextReconnectAt = 0;
  entry.keepAliveTimer = setInterval(async () => {
    if (!entry.token || entry.reconnecting) return;
    if (entry.client && entry.info.connected) { entry.reconnectFails = 0; return; }
    if (Date.now() < entry.nextReconnectAt) return;
    entry.reconnecting = true;
    try {
      await loginSessionWithToken(entry, entry.token, 1, entry.device);
      entry.reconnectFails = 0;
    } catch (e) {
      entry.reconnectFails = (entry.reconnectFails || 0) + 1;
      if (/invalid or expired/i.test(String(e && e.message))) {
        entry.token = null; // token is dead: stop retrying
        entry.info.connected = false;
      }
      // 1m, 2m, 4m ... max 10m between attempts (never hammer Discord)
      entry.nextReconnectAt = Date.now() + Math.min(10 * 60 * 1000, 30000 * 2 ** Math.min(entry.reconnectFails, 5));
    } finally {
      entry.reconnecting = false;
    }
  }, 45 * 1000);
  if (entry.keepAliveTimer.unref) entry.keepAliveTimer.unref();
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

      // make sure other people can actually see the activity (runs before we answer, so the page can tell the user)
      try {
        entry.info.activitySharing = await ensureActivitySharing(entry);
      } catch (e) {}
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

const catalogCache = new Map();
function cacheGet(key) {
  const hit = catalogCache.get(key);
  return hit && Date.now() - hit.at < 10 * 60 * 1000 ? hit.results : null;
}
function cacheSet(key, results) {
  while (catalogCache.size >= 300) catalogCache.delete(catalogCache.keys().next().value);
  catalogCache.set(key, { at: Date.now(), results });
}
async function fetchJson(url, opts = {}, ms = 6000) {
  const r = await fetchWithTimeout(url, opts, ms);
  if (!r.ok) throw new Error(`http ${r.status}`);
  return r.json();
}

// Built-in lists: used only when every online source fails, so the tab is never empty
const FALLBACK_ANIME = ['Attack on Titan', 'Demon Slayer', 'Jujutsu Kaisen', 'One Piece', 'Naruto Shippuden', 'My Hero Academia', 'Death Note', 'Fullmetal Alchemist: Brotherhood', 'Chainsaw Man', 'Spy x Family', 'Solo Leveling', 'Bleach', 'Dragon Ball Z', 'Hunter x Hunter', 'Tokyo Ghoul', 'Vinland Saga', "Frieren: Beyond Journey's End", 'One Punch Man', 'Sword Art Online', 'Dr. Stone', 'Haikyu!!', 'Black Clover', 'Fire Force', 'Mob Psycho 100', 'Cowboy Bebop', 'Steins;Gate', 'Code Geass', 'Re:Zero', 'Kaguya-sama: Love is War', 'Blue Lock', 'Oshi no Ko', 'Dandadan', 'Bocchi the Rock!', 'Cyberpunk: Edgerunners', 'Neon Genesis Evangelion', 'Violet Evergarden'];
const FALLBACK_SHOWS = ['Stranger Things', 'Wednesday', 'Squid Game', 'Money Heist', 'Breaking Bad', 'Dark', 'The Witcher', 'Narcos', 'Peaky Blinders', 'Ozark', 'Bridgerton', 'The Crown', 'Lupin', 'You', 'Black Mirror', 'Arcane', 'Cobra Kai', 'Sex Education', 'Outer Banks', 'Better Call Saul', 'The Umbrella Academy', 'Love, Death & Robots', 'Mindhunter', 'Beef'];
const FALLBACK_SONGS = [['Blinding Lights', 'The Weeknd'], ['Shape of You', 'Ed Sheeran'], ['Starboy', 'The Weeknd'], ['Levitating', 'Dua Lipa'], ['As It Was', 'Harry Styles'], ['Believer', 'Imagine Dragons'], ['Bad Guy', 'Billie Eilish'], ['Stay', 'The Kid LAROI'], ['Heat Waves', 'Glass Animals'], ['Sunflower', 'Post Malone'], ['Cruel Summer', 'Taylor Swift'], ['Flowers', 'Miley Cyrus'], ['Die For You', 'The Weeknd'], ['Lose Yourself', 'Eminem'], ['Counting Stars', 'OneRepublic'], ['Industry Baby', 'Lil Nas X'], ['Save Your Tears', 'The Weeknd'], ['Peaches', 'Justin Bieber'], ['Montero', 'Lil Nas X'], ['Numb', 'Linkin Park']];

function makeAnimeItem({ title, romaji, episodes, durationMin, icon, episodeTitles }) {
  return {
    title,
    episodes: episodes || 24,
    subtitle: episodes ? `Episode 1 of ${episodes} • Crunchyroll` : 'Episode 1 • Crunchyroll',
    album: romaji || title,
    icon: icon || '', // no cover: Discord shows the app's own icon (no third-party image host involved)
    durationSec: durationMin ? Math.round(durationMin * 60) : 1440,
    episodeTitles: episodeTitles || {}
  };
}

// AniList lists Crunchyroll's own episode names as "Episode 5 - Title"
function parseEpisodeTitles(list) {
  const out = {};
  for (const ep of Array.isArray(list) ? list : []) {
    const m = ep && ep.title ? String(ep.title).match(/^Episode\s+(\d+)\s*[-–:]\s*(.+)$/i) : null;
    if (m && !out[Number(m[1])]) out[Number(m[1])] = m[2].trim();
  }
  return out;
}

function fallbackResults(platform, query) {
  const q = String(query || '').toLowerCase();
  const pick = list => {
    const matches = q ? list.filter(x => String(Array.isArray(x) ? x.join(' ') : x).toLowerCase().includes(q)) : shuffleArray(list).slice(0, 18);
    return matches;
  };
  let items = [];
  if (platform === 'crunchyroll') items = pick(FALLBACK_ANIME).map(t => makeAnimeItem({ title: t }));
  else if (platform === 'netflix') items = pick(FALLBACK_SHOWS).map(t => ({ title: t, subtitle: 'Netflix Series', album: t, icon: '', durationSec: 2700 }));
  else items = pick(FALLBACK_SONGS).map(([t, a]) => ({
    title: t, subtitle: platform === 'youtube' ? `YouTube • ${a}` : `by ${a}`, album: t, icon: '', durationSec: 210, appleUrl: ''
  }));
  if (items.length === 0 && query) {
    // nothing matched: let the user use exactly what they typed
    if (platform === 'crunchyroll') items = [makeAnimeItem({ title: query })];
    else if (platform === 'netflix') items = [{ title: query, subtitle: 'Netflix', album: query, icon: '', durationSec: 2700 }];
    else items = [{ title: query, subtitle: platform === 'youtube' ? 'YouTube' : 'by Unknown artist', album: query, icon: '', durationSec: 210, appleUrl: '' }];
  }
  return items.map(i => ({ ...i, _fallback: true }));
}

async function searchAnimeEverywhere(searchTerm) {
  const query = (searchTerm || '').trim();

  const fromAniList = async () => {
    const randomPage = Math.floor(Math.random() * 12) + 1;
    const fields = 'title { romaji english } episodes duration coverImage { extraLarge large } streamingEpisodes { title site }';
    const gql = query
      ? `query ($search: String) { Page(page: 1, perPage: 20) { media(search: $search, type: ANIME, sort: POPULARITY_DESC) { ${fields} } } }`
      : `query ($page: Int) { Page(page: $page, perPage: 20) { media(type: ANIME, sort: TRENDING_DESC) { ${fields} } } }`;
    const j = await fetchJson('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': BROWSER_UA },
      body: JSON.stringify({ query: gql, variables: query ? { search: query } : { page: randomPage } })
    });
    const list = j?.data?.Page?.media || [];
    if (!list.length) throw new Error('empty');
    return list.map(m => makeAnimeItem({
      title: m.title.english || m.title.romaji,
      romaji: m.title.romaji,
      episodes: m.episodes,
      durationMin: m.duration,
      icon: m.coverImage?.extraLarge || m.coverImage?.large,
      episodeTitles: parseEpisodeTitles(m.streamingEpisodes)
    }));
  };

  const fromJikan = async () => {
    const url = query
      ? `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=20`
      : `https://api.jikan.moe/v4/top/anime?page=${Math.floor(Math.random() * 8) + 1}&limit=20`;
    const j = await fetchJson(url, { headers: { 'User-Agent': BROWSER_UA } });
    if (!Array.isArray(j.data) || !j.data.length) throw new Error('empty');
    return j.data.map(a => makeAnimeItem({
      title: a.title_english || a.title,
      romaji: a.title,
      episodes: a.episodes,
      durationMin: parseInt(String(a.duration || '').match(/\d+/)?.[0] || '0', 10) || 0,
      icon: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url
    }));
  };

  const fromKitsu = async () => {
    const url = query
      ? `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=20`
      : `https://kitsu.io/api/edge/trending/anime?limit=20`;
    const j = await fetchJson(url, { headers: { Accept: 'application/vnd.api+json', 'User-Agent': BROWSER_UA } });
    if (!Array.isArray(j.data) || !j.data.length) throw new Error('empty');
    return j.data.map(d => {
      const a = d.attributes || {};
      return makeAnimeItem({
        title: a.titles?.en || a.titles?.en_jp || a.canonicalTitle,
        romaji: a.canonicalTitle,
        episodes: a.episodeCount,
        durationMin: a.episodeLength,
        icon: a.posterImage?.large || a.posterImage?.original
      });
    });
  };

  // all three at once: the first one that answers wins (fast, and one being down doesn't matter)
  try {
    return await Promise.any([fromAniList(), fromJikan(), fromKitsu()]);
  } catch (e) {
    return [];
  }
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
  let live = 0;
  for (const e of userSessions.values()) if (e.info.connected) live++;
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    liveSessions: live
  });
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

async function searchMusic(platform, query) {
  const term = query || RANDOM_MUSIC_SEEDS[Math.floor(Math.random() * RANDOM_MUSIC_SEEDS.length)];
  const subtitleOf = artist => (platform === 'youtube' ? `YouTube • ${artist}` : `by ${artist}`);
  try {
    const data = await fetchJson(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=24`);
    const items = (data.results || []).map(item => ({
      title: item.trackName || item.collectionName,
      subtitle: subtitleOf(item.artistName),
      album: item.collectionName || item.trackName,
      icon: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
      iconAlt: item.artworkUrl100 || '',
      durationSec: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : 0,
      appleUrl: item.trackViewUrl || '',
      appleTrackId: item.trackId || 0
    })).filter(i => i.title);
    if (items.length) return items;
  } catch (e) {}
  // iTunes unreachable or empty: Deezer (free, with big covers)
  const d = await fetchJson(`https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=24`);
  return (d.data || []).map(t => ({
    title: t.title,
    subtitle: subtitleOf(t.artist && t.artist.name || 'Unknown artist'),
    album: (t.album && t.album.title) || t.title,
    icon: (t.album && (t.album.cover_xl || t.album.cover_big)) || '',
    iconAlt: (t.album && (t.album.cover_medium || t.album.cover)) || '',
    durationSec: Number(t.duration) || 0,
    appleUrl: '',
    appleTrackId: 0
  })).filter(i => i.title);
}

async function searchShows(query) {
  let rawShows = [];
  if (query) {
    const data = await fetchJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`);
    rawShows = (data || []).map(entry => entry.show).filter(Boolean);
  } else {
    const pageData = await fetchJson(`https://api.tvmaze.com/shows?page=${Math.floor(Math.random() * 15)}`);
    rawShows = shuffleArray(pageData || []).slice(0, 20);
  }
  return rawShows.slice(0, 20).map(s => ({
    title: s.name,
    subtitle: s.genres && s.genres.length ? s.genres.join(' • ') : 'Netflix Series',
    album: s.name,
    icon: s.image ? (s.image.original || s.image.medium) : '',
    durationSec: (s.averageRuntime || s.runtime) ? Math.round((s.averageRuntime || s.runtime) * 60) : 0,
    showId: s.id || 0
  }));
}

const episodeCache = new Map();
app.get('/api/show-episodes', async (req, res) => {
  try {
    return res.json({ episodes: await fetchShowEpisodes(req.query.id) });
  } catch (e) {
    return res.json({ episodes: [] });
  }
});

app.get('/api/media-search', async (req, res) => {
  const platform = String(req.query.platform || 'spotify').toLowerCase();
  const query = String(req.query.q || '').trim().slice(0, 100);
  const key = query ? `${platform}:${query.toLowerCase()}` : '';

  if (key) {
    const hit = cacheGet(key);
    if (hit) return res.json({ results: hit });
  }

  let results = [];
  try {
    if (platform === 'spotify' || platform === 'youtube') results = await searchMusic(platform, query);
    else if (platform === 'netflix') results = await searchShows(query);
    else if (platform === 'crunchyroll') results = await searchAnimeEverywhere(query);
  } catch (err) {
    results = [];
  }

  // an online source being down must never leave the tab empty
  if (results.length === 0) results = fallbackResults(platform, query);
  if (!query) results = shuffleArray(results).slice(0, 20); // nothing typed = a fresh random mix every time
  if (key && results.length && !results[0]._fallback) cacheSet(key, results);
  return res.json({ results });
});

async function fetchYouTubeDuration(videoId) {
  try {
    const r = await fetchWithTimeout(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' }
    }, 4500);
    if (!r.ok) return 0;
    const html = await r.text();
    const m = html.match(/"lengthSeconds":"(\d+)"/);
    const n = m ? Number(m[1]) : 0;
    return n > 0 && n < 24 * 3600 ? n : 0;
  } catch (e) {
    return 0;
  }
}

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
  const durationPromise = fetchYouTubeDuration(videoId); // real video length for the progress bar

  try {
    const oembedResp = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`);
    if (oembedResp.ok) {
      const data = await oembedResp.json();
      return res.json({
        videoId,
        url: canonicalUrl,
        title: data.title || 'YouTube Video',
        author: data.author_name || 'YouTube Creator',
        authorUrl: data.author_url || '',
        thumbnail: data.thumbnail_url || fallbackThumb,
        durationSec: await durationPromise
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
        authorUrl: data.author_url || '',
        thumbnail: data.thumbnail_url || fallbackThumb,
        durationSec: await durationPromise
      });
    }
  } catch (e) {}

  return res.json({
    videoId,
    url: canonicalUrl,
    title: 'Watching YouTube Video',
    author: 'YouTube',
    thumbnail: fallbackThumb,
    durationSec: await durationPromise
  });
});

const APP_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5865f2"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><circle cx="256" cy="256" r="118" fill="none" stroke="#fff" stroke-width="30" stroke-dasharray="500 260" stroke-linecap="round"/><circle cx="256" cy="256" r="34" fill="#fff"/></svg>';
const iconCache = new Map();

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: 'Nexus RPC',
    short_name: 'Nexus RPC',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b1220',
    theme_color: '#0b1220',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  });
});

app.get('/icon.svg', (req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(APP_ICON_SVG);
});

app.get(['/icon-192.png', '/icon-512.png'], async (req, res) => {
  const size = req.path.includes('512') ? 512 : 192;
  try {
    if (!sharpLib) return res.redirect('/icon.svg');
    if (!iconCache.has(size)) iconCache.set(size, await sharpLib(Buffer.from(APP_ICON_SVG)).resize(size, size).png().toBuffer());
    return res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(iconCache.get(size));
  } catch (e) {
    return res.redirect('/icon.svg');
  }
});

app.get('/sw.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache')
    .send("self.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', e => e.waitUntil(self.clients.claim()));\nself.addEventListener('fetch', () => {});\n");
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
    activeRPC: entry.activeRPC,
    activeSlots: entry.slots,
    rotation: entry.rotation || null
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
      activeRPC: entry.activeRPC,
      activeSlots: entry.slots
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

  stopRotation(entry);
  entry.token = null;
  entry.activeRPC = null;
  entry.slots = { game: null, media: null };
  entry.info = defaultInfo();
  res.json({ success: true });
});

app.post('/api/rotation/start', async (req, res) => {
  const entry = getOrCreateSession(getSessionId(req));
  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }
  const payloads = Array.isArray(req.body?.payloads) ? req.body.payloads : [];
  const minutes = Number(req.body?.everyMinutes);
  const everyMs = Math.min(6 * 3600 * 1000, Math.max(30 * 1000, (isFinite(minutes) ? minutes : 2) * 60 * 1000));
  try {
    await startRotation(entry, payloads, everyMs);
    return res.json({ success: true, session: entry.info, activeSlots: entry.slots, rotation: entry.rotation });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not start rotation.' });
  }
});

app.post('/api/rotation/stop', (req, res) => {
  const entry = getOrCreateSession(getSessionId(req));
  stopRotation(entry);
  res.json({ success: true });
});

// Fire-and-forget: the page calls this when an image/song is picked so the later Start/Broadcast is instant
app.post('/api/prewarm-image', (req, res) => {
  res.json({ ok: true });
  (async () => {
    try {
      const entry = getOrCreateSession(getSessionId(req));
      if (!entry.client || !entry.info.connected) return;
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      const appleUrl = typeof req.body?.appleUrl === 'string' ? req.body.appleUrl.trim() : '';
      const appleTrackId = String(req.body?.appleTrackId || '').replace(/\D/g, '').slice(0, 14);
      if (/^https?:\/\//i.test(url) && url.length < 2000) {
        const appId = (entry.activeRPC && entry.activeRPC.appId) || '463151177836658699';
        await resolveExternalImage(entry.client, appId, url, entry.token);
      }
      const hint = req.body?.hint && typeof req.body.hint === 'object'
        ? { title: clipText(req.body.hint.title, 150), artist: clipText(req.body.hint.artist, 150), durationSec: Number(req.body.hint.durationSec) || 0 }
        : {};
      if ((appleUrl && appleUrl.length < 2000) || appleTrackId || hint.title) await lookupSpotifyTrack(appleUrl, appleTrackId, hint);
    } catch (e) {}
  })();
});

// Quick health check for "my RPC isn't visible": is activity sharing on, what status is sent
app.get('/api/diagnose', async (req, res) => {
  const entry = getOrCreateSession(getSessionId(req));
  if (!entry.info.connected) return res.status(400).json({ error: 'Connect your account first.' });
  const sharing = await ensureActivitySharing(entry);
  entry.info.activitySharing = sharing;
  res.json({
    connected: true,
    activitySharing: sharing,
    liveActivities: liveSlots(entry).map(([slot, p]) => ({ slot, name: p.name, type: p.activityType })),
    status: (entry.slots[entry.lastSlot] && entry.slots[entry.lastSlot].statusType) || 'online',
    lastImageProblem: assetDiag.last || ''
  });
});

// Shows the exact activity object last built for this session (to check buttons/images are included)
app.get('/api/debug-activity', (req, res) => {
  const entry = getOrCreateSession(getSessionId(req));
  res.json({ activity: entry.lastActivity || null, activities: entry.lastActivityBySlot || {} });
});

app.post('/set-rpc', async (req, res) => {
  const sid = getSessionId(req);
  const entry = getOrCreateSession(sid);

  if (!entry.info.connected || !entry.client) {
    return res.status(400).json({ error: 'Connect your account first.' });
  }

  let payload = req.body && typeof req.body === 'object' ? req.body : {};
  if (payload.media && payload.media.kind) payload = buildMediaPayload(payload); // streaming apps: built here
  if (!payload.name || !String(payload.name).trim()) {
    return res.status(400).json({ error: 'Give your activity a name first.' });
  }

  try {
    const prevDevice = entry.device || 'desktop';
    const nextDevice = payload.device || prevDevice;
    const slot = payload.slot === 'media' ? 'media' : 'game';
    payload.slot = slot;
    if (slot === 'game' && !payload._fromRotation) stopRotation(entry); // a manual choice overrides rotation
    const prevRpc = entry.slots[slot];
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
    entry.slots[slot] = payload;
    entry.lastSlot = slot;
    refreshPrimary(entry);

    let syncResult = { imageWarnings: {} };
    if (nextDevice !== prevDevice && entry.token) {
      await loginSessionWithToken(entry, entry.token, 1, nextDevice);
    } else {
      syncResult = await syncFullDiscordPresence(entry, { focusSlot: slot });
    }

    return res.json({
      success: true,
      session: entry.info,
      activeRPC: entry.activeRPC,
      activeSlots: entry.slots,
      imageWarnings: syncResult.imageWarnings || {},
      spotifyNative: Boolean(syncResult.spotifyNative),
      spotifyMatched: Boolean(syncResult.spotifyMatched),
      imagePending: Boolean(syncResult.imagePending)
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

  // Optional { slot: 'game' | 'media' } stops just one activity; no slot stops everything
  const only = req.body && (req.body.slot === 'game' || req.body.slot === 'media') ? req.body.slot : null;
  if (only) entry.slots[only] = null;
  else entry.slots = { game: null, media: null };
  if (!only || only === 'game') stopRotation(entry);
  if (!only || only === 'media') {
    if (entry.loopTimer) { clearTimeout(entry.loopTimer); entry.loopTimer = null; }
  }
  refreshPrimary(entry);

  if (entry.info.connected && entry.client) {
    if (liveSlots(entry).length > 0) {
      await syncFullDiscordPresence(entry); // the other activity stays live
    } else {
      entry.info.activeGame = null;
      entry.info.activeDetails = null;
      entry.info.activeSlots = { game: null, media: null };
      await forceClearActivityOnClient(entry);
      await new Promise(r => setTimeout(r, 120));
      await forceClearActivityOnClient(entry);
    }
  } else {
    entry.info.activeGame = null;
    entry.info.activeDetails = null;
  }

  res.json({
    success: true,
    session: entry.info,
    activeSlots: entry.slots
  });
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Image file is too large. Keep it under 12 MB.' });
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
const server = app.listen(PORT, () => console.log(`Nexus RPC running 24/7 on port ${PORT}`));
server.keepAliveTimeout = 65 * 1000; // longer than most proxies' idle timeout (avoids random 502s)
server.headersTimeout = 66 * 1000;
server.requestTimeout = 60 * 1000;

// Clean shutdown on redeploy/restart
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  for (const entry of userSessions.values()) {
    try { if (entry.client) entry.client.destroy(); } catch (e) {}
  }
  server.close(() => process.exit(0));
  const t = setTimeout(() => process.exit(0), 4000);
  if (t.unref) t.unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Memory guard: if RAM gets high, drop the cheapest caches before the host kills the process
const MEMORY_SOFT_LIMIT_MB = parseInt(process.env.MEMORY_SOFT_LIMIT_MB || '400', 10);
const memGuard = setInterval(() => {
  const mb = process.memoryUsage().rss / 1048576;
  if (mb < MEMORY_SOFT_LIMIT_MB) return;
  console.warn(`Memory high (${Math.round(mb)} MB): trimming caches`);
  const keep = Math.floor(hostedMemoryImages.size / 2);
  while (hostedMemoryImages.size > keep) hostedMemoryImages.delete(hostedMemoryImages.keys().next().value);
  spotifyTrackCache.clear();
}, 60 * 1000);
if (memGuard.unref) memGuard.unref();
