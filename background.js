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

async function checkForUpdate() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const release = await res.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    const update = isNewer(latest, chrome.runtime.getManifest().version) ? { version: latest, url: release.html_url } : null;
    await chrome.storage.local.set({ update });
    await showUpdateBadge(update);
  } catch {
    // Offline or rate-limited; the next check will try again.
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
      else sendResponse({ ok: false, error: 'unknown message' });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});
