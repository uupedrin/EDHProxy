// Manager page with three tabs:
//   Cards: a grid of every card with uploaded arts (alphabetical). Clicking a card opens a dialog
//     like edhplay's Change Printing with its arts and where each one is in use (all decks or
//     specific decks), to rename or delete them. Choosing where an art is used stays in edhplay.
//   Playmats / Sleeves: the custom ones, which one is in use, rename or delete.

const $ = (id) => document.getElementById(id);
let lang = chrome.i18n.getUILanguage();
const t = (key, vars) => EA_I18N.t(lang, key, vars);

// library: lowercase card name -> [{ id, u, m, t, n? }]
// arts: "name:<lowercase>" | "id:<uuid>/<face>" -> { u, m, label, t }   (all decks)
// deckArts: deckId -> { "name:<lowercase>": art | { none: true } }
// playmats: [{ id, u, n?, t }], playmat: id in use | null
// sleeves: [{ id, u? | c?, n?, t }], sleeve: id in use | null
let data = { library: {}, arts: {}, deckArts: {}, deckNames: {}, playmats: [], playmat: null, sleeves: [], sleeve: null };
let tab = 'cards';
try { tab = localStorage.getItem('edhpa-manager-tab') || 'cards'; } catch {}

const DRIVE_RX = /^https:\/\/drive\.google\.com\/(?:file\/d\/|(?:open|uc)\?(?:[^#]*&)?id=)([\w-]{20,})/i;
const imageUrl = (u) => {
  const m = (u || '').match(DRIVE_RX);
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}` : u;
};

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c) e.append(c);
  return e;
}

// The card's name as written on the card, from any art saved for it.
function cardTitle(key) {
  const label = Object.values(data.arts).concat(...Object.values(data.deckArts).map(Object.values))
    .map(a => a && a.label).find(l => l && l.toLowerCase() === key);
  return label || key.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Where an art is in use: all decks, and/or the decks that picked it.
function usage(key, entry) {
  const global = (data.arts['name:' + key] && data.arts['name:' + key].u === entry.u)
    || Object.entries(data.arts).some(([k, a]) => k.startsWith('id:') && a.u === entry.u && (a.label || '').toLowerCase() === key);
  const decks = Object.entries(data.deckArts)
    .filter(([, arts]) => arts['name:' + key] && arts['name:' + key].u === entry.u)
    .map(([deck]) => deck);
  return { global, decks };
}

async function save(changes) {
  Object.assign(data, changes);
  await chrome.storage.local.set(changes);
}

async function rename(key, entry, name) {
  const library = structuredClone(data.library);
  const target = (library[key] || []).find(e => e.id === entry.id);
  if (!target) return;
  if (name) target.n = name.slice(0, 40); else delete target.n;
  await save({ library });
}

// Deleting an art also stops using it, everywhere.
async function remove(key, entry) {
  const library = structuredClone(data.library);
  const arts = structuredClone(data.arts);
  const deckArts = structuredClone(data.deckArts);
  library[key] = (library[key] || []).filter(e => e.id !== entry.id);
  if (!library[key].length) delete library[key];
  for (const [k, a] of Object.entries(arts)) {
    if (a.u === entry.u && (k === 'name:' + key || (a.label || '').toLowerCase() === key)) delete arts[k];
  }
  for (const [deck, entries] of Object.entries(deckArts)) {
    if (entries['name:' + key] && entries['name:' + key].u === entry.u) delete entries['name:' + key];
    if (!Object.keys(entries).length) delete deckArts[deck];
  }
  await save({ library, arts, deckArts });
}

// Rename (in place) and delete (with a question) for a tile.
function editable(nameEl, actions, { current, onRename, onDelete, ask }) {
  const [renameBtn, deleteBtn] = actions.children;
  renameBtn.onclick = () => {
    const input = el('input', { type: 'text', value: current || '', placeholder: t('renamePlaceholder'), maxLength: 40, spellcheck: false });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      if (keep) onRename(input.value.trim()).then(refresh);
      else input.replaceWith(nameEl);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(true);
  };
  deleteBtn.onclick = () => {
    const yes = el('button', { className: 'danger-solid', textContent: t('delete') });
    const no = el('button', { textContent: t('cancel') });
    const box = el('div', { className: 'ask' }, [el('span', { textContent: ask }), el('div', { className: 'row' }, [yes, no])]);
    actions.replaceWith(box);
    no.onclick = () => box.replaceWith(actions);
    yes.onclick = () => onDelete().then(refresh);
    no.focus();
  };
}

const actionButtons = () => el('div', { className: 'actions' }, [
  el('button', { textContent: t('rename'), title: t('renameTitle') }),
  el('button', { className: 'danger', textContent: t('delete'), title: t('deleteTitle') }),
]);

function artTile(key, entry) {
  const { global, decks } = usage(key, entry);
  const chips = el('div', { className: 'chips' });
  if (global) chips.append(el('span', { className: 'chip all', textContent: t('mgr_allDecks') }));
  for (const deck of decks) {
    const name = data.deckNames[deck] || t('mgr_deck', { id: deck.slice(0, 8) });
    chips.append(el('a', { className: 'chip', textContent: name, title: name, href: `https://edhplay.com/decks/${deck}`, target: '_blank', rel: 'noopener' }));
  }
  if (!global && !decks.length) chips.append(el('span', { className: 'chip unused', textContent: t('mgr_unused') }));

  const name = el('div', { className: 'name' + (entry.n ? '' : ' unnamed'), textContent: entry.n || t('unnamed'), title: entry.n || '' });
  const kind = el('div', { className: 'kind', textContent: entry.u.startsWith('data:') ? t('mgr_local') : t('mgr_link') });
  const img = el('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', src: imageUrl(entry.u) });

  const actions = actionButtons();
  const tile = el('div', { className: 'art' }, [img, name, kind, chips, actions]);
  editable(name, actions, {
    current: entry.n,
    onRename: (n) => rename(key, entry, n),
    onDelete: () => remove(key, entry),
    ask: t('mgr_deleteAsk'),
  });
  return tile;
}

let openKey = null; // card whose dialog is open

function cardTile(key) {
  const entries = data.library[key];
  const tile = el('button', { className: 'cardtile' }, [
    el('div', { className: 'pic' }, [
      el('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', src: imageUrl(entries[0].u) }),
      el('span', { className: 'badge', textContent: String(entries.length) }),
    ]),
    el('div', { className: 'title', textContent: cardTitle(key) }),
  ]);
  tile.onclick = () => openCard(key);
  return tile;
}

function closeCard() {
  const open = document.querySelector('.backdrop');
  if (open) open.remove();
  openKey = null;
}

function openCard(key) {
  closeCard();
  const entries = data.library[key];
  if (!entries || !entries.length) return;
  openKey = key;
  const close = el('button', { className: 'x', textContent: '✕', title: t('cancel') });
  const done = el('button', { textContent: t('mgr_close') });
  const dialog = el('div', { className: 'dialog', role: 'dialog' }, [
    el('div', { className: 'head' }, [el('h2', { textContent: cardTitle(key) }), close]),
    el('div', { className: 'body' }, [el('div', { className: 'arts' }, entries.map(e => artTile(key, e)))]),
    el('div', { className: 'foot' }, [done]),
  ]);
  dialog.setAttribute('aria-modal', 'true');
  const backdrop = el('div', { className: 'backdrop' }, [dialog]);
  backdrop.onclick = (e) => { if (e.target === backdrop) closeCard(); };
  close.onclick = done.onclick = closeCard;
  document.body.append(backdrop);
  done.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openKey && !document.querySelector('.art input')) closeCard();
});

// Matte sleeves are a color under a matte texture (painted by content.js on edhplay); a close
// CSS version does for the thumbnail here.
function sleevePreview(sleeve) {
  if (!sleeve.c) return el('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', src: imageUrl(sleeve.u) });
  const swatch = el('div', { className: 'matte' });
  swatch.style.backgroundColor = sleeve.c;
  return swatch;
}

function itemTile(kind, item) {
  const isPlaymat = kind === 'playmats';
  const listKey = isPlaymat ? 'playmats' : 'sleeves';
  const activeKey = isPlaymat ? 'playmat' : 'sleeve';
  const inUse = data[activeKey] === item.id;
  const name = el('div', { className: 'name' + (item.n ? '' : ' unnamed'), textContent: item.n || t('unnamed'), title: item.n || '' });
  const what = item.c ? t('sl_matte') + ' · ' + item.c.toUpperCase() : (item.u.startsWith('data:') ? t('mgr_local') : t('mgr_link'));
  const chips = el('div', { className: 'chips' }, [
    el('span', { className: inUse ? 'chip all' : 'chip unused', textContent: t(inUse ? 'mgr_inUse' : 'mgr_unused') }),
  ]);
  const preview = isPlaymat ? el('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', src: imageUrl(item.u) }) : sleevePreview(item);
  const actions = actionButtons();
  const tile = el('div', { className: 'art ' + (isPlaymat ? 'wide' : 'sleeve') }, [preview, name, el('div', { className: 'kind', textContent: what }), chips, actions]);
  editable(name, actions, {
    current: item.n,
    onRename: (n) => save({ [listKey]: data[listKey].map(x => (x.id === item.id ? { ...x, n: n ? n.slice(0, 40) : undefined } : x)) }),
    // Deleting the one in use goes back to edhplay's own.
    onDelete: () => save({ [listKey]: data[listKey].filter(x => x.id !== item.id), ...(inUse ? { [activeKey]: null } : {}) }),
    ask: t(isPlaymat ? 'mgr_deletePlaymat' : 'mgr_deleteSleeve'),
  });
  return tile;
}

function renderItems(kind, query) {
  const list = $('list');
  list.className = 'arts ' + kind;
  // Named ones alphabetically, then the unnamed (newest first).
  const items = [...data[kind]].sort((x, y) => (!x.n - !y.n) || (x.n && y.n ? x.n.localeCompare(y.n) : (y.t || 0) - (x.t || 0)));
  const shown = items.filter(x => !query || (x.n || '').toLowerCase().includes(query));
  for (const item of shown) list.append(itemTile(kind, item));
  $('summary').textContent = t((kind === 'playmats' ? 'mgr_playmats' : 'mgr_sleeves') + (items.length === 1 ? '1' : 'N'), { n: items.length });
  $('empty').textContent = t(kind === 'playmats' ? 'mgr_noPlaymats' : 'mgr_noSleeves');
  $('empty').hidden = items.length > 0;
  if (items.length && !shown.length) list.append(el('p', { className: 'empty', textContent: t('mgr_noMatch') }));
}

function render() {
  const query = $('search').value.trim().toLowerCase();
  const list = $('list');
  list.textContent = '';
  for (const btn of document.querySelectorAll('.tabs [data-tab]')) btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  $('namesNote').hidden = true;
  if (tab !== 'cards') {
    renderItems(tab, query);
    return;
  }
  list.className = 'cards';
  $('empty').textContent = t('emptyArts');
  const keys = Object.keys(data.library).filter(k => data.library[k].length)
    .sort((a, b) => cardTitle(a).localeCompare(cardTitle(b)));
  const arts = keys.reduce((n, k) => n + data.library[k].length, 0);
  const shown = keys.filter(k => !query || k.includes(query) || data.library[k].some(e => (e.n || '').toLowerCase().includes(query)));
  for (const key of shown) list.append(cardTile(key));
  $('summary').textContent = t('mgr_summary', { arts, cards: keys.length });
  $('empty').hidden = keys.length > 0;
  if (keys.length && !shown.length) list.append(el('p', { className: 'empty', textContent: t('mgr_noMatch') }));
  // Decks in use whose name this browser hasn't seen on edhplay yet.
  $('namesNote').hidden = !Object.keys(data.deckArts).some(d => !data.deckNames[d]);
}

// Redraw the grid, and the open dialog (closing it if its card has no arts left).
function refresh() {
  const key = openKey;
  render();
  if (key) openCard(key); else closeCard();
}

const KEYS = ['library', 'arts', 'deckArts', 'deckNames', 'playmats', 'playmat', 'sleeves', 'sleeve'];

async function load() {
  const stored = await chrome.storage.local.get([...KEYS, 'siteLang']);
  if (stored.siteLang) lang = stored.siteLang;
  data = {
    library: stored.library || {}, arts: stored.arts || {}, deckArts: stored.deckArts || {}, deckNames: stored.deckNames || {},
    playmats: stored.playmats || [], playmat: stored.playmat || null, sleeves: stored.sleeves || [], sleeve: stored.sleeve || null,
  };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !KEYS.some(k => k in changes)) return;
  // Don't redraw under an open rename box or delete question.
  if (document.querySelector('.art input, .ask')) return;
  load().then(refresh);
});

(async () => {
  await load();
  document.documentElement.lang = EA_I18N.pick(lang);
  document.title = `EDHProxy — ${t('mgr_title')}`;
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  $('search').placeholder = t('mgr_search');
  $('search').addEventListener('input', render);
  for (const btn of document.querySelectorAll('.tabs [data-tab]')) {
    btn.onclick = () => {
      tab = btn.dataset.tab;
      try { localStorage.setItem('edhpa-manager-tab', tab); } catch {}
      $('search').value = '';
      closeCard();
      render();
    };
  }
  if (!['cards', 'playmats', 'sleeves'].includes(tab)) tab = 'cards';
  render();
})();
