// Updates the unpacked extension in place: downloads the release zip from GitHub and writes it
// into the extension's own folder, which the user grants once through the File System Access
// API. Writing manifest.json last and reloading makes the browser pick up the new files.

const $ = (id) => document.getElementById(id);
const manifest = chrome.runtime.getManifest();
const REPO = (manifest.homepage_url || '').replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '');
let lang = chrome.i18n.getUILanguage();
const t = (key, vars) => EA_I18N.t(lang, key, vars);

// ---------- the granted folder handle, kept in IndexedDB ----------

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('edhpa-updater', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadHandle() {
  const store = (await db()).transaction('handles').objectStore('handles');
  return new Promise((resolve) => {
    const req = store.get('extensionDir');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function saveHandle(handle) {
  const tx = (await db()).transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, 'extensionDir');
  return new Promise((resolve) => { tx.oncomplete = resolve; });
}

// The folder must be this extension: same name, and the version that is running right now.
async function isExtensionFolder(dir) {
  try {
    const file = await (await dir.getFileHandle('manifest.json')).getFile();
    const onDisk = JSON.parse(await file.text());
    return onDisk.name === manifest.name && onDisk.version === manifest.version;
  } catch {
    return false;
  }
}

async function getFolder(forcePick) {
  let dir = forcePick ? null : await loadHandle();
  if (!dir) {
    dir = await window.showDirectoryPicker({ id: 'edhpa-extension', mode: 'readwrite' });
    await saveHandle(dir);
  }
  if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted'
    && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new Error(t('upd_denied'));
  }
  if (!(await isExtensionFolder(dir))) {
    $('pick').classList.remove('hidden');
    throw new Error(t('upd_wrongFolder'));
  }
  return dir;
}

async function writeFile(root, path, data) {
  const parts = path.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

// ---------- flow ----------

let latest = null;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

async function update(forcePick) {
  $('go').disabled = $('pick').disabled = true;
  try {
    const dir = await getFolder(forcePick);
    setStatus(t('upd_downloading'));
    const res = await fetch(`https://github.com/${REPO}/releases/download/v${latest}/edhproxy.zip`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const files = await unzip(await res.arrayBuffer());
    const newManifest = files.find(f => f.path === 'manifest.json');
    if (!newManifest) throw new Error('manifest.json not found in the release');

    setStatus(t('upd_writing'));
    for (const f of files) if (f !== newManifest) await writeFile(dir, f.path, f.data);
    await writeFile(dir, 'manifest.json', newManifest.data);

    setStatus(t('upd_done', { version: latest }), 'ok');
    await chrome.storage.local.set({ update: null });
    setTimeout(() => chrome.runtime.reload(), 1200);
  } catch (e) {
    // Closing the folder picker is not an error worth showing.
    if (e && e.name === 'AbortError') setStatus('');
    else setStatus(t('upd_failed', { msg: e.message || e }), 'error');
    $('go').disabled = $('pick').disabled = false;
  }
}

function isNewer(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function findLatest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return String((await res.json()).tag_name || '').replace(/^v/, '');
}

(async () => {
  const data = await chrome.storage.local.get(['siteLang']);
  if (data.siteLang) lang = data.siteLang;
  document.documentElement.lang = EA_I18N.pick(lang);
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  document.title = t('upd_title');

  $('go').onclick = () => update(false);
  $('pick').onclick = () => update(true);
  $('go').disabled = true;
  try {
    latest = await findLatest();
  } catch (e) {
    setStatus(t('upd_failed', { msg: e.message }), 'error');
    return;
  }
  const current = manifest.version;
  if (!isNewer(latest, current)) {
    $('versions').textContent = t('upd_upToDate', { current });
    return;
  }
  $('versions').textContent = t('upd_versions', { current, latest });
  $('go').disabled = false;
})();
