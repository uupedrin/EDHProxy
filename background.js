// Service worker: does cross-origin fetches the content script can't do because of CORS.

importScripts('i18n.js');

// Scryfall asks for <= 10 requests/s, so lookups are serialized with a small gap.
let scryfallChain = Promise.resolve();
function cardInfo(id) {
  const run = scryfallChain.then(async () => {
    const res = await fetch(`https://api.scryfall.com/cards/${id}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const card = await res.json();
    const faces = card.card_faces && !card.image_uris
      ? [card.card_faces[0].name, card.card_faces[1].name]
      : [card.name, card.name];
    return { names: faces };
  });
  scryfallChain = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, 120)));
  return run;
}

// Temporary public hosting for local files, so other players in the room can load them.
async function litterbox(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', '1h');
  fd.append('fileToUpload', blob, 'card.' + ((blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')));
  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: fd });
  const text = (await res.text()).trim();
  if (!res.ok || !/^https:\/\/\S+$/.test(text)) throw new Error(text || 'HTTP ' + res.status);
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
  const blob = await (await fetch(url, { credentials: 'omit' })).blob();
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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function publish(url, body) {
  const res = await fetch(url, { method: 'POST', body });
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
  chrome.action.setBadgeText({ text: update ? '↑' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#0891b2' });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
  chrome.action.setTitle({
    title: update ? `${manifestName()} — ${EA_I18N.t(lang, 'updateAvailable', { version: update.version })}` : manifestName(),
  });
}

const manifestName = () => chrome.runtime.getManifest().name;

// Returns 'available', 'latest' or 'error' (for the popup's "Check for updates").
async function checkForUpdate() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) return 'error';
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return 'error';
    const release = await res.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const update = isNewer(latest, chrome.runtime.getManifest().version) ? { version: latest, url: release.html_url } : null;
    await chrome.storage.local.set({ update });
    await showUpdateBadge(update);
    return update ? 'available' : 'latest';
  } catch {
    // Offline or rate-limited; the next check will try again.
    return 'error';
  }
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
      if (msg.type === 'cardInfo') sendResponse({ ok: true, ...(await cardInfo(msg.id)) });
      else if (msg.type === 'publish') sendResponse({ ok: await publish(msg.url, msg.body) });
      else if (msg.type === 'litterbox') sendResponse({ ok: true, url: await litterbox(msg.dataUrl) });
      else if (msg.type === 'checkUpdate') sendResponse({ ok: true, result: await checkForUpdate() });
      else if (msg.type === 'render') sendResponse({ ok: true, url: await renderImage(msg.url, msg.width, msg.foil, msg.asData) });
      else sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});
