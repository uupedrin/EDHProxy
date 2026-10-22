const DEFAULT_SETTINGS = { syncEnabled: true, uploadLocal: true, showOthers: true, server: 'https://ntfy.sh' };
const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let arts = {};
// The popup can't read the page, so it uses the language the content script last saw on edhplay.
let lang = chrome.i18n.getUILanguage();
const t = (key, vars) => EA_I18N.t(lang, key, vars);

function applyStaticText() {
  document.documentElement.lang = EA_I18N.pick(lang);
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  // Only our own fixed strings (with <b>) go through innerHTML.
  for (const e of document.querySelectorAll('[data-i18n-html]')) e.innerHTML = t(e.dataset.i18nHtml);
}

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) e.append(c);
  return e;
}

async function saveSettings() {
  settings = {
    syncEnabled: $('syncEnabled').checked,
    showOthers: $('showOthers').checked,
    uploadLocal: $('uploadLocal').checked,
    server: $('server').value.trim() || DEFAULT_SETTINGS.server,
  };
  await chrome.storage.local.set({ settings });
}

function renderArts() {
  const list = $('arts');
  list.textContent = '';
  const entries = Object.entries(arts).sort((a, b) => (a[1].label || '').localeCompare(b[1].label || ''));
  $('count').textContent = entries.length ? `(${entries.length})` : '';
  if (!entries.length) {
    list.append(el('li', { className: 'empty', textContent: t('emptyArts') }));
    return;
  }
  for (const [key, a] of entries) {
    const scope = key.startsWith('name:') ? t('scopeName') : t('scopeId');
    const local = a.u.startsWith('data:') ? t('localSuffix') : '';
    const remove = el('button', { className: 'remove', textContent: '✕', title: t('remove') });
    remove.onclick = async () => {
      delete arts[key];
      await chrome.storage.local.set({ arts });
      renderArts();
    };
    list.append(el('li', {}, [
      el('img', { src: a.u, alt: '' }),
      el('div', { className: 'info' }, [
        el('div', { className: 'label', textContent: a.label || key }),
        el('div', { className: 'meta', textContent: `${scope}${local}` }),
      ]),
      remove,
    ]));
  }
}

async function renderStatus() {
  const box = $('status');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let status = null;
  try {
    status = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
  } catch {
    // Not an edhplay tab (or the page loaded before the extension was installed).
  }
  box.textContent = '';
  if (!status) {
    box.append(t('statusNoTab'));
    return;
  }
  if (!status.room) {
    box.append(t('statusNoRoom'));
    return;
  }
  if (!status.syncing) {
    box.append(el('span', { className: 'dot' }), t('statusSyncOff'));
    return;
  }
  box.append(
    el('span', { className: 'dot ' + (status.connected ? 'ok' : 'bad') }),
    status.connected ? t('statusSyncing') : t('statusConnecting'),
  );
  if (status.peers.length) {
    box.append(el('ul', { className: 'peers' }, status.peers.map((p, i) =>
      el('li', { textContent: `${p.name || t('player', { n: i + 1 })} — ${p.count === 1 ? t('arts1') : t('artsN', { n: p.count })}` }))));
  } else {
    box.append(el('p', { className: 'small', textContent: t('statusAlone') }));
  }
}

$('export').onclick = async () => {
  const { library = {} } = await chrome.storage.local.get('library');
  const blob = new Blob([JSON.stringify({ version: 1, arts, library }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'edhproxy-arts.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('import').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const f = $('importFile').files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = data && data.arts;
    if (!incoming || typeof incoming !== 'object') throw new Error(t('invalidFile'));
    const validUrl = (u) => typeof u === 'string' && /^(https:|data:image\/)/.test(u);
    for (const [k, a] of Object.entries(incoming)) {
      if (/^(id:|name:)/.test(k) && a && validUrl(a.u)) arts[k] = a;
    }
    const { library = {} } = await chrome.storage.local.get('library');
    for (const [name, list] of Object.entries(data.library || {})) {
      if (!Array.isArray(list)) continue;
      const merged = library[name] || [];
      for (const e of list) {
        if (e && validUrl(e.u) && !merged.some(x => x.u === e.u && x.m === e.m)) {
          const entry = { id: e.id || crypto.randomUUID(), u: e.u, m: 'full', t: e.t || Date.now() };
          if (typeof e.n === 'string' && e.n) entry.n = e.n.slice(0, 40);
          merged.push(entry);
        }
      }
      if (merged.length) library[name] = merged;
    }
    await chrome.storage.local.set({ arts, library });
    renderArts();
  } catch (e) {
    alert(t('importError', { msg: e.message }));
  }
  $('importFile').value = '';
};

for (const id of ['syncEnabled', 'showOthers', 'uploadLocal']) $(id).addEventListener('change', saveSettings);
$('server').addEventListener('change', saveSettings);

(async () => {
  const data = await chrome.storage.local.get(['settings', 'arts', 'siteLang', 'update']);
  if (data.siteLang) lang = data.siteLang;
  applyStaticText();
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  if (data.update) {
    $('update').hidden = false;
    $('updateTitle').textContent = t('updateAvailable', { version: data.update.version });
    $('updateLink').href = data.update.url;
    $('updateNow').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('update.html') });
  }
  settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  arts = data.arts || {};
  $('syncEnabled').checked = settings.syncEnabled;
  $('showOthers').checked = settings.showOthers;
  $('uploadLocal').checked = settings.uploadLocal;
  $('server').value = settings.server;
  renderArts();
  renderStatus();
  setInterval(renderStatus, 2000);
})();
