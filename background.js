// Service worker: does cross-origin fetches the content script can't do because of CORS.

importScripts('i18n.js');

// ---------- health of the services the extension uses (for the popup's status dots) ----------
// For each: when it last answered, how long it took, and the last error. Kept in session
// storage, since the service worker can be stopped between uses.
const SERVICES = {
  ntfy: { slow: 3000 },      // the room channel
  litterbox: { slow: 20000 }, // temporary copies of local files
  tmpfiles: { slow: 20000 },  // backup for litterbox
  scryfall: { slow: 3000 },  // card names, mana symbols
  github: { slow: 5000 },    // update checks
};
let health = {};
const healthReady = chrome.storage.session.get('health').then(({ health: saved }) => { health = { ...(saved || {}), ...health }; });

function noteHealth(service, ok, ms, error) {
  const h = health[service] || {};
  if (ok) Object.assign(h, { ok: true, at: Date.now(), ms, error: null, fails: 0 });
  else Object.assign(h, { ok: false, at: Date.now(), ms, error: String(error).slice(0, 120), fails: (h.fails || 0) + 1 });
  health[service] = h;
  chrome.storage.session.set({ health }).catch(() => {});
}

// fetch, noting how the service did. Non-2xx answers count as failures.
async function trackedFetch(service, url, options) {
  const started = Date.now();
  try {
    const res = await fetch(url, options);
    noteHealth(service, res.ok, Date.now() - started, res.ok ? null : 'HTTP ' + res.status);
    return res;
  } catch (e) {
    noteHealth(service, false, Date.now() - started, e && e.name === 'TimeoutError' ? 'timeout' : (e && e.message) || e);
    throw e;
  }
}

// Card names by Scryfall id. A page full of cards asks for many at once, so ids are collected for
// a moment and fetched 75 at a time (/cards/collection) instead of one request each; one card
// per request took minutes on big pages, long enough for the browser to stop the service worker
// with answers still pending. Batches go one after another with a small gap (Scryfall asks for
// <= 10 requests/s).
const COLLECTION_MAX = 75;
const waitingCards = new Map(); // id -> [{ resolve, reject }]
let cardTimer = null;
let scryfallChain = Promise.resolve();

const namesOf = (card) => (card.card_faces && !card.image_uris
  ? [card.card_faces[0].name, card.card_faces[1].name]
  : [card.name, card.name]);

function cardInfo(id) {
  return new Promise((resolve, reject) => {
    if (!waitingCards.has(id)) waitingCards.set(id, []);
    waitingCards.get(id).push({ resolve, reject });
    if (!cardTimer) cardTimer = setTimeout(flushCards, 50);
  });
}

function flushCards() {
  cardTimer = null;
  const batch = [...waitingCards].slice(0, COLLECTION_MAX);
  for (const [id] of batch) waitingCards.delete(id);
  if (waitingCards.size) cardTimer = setTimeout(flushCards, 50);
  scryfallChain = scryfallChain.then(async () => {
    try {
      const res = await trackedFetch('scryfall', 'https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ identifiers: batch.map(([id]) => ({ id })) }),
        signal: AbortSignal.timeout(15000),
      });
      // One malformed id fails the whole batch (400): then ask for each card on its own.
      if (res.status === 400 && batch.length > 1) {
        for (const [id, waiters] of batch) {
          await new Promise(r => setTimeout(r, 120));
          try {
            const one = await trackedFetch('scryfall', `https://api.scryfall.com/cards/${id}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
            if (!one.ok) throw new Error('HTTP ' + one.status);
            const names = namesOf(await one.json());
            for (const w of waiters) w.resolve({ names });
          } catch (e) {
            for (const w of waiters) w.reject(e);
          }
        }
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const found = new Map(((await res.json()).data || []).map(card => [card.id, card]));
      for (const [id, waiters] of batch) {
        const card = found.get(id);
        for (const w of waiters) card ? w.resolve({ names: namesOf(card) }) : w.reject(new Error('card not found'));
      }
    } catch (e) {
      for (const [, waiters] of batch) for (const w of waiters) w.reject(e);
    }
  }).then(() => new Promise(r => setTimeout(r, 120)));
}

// Temporary public hosting for local files, so other players in the room can load them.
// tmpfiles.org keeps files 60 minutes. Its lasting link is the file's page
// (https://tmpfiles.org/<id>/<name>); the image itself is behind a signed link that the page
// hands out and that works for about 5 minutes, so whoever shows it asks the page for a fresh one.
const TMPFILES_PAGE_RX = /^https:\/\/tmpfiles\.org\/(?!dl\/)[\w-]+\/[^/?#]+$/i;
const tmpfilesLinks = new Map(); // page URL -> { url, exp }

async function tmpfiles(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append('file', blob, 'card.' + ((blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')));
  const res = await trackedFetch('tmpfiles', 'https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('tmpfiles HTTP ' + res.status);
  const url = ((await res.json().catch(() => ({}))).data || {}).url || '';
  if (!TMPFILES_PAGE_RX.test(url)) throw new Error('tmpfiles: unexpected answer');
  return url;
}

async function tmpfilesImageUrl(page) {
  const cached = tmpfilesLinks.get(page);
  if (cached && cached.exp > Date.now()) return cached.url;
  const res = await trackedFetch('tmpfiles', page, { credentials: 'omit', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('tmpfiles HTTP ' + res.status);
  const m = (await res.text()).match(/https:\/\/tmpfiles\.org\/dl\/[^"'\s<>]+/);
  if (!m) throw new Error('tmpfiles: file not found (expired?)');
  tmpfilesLinks.set(page, { url: m[0], exp: Date.now() + 3 * 60 * 1000 });
  return m[0];
}

// Temporary public copy of a local file: litterbox, or tmpfiles when litterbox fails.
async function hostFile(dataUrl) {
  // litterbox failing over and over (down): skip it for a while.
  const lb = health.litterbox;
  if (lb && !lb.ok && lb.fails >= 2 && Date.now() - lb.at < 10 * 60 * 1000) return tmpfiles(dataUrl);
  try {
    return await litterbox(dataUrl);
  } catch (e) {
    console.warn('[EDHProxy] litterbox failed, using tmpfiles', e);
    return tmpfiles(dataUrl);
  }
}

async function litterbox(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', '1h');
  fd.append('fileToUpload', blob, 'card.' + ((blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')));
  const res = await trackedFetch('litterbox', 'https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const text = (await res.text()).trim();
  // Errors come back as whole HTML pages (its firewall's); keep the message short.
  if (!res.ok) throw new Error('litterbox HTTP ' + res.status);
  if (!/^https:\/\/\S+$/.test(text)) throw new Error('litterbox: ' + (text.length > 80 || /</.test(text) ? 'unexpected answer' : text));
  return text;
}

// Paints Archidekt's foil overlay: linear-gradient(-60deg, purple, blue, green, yellow, red) at
// 15% opacity, following the CSS rules for where an angled gradient line starts and ends.
function paintFoil(ctx, w, h) {
  const angle = (-60 * Math.PI) / 180;
  const dx = Math.sin(angle), dy = -Math.cos(angle);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = w / 2, cy = h / 2;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  ['purple', 'blue', 'green', 'yellow', 'red'].forEach((color, i) => g.addColorStop(i / 4, color));
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
}

// Renders a card image for display: shrunk to the width Scryfall would serve for that spot (a big
// image squeezed straight into a thumbnail looks jagged) and/or with the foil overlay. Returns
// null when nothing needs to change (no foil and already about that size).
// asData: always return a data URL, even when nothing changes. Playmats are CSS backgrounds,
// which can't skip the Referer like <img referrerpolicy> does, and hosts like Scryfall or imgur
// refuse hotlinks from edhplay; a data URL sidesteps that.
async function renderImage(url, width, foil, asData) {
  // A tmpfiles page link: fetch the image through it, and always hand back a copy (the page
  // itself can't be shown as an image).
  if (TMPFILES_PAGE_RX.test(url)) {
    url = await tmpfilesImageUrl(url);
    asData = true;
  }
  // Generous: playmats are big and litterbox can be slow; this only guards against a stuck request.
  const blob = await (await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(120000) })).blob();
  const full = await createImageBitmap(blob);
  const shrink = width && full.width > width * 1.2;
  if (!shrink && !foil) {
    full.close();
    return asData ? blobToDataUrl(blob) : null;
  }
  let bitmap = full;
  if (shrink) {
    const height = Math.round(full.height * width / full.width);
    full.close();
    bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (foil) paintFoil(ctx, canvas.width, canvas.height);
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 }));
}

// Scryfall's mana symbol SVGs, as data URLs: svgs.scryfall.io refuses requests that carry
// edhplay's Referer, so the page can't load them itself.
async function manaSymbol(file) {
  if (!/^[A-Z0-9½∞]{1,4}$/.test(file)) throw new Error('bad symbol');
  const res = await trackedFetch('scryfall', `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(file)}.svg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return blobToDataUrl(await res.blob());
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function publish(url, body) {
  const res = await trackedFetch('ntfy', url, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return true;
}

// ---------- updates ----------
// Releases live on GitHub and the extension is installed unpacked from a folder. The "Update now"
// page (update.html) or the user replaces that folder's files; the extension notices and reloads.

const REPO = (chrome.runtime.getManifest().homepage_url || '').replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');

async function reloadIfFilesChanged() {
  try {
    const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (onDisk.version !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch {
    // Files are being replaced right now; try again on the next tick.
  }
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// "↑" on the toolbar icon, plus a tooltip in the site's language; clicking opens the popup,
// which shows the "Update now" button.
async function showUpdateBadge(update) {
  const { siteLang } = await chrome.storage.local.get('siteLang');
  const lang = siteLang || chrome.i18n.getUILanguage();
  // Some Chromium browsers lack parts of chrome.action (setBadgeTextColor is Chrome 110+).
  const call = (fn, arg) => { try { const p = fn && fn(arg); if (p && p.catch) p.catch(() => {}); } catch {} };
  call(chrome.action.setBadgeText, { text: update ? '↑' : '' });
  call(chrome.action.setBadgeBackgroundColor, { color: '#0891b2' });
  call(chrome.action.setBadgeTextColor, { color: '#ffffff' });
  call(chrome.action.setTitle, {
    title: update ? `${manifestName()} — ${EA_I18N.t(lang, 'updateAvailable', { version: update.version })}` : manifestName(),
  });
}

const manifestName = () => chrome.runtime.getManifest().name;

// Returns { result: 'available' | 'latest' | 'error', detail } (for the popup's "Check for updates").
async function checkForUpdate() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) return { result: 'error', detail: 'no repository in manifest.json' };
  let release;
  try {
    const res = await trackedFetch('github', `https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { result: 'error', detail: `GitHub ${res.status}` };
    release = await res.json();
  } catch (e) {
    // Offline or blocked; the next check will try again.
    return { result: 'error', detail: String(e && e.message || e) };
  }
  const latest = String(release.tag_name || '').replace(/^v/, '');
  const update = isNewer(latest, chrome.runtime.getManifest().version) ? { version: latest, url: release.html_url } : null;
  await chrome.storage.local.set({ update });
  await showUpdateBadge(update).catch(() => {});
  return { result: update ? 'available' : 'latest' };
}

// The badge doesn't survive a browser restart; put it back from the last check right away.
// (A manual update by extracting the zip leaves a stale notice behind, hence the version check.)
chrome.storage.local.get('update').then(({ update }) => {
  showUpdateBadge(update && isNewer(update.version, chrome.runtime.getManifest().version) ? update : null);
});

chrome.alarms.create('files', { periodInMinutes: 1 });
chrome.alarms.create('update', { periodInMinutes: 360 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'files') reloadIfFilesChanged();
  else if (alarm.name === 'update') checkForUpdate();
});
chrome.runtime.onStartup.addListener(checkForUpdate);
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  checkForUpdate();
  if (reason !== 'update') return;
  // Open edhplay tabs still run the old content script. Reload them, except games in progress.
  const tabs = await chrome.tabs.query({ url: ['https://edhplay.com/*', 'https://www.edhplay.com/*'] });
  for (const tab of tabs) if (!/\/games\//.test(tab.url || '')) chrome.tabs.reload(tab.id);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'health') { await healthReady; sendResponse({ ok: true, health, services: SERVICES }); }
      else if (msg.type === 'cardInfo') sendResponse({ ok: true, ...(await cardInfo(msg.id)) });
      else if (msg.type === 'manaSymbol') sendResponse({ ok: true, url: await manaSymbol(msg.file) });
      else if (msg.type === 'publish') sendResponse({ ok: await publish(msg.url, msg.body) });
      else if (msg.type === 'litterbox') sendResponse({ ok: true, url: await hostFile(msg.dataUrl) });
      else if (msg.type === 'checkUpdate') sendResponse({ ok: true, ...(await checkForUpdate()) });
      else if (msg.type === 'render') sendResponse({ ok: true, url: await renderImage(msg.url, msg.width, msg.foil, msg.asData) });
      else sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});
