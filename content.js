(() => {
  'use strict';

  // cards.scryfall.io/<size>/<face>/<a>/<b>/<uuid>.jpg?...
  const CARD_RX = /^https:\/\/cards\.scryfall\.io\/([a-z_]+)\/(front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f-]{36})\./i;
  const ROOM_RX = /^\/games\/([^/]+)\/(?:play|spectate)/;
  const CHUNK_CHARS = 3000; // ntfy turns messages > 4096 bytes into attachments
  const DEFAULT_SETTINGS = { syncEnabled: true, showOthers: true, uploadLocal: true, server: 'https://ntfy.sh' };

  // UI language follows edhplay's own setting (its i18next keeps it in localStorage).
  function siteLang() {
    try {
      return localStorage.getItem('i18nextLng') || document.documentElement.lang;
    } catch {
      return document.documentElement.lang;
    }
  }
  const t = (key, vars) => EA_I18N.t(siteLang(), key, vars);

  let settings = { ...DEFAULT_SETTINGS };
  let ownArts = {};    // key -> { u, m, label, t }   key = "id:<uuid>/<face>" | "name:<lowercase name>"
  let library = {};    // lowercase card name -> [{ id, u, m, t }]  every art uploaded for that card
  let nameCache = {};  // uuid -> [frontName, backName]
  let clientId = null;
  const remote = new Map();      // clientId -> { player, arts, rev, pend }
  const pendingNames = new Set();

  const send = (msg) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || !res.ok) return reject(new Error(res ? res.error : 'no response'));
      resolve(res);
    });
  });

  // ---------- art resolution ----------

  function parseCard(url) {
    const m = url && url.match(CARD_RX);
    return m ? { size: m[1].toLowerCase(), face: m[2].toLowerCase(), id: m[3].toLowerCase() } : null;
  }

  function faceName(id, face) {
    const names = nameCache[id];
    return names ? names[face === 'back' ? 1 : 0] : null;
  }

  function hasNameKeys() {
    if (Object.keys(ownArts).some(k => k.startsWith('name:'))) return true;
    if (!settings.showOthers || !sync) return false;
    for (const p of remote.values()) if (Object.keys(p.arts).some(k => k.startsWith('name:'))) return true;
    return false;
  }

  function latestRemote(key) {
    if (!settings.showOthers || !sync || !key) return null;
    let best = null;
    for (const p of remote.values()) {
      const a = p.arts[key];
      if (a && (!best || a.t > best.t)) best = a;
    }
    return best;
  }

  function artKeys(id, face) {
    const nm = faceName(id, face);
    return [`id:${id}/${face}`, nm ? 'name:' + nm.toLowerCase() : null];
  }

  // Player id of whoever uses this browser in the current room (set by page-owner.js).
  function myPlayer() {
    const room = currentRoom();
    const live = document.documentElement.dataset.eaLocalPlayer;
    try {
      if (live && room) sessionStorage.setItem('edhpa-local:' + room, live);
      return live || (room && sessionStorage.getItem('edhpa-local:' + room)) || null;
    } catch {
      return live || null;
    }
  }

  // In a room each player's arts only apply to the cards they own. Outside a room
  // (playtest) or when the owner is unknown, fall back to "mine first, then anyone's".
  function findArt(id, face, owner) {
    const [idKey, nameKey] = artKeys(id, face);
    const own = ownArts[idKey] || (nameKey && ownArts[nameKey]) || null;
    if (!currentRoom() || !owner) return own || latestRemote(idKey) || latestRemote(nameKey) || null;

    const me = myPlayer();
    if (owner === me) return own;
    let peer = null;
    if (sync && settings.showOthers) {
      for (const p of remote.values()) if (p.player === owner && (!peer || p.rev > peer.rev)) peer = p;
    }
    if (peer) return peer.arts[idKey] || (nameKey && peer.arts[nameKey]) || null;
    // Until we know who we are, cards no peer claims are assumed to be ours.
    return me ? null : own;
  }

  async function lookupName(id) {
    if (id in nameCache || pendingNames.has(id)) return nameCache[id];
    pendingNames.add(id);
    try {
      const res = await send({ type: 'cardInfo', id });
      nameCache[id] = res.names;
      saveNameCacheSoon();
      scheduleScan();
      return res.names;
    } catch (e) {
      console.warn('[EDHProxy] card name lookup failed', id, e);
      return null;
    } finally {
      pendingNames.delete(id);
    }
  }

  let nameCacheTimer = null;
  function saveNameCacheSoon() {
    clearTimeout(nameCacheTimer);
    nameCacheTimer = setTimeout(() => chrome.storage.local.set({ nameCache }), 2000);
  }

  // ---------- image building ----------

  const loadImage = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });

  // ---------- DOM patching ----------

  // Places that show only the illustration (deck covers) use Scryfall's art_crop. Custom arts are
  // whole cards, so crop them to the art window of a modern frame (fractions of the card image).
  const ART_CROP_VIEW = 'inset(10.9% 7.4% 44.3% 7.2%)';
  function setArtCrop(img, on) {
    if (on) img.style.setProperty('object-view-box', ART_CROP_VIEW);
    else if (img.style.getPropertyValue('object-view-box')) img.style.removeProperty('object-view-box');
  }

  function processImg(img) {
    // The Change Printing dialog must keep showing the real printings.
    if (img.closest('[data-ea-print-dialog]')) {
      if (img.dataset.eaSrc) {
        const orig = img.dataset.eaOrig;
        delete img.dataset.eaSrc;
        setArtCrop(img, false);
        img.src = orig;
      }
      return;
    }
    const src = img.getAttribute('src') || '';
    let orig;
    if (img.dataset.eaSrc && src === img.dataset.eaSrc) {
      orig = img.dataset.eaOrig;
    } else {
      if (!CARD_RX.test(src)) return;
      orig = src;
      img.dataset.eaOrig = src;
      delete img.dataset.eaSrc;
      setArtCrop(img, false);
    }
    const card = parseCard(orig);
    if (!card) return;

    const art = findArt(card.id, card.face, img.dataset.eaOwner || null);
    if (!art) {
      if (img.dataset.eaSrc) {
        delete img.dataset.eaSrc;
        setArtCrop(img, false);
        img.src = orig;
      }
      if (!(card.id in nameCache) && hasNameKeys()) lookupName(card.id);
      return;
    }

    img.dataset.eaSrc = art.u;
    img.removeAttribute('srcset');
    setArtCrop(img, card.size === 'art_crop');
    if (src !== art.u) img.src = art.u;
    // Only our own arts can be local files (remote ones are always https).
    if (art.u.startsWith('data:') && sync) {
      wanted.add(art.u);
      shareLocalArts();
    }
  }

  function scanAll() {
    for (const img of document.querySelectorAll('img')) processImg(img);
  }

  let scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => { scanQueued = false; scanAll(); });
  }

  const pendingImgs = new Set();
  let flushQueued = false;
  function queueImg(img) {
    pendingImgs.add(img);
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      for (const i of pendingImgs) processImg(i);
      pendingImgs.clear();
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target === document.documentElement) onLocalPlayerChange();
        else if (m.target.tagName === 'IMG') queueImg(m.target);
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') queueImg(n);
        else if (n.querySelectorAll) for (const i of n.querySelectorAll('img')) queueImg(i);
        schedulePrintDialogScan();
      }
    }
  });

  let announcedPlayer = null;
  function onLocalPlayerChange() {
    scheduleScan();
    const me = myPlayer();
    if (sync && me !== announcedPlayer) publishSoon(300);
  }

  // ---------- room sync (ntfy pub/sub) ----------

  let sync = null; // { roomId, topic, ctl, since, connected }
  let publishTimer = null;

  async function topicFor(roomId) {
    const data = new TextEncoder().encode('edhplay-custom-arts:' + roomId);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return 'edhpa_' + [...hash.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const serverUrl = () => (settings.server || DEFAULT_SETTINGS.server).trim().replace(/\/+$/, '');

  async function startSync(roomId) {
    const s = { roomId, topic: await topicFor(roomId), ctl: new AbortController(), since: 'all', connected: false };
    if (currentRoom() !== roomId || !settings.syncEnabled) return;
    stopSync();
    sync = s;
    publishSoon(0);
    streamLoop(s);
  }

  function stopSync() {
    if (!sync) return;
    sync.ctl.abort();
    sync = null;
    remote.clear();
    scheduleScan();
  }

  async function streamLoop(s) {
    let delay = 2000;
    while (sync === s) {
      try {
        const res = await fetch(`${serverUrl()}/${s.topic}/json?since=${encodeURIComponent(s.since)}`, {
          signal: s.ctl.signal, cache: 'no-store', credentials: 'omit',
        });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        s.connected = true;
        delay = 2000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.event === 'message') {
              s.since = ev.id;
              handleMessage(ev.message);
            }
          }
        }
      } catch (e) {
        if (s.ctl.signal.aborted) return;
        console.warn('[EDHProxy] sync connection dropped, retrying', e);
      }
      s.connected = false;
      if (sync !== s) return;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);
    }
  }

  const validRemoteUrl = (u) => typeof u === 'string' && u.length < 2048 && /^https:\/\//i.test(u);

  function handleMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || msg.v !== 1 || typeof msg.c !== 'string' || msg.c === clientId) return;
    if (!Number.isInteger(msg.i) || !Number.isInteger(msg.t) || msg.t < 1 || msg.t > 200 || !Array.isArray(msg.e)) return;

    const isNew = !remote.has(msg.c);
    const p = remote.get(msg.c) || { player: null, arts: {}, rev: -1, pend: null };
    remote.set(msg.c, p);
    if (msg.r < p.rev || (msg.r === p.rev && !p.pend)) return;
    if (!p.pend || p.pend.r !== msg.r) p.pend = { r: msg.r, parts: new Map() };
    p.pend.parts.set(msg.i, msg.e);

    if (p.pend.parts.size === msg.t) {
      const arts = {};
      for (const part of p.pend.parts.values()) {
        for (const e of part) {
          if (!Array.isArray(e) || typeof e[0] !== 'string' || !validRemoteUrl(e[1])) continue;
          if (!/^(id:[0-9a-f-]{36}\/(front|back)|name:.{1,200})$/.test(e[0])) continue;
          arts[e[0]] = { u: e[1], m: 'full', t: msg.r };
        }
      }
      p.arts = arts;
      p.rev = msg.r;
      p.pend = null;
      p.player = typeof msg.p === 'string' && msg.p.length <= 100 ? msg.p : null;
      scheduleScan();
    }
    // Someone new showed up: re-announce so they get our arts even if the cache expired.
    if (isNew) {
      publishSoon(1500 + Math.random() * 2000);
      shareLocalArts();
    }
  }

  function publishSoon(delay) {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(publishAll, delay);
  }

  // ---------- local files: temporary public copies on litterbox (1h) ----------

  const HOST_TTL = 60 * 60 * 1000;
  const HOST_REFRESH = 10 * 60 * 1000; // re-upload when less than this is left
  const hosted = new Map();  // data URL -> { url, exp }
  const hosting = new Set(); // data URLs being uploaded
  const wanted = new Set();  // local arts of our cards seen on the table this game

  function hostedUrl(dataUrl) {
    const h = hosted.get(dataUrl);
    return h && h.exp > Date.now() ? h.url : null;
  }

  // Uploads only while someone else with the extension is in the room to see them.
  function shareLocalArts() {
    if (!sync || !settings.uploadLocal || remote.size === 0) return;
    for (const dataUrl of wanted) {
      const h = hosted.get(dataUrl);
      if ((h && h.exp - Date.now() > HOST_REFRESH) || hosting.has(dataUrl)) continue;
      hosting.add(dataUrl);
      send({ type: 'litterbox', dataUrl })
        .then((res) => {
          hosted.set(dataUrl, { url: res.url, exp: Date.now() + HOST_TTL });
          publishSoon(300);
        })
        .catch((e) => console.warn('[EDHProxy] litterbox upload failed', e))
        .finally(() => hosting.delete(dataUrl));
    }
  }

  async function publishAll() {
    const s = sync;
    if (!s) return;
    const entries = [];
    for (const [k, a] of Object.entries(ownArts)) {
      const u = a.u.startsWith('data:') ? (settings.uploadLocal && hostedUrl(a.u)) : a.u;
      if (validRemoteUrl(u)) entries.push([k, u, a.m]);
    }
    const chunks = [[]];
    let size = 0;
    for (const e of entries) {
      const len = JSON.stringify(e).length + 1;
      if (size + len > CHUNK_CHARS && chunks[chunks.length - 1].length) { chunks.push([]); size = 0; }
      chunks[chunks.length - 1].push(e);
      size += len;
    }
    const rev = Date.now();
    const player = myPlayer();
    announcedPlayer = player;
    for (let i = 0; i < chunks.length; i++) {
      if (sync !== s) return;
      const body = JSON.stringify({ v: 1, c: clientId, p: player, r: rev, i, t: chunks.length, e: chunks[i] });
      try {
        await send({ type: 'publish', url: `${serverUrl()}/${s.topic}`, body });
      } catch (e) {
        console.warn('[EDHProxy] failed to publish arts', e);
        return;
      }
    }
  }

  function currentRoom() {
    const m = location.pathname.match(ROOM_RX);
    return m ? m[1] : null;
  }

  let lastRoom;
  function checkRoom() {
    const room = currentRoom();
    if (room === lastRoom) return;
    // Player ids are per game; page-owner.js sets it again once it sees our hand.
    if (lastRoom !== undefined) delete document.documentElement.dataset.eaLocalPlayer;
    lastRoom = room;
    announcedPlayer = null;
    // Every game gets fresh uploads.
    hosted.clear();
    wanted.clear();
    stopSync();
    if (room && settings.syncEnabled) startSync(room);
  }

  // ---------- upload form (lives inside the Custom panel) ----------

  // Editing only happens on deck pages; in a game the arts are display-only.
  const onDeckPage = () => location.pathname.startsWith('/decks/');

  // Visual language copied from edhplay's own (Chakra) dialogs: zinc surfaces, Inter, cyan primary.
  const EDH_BASE_CSS = `
    :host { all: initial; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px; line-height: 1.5; color: #d4d4d8; -webkit-font-smoothing: antialiased; }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; font-weight: 500; font-size: 14px; height: 40px; padding: 0 16px; border-radius: 6px;
      border: 1px solid transparent; background: transparent; color: #a1a1aa; cursor: pointer;
      transition: background-color .15s, color .15s; display: inline-flex; align-items: center; gap: 8px; }
    button:hover { background: rgba(255,255,255,.06); color: #fafafa; }
    button:focus-visible { outline: 2px solid #0891b2; outline-offset: 2px; }
    button.primary { background: #0891b2; color: #fff; }
    button.primary:hover { background: #0e7490; }
    button.subtle { background: rgba(255,255,255,.06); color: #d4d4d8; }
    button.subtle:hover { background: rgba(255,255,255,.1); }
    button.danger { color: #f87171; }
    button.danger:hover { background: rgba(248,113,113,.1); color: #fca5a5; }
    button.sm { height: 32px; padding: 0 12px; font-size: 13px; }
    input[type=text] { height: 36px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.06); color: #d4d4d8;
      border-radius: 6px; padding: 0 10px; font: inherit; outline: none; transition: border-color .15s; }
    input[type=text]::placeholder { color: #71717a; }
    input[type=text]:focus { border-color: #0891b2; }
    .muted { color: #a1a1aa; }
  `;

  const FORM_CSS = EDH_BASE_CSS + `
    :host { display: block; }
    .box { margin-top: 16px; border-radius: 12px; background: rgba(255,255,255,.02); box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
    .header { padding: 16px 20px 12px; border-bottom: 1px solid rgba(255,255,255,.06); }
    h2 { margin: 0; font-size: 16px; font-weight: 600; color: #fff; }
    .sub { color: #a1a1aa; font-size: 13px; margin-top: 2px; }
    .body { padding: 16px 20px; }
    .footer { padding: 12px 20px; border-top: 1px solid rgba(255,255,255,.06); display: flex; gap: 12px; justify-content: flex-end; }
    .row { display: flex; gap: 20px; }
    .previews { display: flex; gap: 8px; flex: none; }
    .previews figure { margin: 0; text-align: center; font-size: 12px; color: #a1a1aa; }
    .previews img { width: 130px; aspect-ratio: 488/680; object-fit: cover; border-radius: 4.4% / 3.15%; background: rgba(255,255,255,.04);
      display: block; margin-bottom: 6px; border: 3px solid transparent; }
    .previews .prev { border-color: #22c55e; }
    .form { flex: 1; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 500; color: #d4d4d8; }
    .hint { font-weight: 400; color: #71717a; font-size: 12px; }
    input[type=file] { color: #a1a1aa; font: inherit; font-size: 13px; }
    input[type=file]::file-selector-button { font: inherit; font-weight: 500; height: 32px; padding: 0 12px; margin-right: 10px;
      border-radius: 6px; border: 0; background: rgba(255,255,255,.06); color: #d4d4d8; cursor: pointer; }
    input[type=file]::file-selector-button:hover { background: rgba(255,255,255,.1); }
    .warn { color: #fbbf24; font-size: 12px; min-height: 1em; }
    @media (max-width: 560px) { .row { flex-direction: column; } .previews { justify-content: center; } }
  `;

  const CLOSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M18.7 6.7a1 1 0 0 0-1.4-1.4L12 10.6 6.7 5.3a1 1 0 0 0-1.4 1.4l5.3 5.3-5.3 5.3a1 1 0 1 0 1.4 1.4l5.3-5.3 5.3 5.3a1 1 0 0 0 1.4-1.4L13.4 12z"/></svg>';
  const PENCIL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.9 3.5a2 2 0 0 1 2.8 0l.8.8a2 2 0 0 1 0 2.8L9.2 18.4 4 20l1.6-5.2zM15.5 6.4 7.4 14.5l-.9 2.9 2.9-.9 8.1-8.1z"/></svg>';

  // Library entries: { id, u, m, t, n? }. "n" is a display name that never leaves this browser.
  function addToLibrary(name, u, m, n) {
    const key = name.toLowerCase();
    const old = (library[key] || []).find(x => x.u === u && x.m === m);
    const entry = { id: crypto.randomUUID(), u, m, t: Date.now() };
    const label = n || (old && old.n);
    if (label) entry.n = label;
    library[key] = [entry, ...(library[key] || []).filter(x => x !== old)];
    return entry;
  }

  // Renders the "Nova arte" form into `mount`. Saving adds the art to the card's library and uses it.
  function openUploadForm(card, name, mount, onSaved) {
    if (mount.firstChild) return;
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const origUrl = `https://cards.scryfall.io/normal/${card.face}/${card.id[0]}/${card.id[1]}/${card.id}.jpg`;
    root.innerHTML = `
      <style>${FORM_CSS}</style>
      <div class="box" role="group" aria-label="${t('formTitle')}">
        <div class="header">
          <h2>${t('formTitle')}</h2>
          <div class="sub">${t('formSub')}</div>
        </div>
        <div class="body">
          <div class="row">
            <div class="previews">
              <figure><img class="orig" alt=""><figcaption>${t('original')}</figcaption></figure>
              <figure><img class="prev" alt=""><figcaption>${t('preview')}</figcaption></figure>
            </div>
            <div class="form">
              <label class="field">${t('nameLabel')} <span class="hint">${t('nameHint')}</span>
                <input type="text" class="name" maxlength="40" placeholder="${t('namePlaceholder')}" spellcheck="false">
              </label>
              <label class="field">${t('urlLabel')}
                <input type="text" class="url" placeholder="https://i.imgur.com/....png" spellcheck="false">
              </label>
              <label class="field">${t('fileLabel')}
                <input type="file" class="file" accept="image/*">
              </label>
              <div class="warn"></div>
            </div>
          </div>
        </div>
        <div class="footer">
          <button class="cancel">${t('cancel')}</button>
          <button class="primary save">${t('save')}</button>
        </div>
      </div>`;
    mount.appendChild(host);

    const $ = (sel) => root.querySelector(sel);
    const nameInput = $('.name'), urlInput = $('.url'), fileInput = $('.file'), warn = $('.warn'), prev = $('.prev');
    let fileData = null;
    let previewSeq = 0;
    $('.orig').src = origUrl;
    prev.src = origUrl;

    const close = () => host.remove();
    root.addEventListener('keydown', (e) => {
      // Escape closes only this form, not edhplay's dialog around it.
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
    $('.cancel').onclick = close;

    const source = () => fileData || urlInput.value.trim();

    async function updatePreview() {
      const seq = ++previewSeq;
      const u = source();
      warn.textContent = '';
      if (!u) { prev.src = origUrl; return; }
      if (!fileData && !/^https:\/\//i.test(u)) { warn.textContent = t('errHttps'); return; }
      try {
        await loadImage(u);
        if (seq === previewSeq) prev.src = u;
      } catch (e) {
        if (seq === previewSeq) warn.textContent = t('errLoad');
      }
    }

    let typingTimer = null;
    urlInput.addEventListener('input', () => {
      fileData = null;
      fileInput.value = '';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(updatePreview, 400);
    });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      fileData = await shrinkFile(f);
      urlInput.value = '';
      if (!nameInput.value) nameInput.value = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
      updatePreview();
    });

    $('.save').onclick = async () => {
      const u = source();
      if (!u) { warn.textContent = t('errMissing'); return; }
      if (!fileData && !/^https:\/\//i.test(u)) { warn.textContent = t('errHttps'); return; }
      const entry = addToLibrary(name, u, 'full', nameInput.value.trim());
      try {
        await chrome.storage.local.set({ library });
      } catch (e) {
        warn.textContent = t('errSave', { msg: e.message });
        return;
      }
      close();
      onSaved(entry);
    };
    nameInput.focus();
  }

  // ---------- "Custom" folder in edhplay's Change Printing dialog ----------

  const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" '
    + 'stroke-linejoin="round"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';

  // Tiles mirror edhplay's printing tiles: 488/680 card, 3px border (green = in use, blue = selected).
  const CARD_TILE_CSS = `
    .card { aspect-ratio: 488/680; width: 100%; border: 3px solid transparent; border-radius: 4.4% / 3.15%; overflow: hidden;
      background: rgba(255,255,255,.04); cursor: pointer; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 6px; transition: transform .2s, box-shadow .2s; position: relative; color: #a1a1aa; }
    .card:hover { transform: scale(1.05); box-shadow: 0 4px 6px -1px rgba(0,0,0,.4), 0 2px 4px -2px rgba(0,0,0,.4); }
    .card:focus-visible { outline: 2px solid #0891b2; outline-offset: 2px; }
    .card.active { border-color: #22c55e; }
    .card.open, .card.selected { border-color: #3b82f6; }
    .card img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .cap { font-size: 12px; color: #a1a1aa; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;

  const TILE_CSS = EDH_BASE_CSS + CARD_TILE_CSS + `
    :host { display: block; }
    .tile { display: flex; flex-direction: column; gap: 4px; }
    .card { box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
    .card svg { color: #a1a1aa; }
    .name { font-size: 14px; font-weight: 600; color: #d4d4d8; }
    .count { font-size: 12px; color: #71717a; }
    /* The art in use shows blurred behind the folder, which stays readable on top. */
    .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: none;
      filter: blur(2px) brightness(.55); transform: scale(1.1); }
    .card.has-art .bg { display: block; }
    .card > :not(.bg) { position: relative; }
    .card.has-art svg, .card.has-art .name { color: #fff; }
    .card.has-art .count { color: #d4d4d8; }
    .card.has-art .name, .card.has-art .count { text-shadow: 0 1px 3px rgba(0,0,0,.8); }
  `;

  const PANEL_CSS = EDH_BASE_CSS + CARD_TILE_CSS + `
    :host { display: block; }
    .panel { margin: 8px 8px 16px; padding: 16px; border-radius: 12px; background: rgba(255,255,255,.02);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
    .head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
    .head .text { flex: 1; }
    .head b { font-size: 16px; font-weight: 600; color: #fff; }
    .sub { display: block; color: #a1a1aa; font-size: 13px; margin-top: 2px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
    .item { display: flex; flex-direction: column; gap: 4px; position: relative; }
    .add .card { border: 2px dashed rgba(255,255,255,.12); font-size: 28px; font-weight: 300; }
    .add .card:hover { border-color: #0891b2; color: #22d3ee; }
    .del { position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; padding: 0; border-radius: 9999px; justify-content: center;
      background: rgba(24,24,27,.85); color: #f87171; opacity: 0; transition: opacity .15s, background-color .15s; }
    .del svg { width: 14px; height: 14px; fill: currentColor; }
    .item:hover .del, .del:focus-visible { opacity: 1; }
    .del:hover { background: #18181b; color: #fca5a5; }
    .confirm { position: absolute; inset: 0; display: none; flex-direction: column; align-items: stretch; justify-content: center;
      gap: 8px; padding: 12px; background: rgba(24,24,27,.92); cursor: default; text-align: center; }
    .confirm span { font-size: 13px; font-weight: 500; color: #fafafa; margin-bottom: 4px; }
    .confirm button { justify-content: center; }
    button.danger-solid { background: #dc2626; color: #fff; }
    button.danger-solid:hover { background: #b91c1c; color: #fff; }
    .item.asking .confirm { display: flex; }
    .item.asking .card:hover { transform: none; }
    .item.asking .del, .item.asking .ren { display: none; }
    .meta { font-size: 11px; color: #71717a; text-align: center; margin-top: -2px; }
    .ren { position: absolute; top: 8px; left: 8px; width: 28px; height: 28px; padding: 0; border-radius: 9999px; justify-content: center;
      background: rgba(24,24,27,.85); color: #d4d4d8; opacity: 0; transition: opacity .15s, background-color .15s; }
    .ren svg { width: 14px; height: 14px; fill: currentColor; }
    .item:hover .ren, .ren:focus-visible { opacity: 1; }
    .ren:hover { background: #18181b; color: #fff; }
    input.rename { height: 28px; font-size: 12px; text-align: center; padding: 0 6px; }
  `;

  // Re-render hooks for every Custom tile/panel currently on screen.
  const customViews = new Set();
  function refreshCustomViews() {
    for (const v of customViews) {
      if (v.host.isConnected) v.render(); else customViews.delete(v);
    }
  }

  // The art in use for a card: the by-name one, or one saved for a single printing of it.
  function activeArtFor(name) {
    const lower = name.toLowerCase();
    if (ownArts['name:' + lower]) return ownArts['name:' + lower];
    for (const [k, a] of Object.entries(ownArts)) {
      if (k.startsWith('id:') && (a.label || '').toLowerCase() === lower) return a;
    }
    return null;
  }

  const isActive = (name, entry) => {
    const a = activeArtFor(name);
    return !!(a && entry && a.u === entry.u && a.m === entry.m);
  };

  // Picking from the folder applies to every copy of the card in your decks, so drop any
  // per-printing art of that card that would otherwise take precedence.
  async function activateArt(name, entry) {
    const lower = name.toLowerCase();
    for (const [k, a] of Object.entries(ownArts)) {
      if (k.startsWith('id:') && (a.label || '').toLowerCase() === lower) delete ownArts[k];
    }
    if (entry) ownArts['name:' + lower] = { u: entry.u, m: entry.m, label: name, t: Date.now() };
    else delete ownArts['name:' + lower];
    await chrome.storage.local.set({ arts: ownArts });
  }

  async function renameEntry(name, entry, n) {
    const e = (library[name.toLowerCase()] || []).find(x => x.id === entry.id);
    if (!e) return;
    if (n) e.n = n.slice(0, 40); else delete e.n;
    await chrome.storage.local.set({ library });
    refreshCustomViews();
  }

  async function deleteFromLibrary(name, entry) {
    const lower = name.toLowerCase();
    const list = (library[lower] || []).filter(x => x.id !== entry.id);
    if (list.length) library[lower] = list; else delete library[lower];
    for (const [k, a] of Object.entries(ownArts)) {
      const ofCard = k === 'name:' + lower || (k.startsWith('id:') && (a.label || '').toLowerCase() === lower);
      if (ofCard && a.u === entry.u && a.m === entry.m) delete ownArts[k];
    }
    await chrome.storage.local.set({ library, arts: ownArts });
  }

  // Change Printing is a grid of tiles: [488/680 box with <img alt="<card name>">, <p>set name</p>],
  // with a Cancel/Confirm footer. Other dialogs with card images (e.g. Add Token, whose boxes sit
  // directly in the grid and whose footer only has Close) must not match.
  function findPrintGrid(dlg) {
    if (!footerPairs(dlg).length) return null;
    for (const img of dlg.querySelectorAll('img[alt]')) {
      if (!img.alt || !parseCard(img.dataset.eaOrig || img.getAttribute('src'))) continue;
      const box = img.parentElement;
      if (!box || getComputedStyle(box).aspectRatio.replace(/\s/g, '') !== '488/680') continue;
      const tile = box.parentElement;
      if (!tile || tile.children.length !== 2 || tile.children[0] !== box || tile.children[1].tagName !== 'P') continue;
      if (tile.parentElement) return { grid: tile.parentElement, sample: img };
    }
    return null;
  }

  let printScanQueued = false;
  function schedulePrintDialogScan() {
    if (printScanQueued) return;
    printScanQueued = true;
    requestAnimationFrame(() => { printScanQueued = false; scanPrintDialogs(); });
  }

  function scanPrintDialogs() {
    if (!onDeckPage()) return;
    for (const dlg of document.querySelectorAll('[role="dialog"]')) {
      const found = findPrintGrid(dlg);
      if (!found) continue;
      if (!dlg.dataset.eaPrintDialog) {
        dlg.dataset.eaPrintDialog = '1';
        for (const img of dlg.querySelectorAll('img')) processImg(img);
      }
      if (!found.grid.querySelector(':scope > [data-ea-custom-tile]')) injectCustomTile(found.grid, found.sample);
    }
  }

  // edhplay marks the deck's current printing with a green border. While a custom art is in use
  // that border is misleading, so hide it (the blue "selected" border is left alone). Chakra's
  // styles live in cascade layers, so only an inline !important reliably wins.
  const EDH_GREEN = 'rgb(34, 197, 94)';
  function syncPrintBorders(grid, name) {
    const custom = !!activeArtFor(name);
    for (const img of grid.querySelectorAll('img[alt]')) {
      const box = img.parentElement;
      // Measure edhplay's own color without our override. The tile animates its border, so
      // transitions are paused or the reading would catch the color mid-animation.
      const transition = box.style.transition;
      box.style.transition = 'none';
      box.style.removeProperty('border-color');
      const hide = custom && getComputedStyle(box).borderTopColor === EDH_GREEN;
      box.toggleAttribute('data-ea-hide-current', hide);
      if (hide) box.style.setProperty('border-color', 'transparent', 'important');
      getComputedStyle(box).borderTopColor; // apply before transitions come back
      box.style.transition = transition;
    }
  }

  async function injectCustomTile(grid, sample) {
    const dlg = grid.closest('[role="dialog"]');
    const card = parseCard(sample.dataset.eaOrig || sample.getAttribute('src'));
    const host = document.createElement('div');
    host.dataset.eaCustomTile = '1';
    grid.prepend(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${TILE_CSS}</style>
      <div class="tile">
        <div class="card" role="button" tabindex="0"><img class="bg" alt="">${FOLDER_SVG}
          <span class="name"></span><span class="count"></span></div>
        <div class="cap"></div>
      </div>`;
    const box = root.querySelector('.card');
    const names = await lookupName(card.id);
    const name = (names && names[0]) || sample.alt;
    // pending: the Custom choice waiting for edhplay's Confirm — 'original' or a library entry.
    const ctx = { dlg, grid, card, name, pending: null };
    printCtx.set(dlg, ctx);
    watchPrintingClicks(ctx);

    const view = {
      host,
      render() {
        const list = library[name.toLowerCase()] || [];
        box.title = t('folderTitle');
        root.querySelector('.name').textContent = t('custom');
        root.querySelector('.count').textContent = list.length === 1 ? t('arts1') : t('artsN', { n: list.length });
        const active = activeArtFor(name);
        const entry = active && list.find(e => e.u === active.u);
        const bg = root.querySelector('.bg');
        if (active) { if (bg.getAttribute('src') !== active.u) bg.src = active.u; } else bg.removeAttribute('src');
        box.classList.toggle('has-art', !!active);
        root.querySelector('.cap').textContent = active ? ((entry && entry.n) || t('customArt')) : t('yourArts');
        box.classList.toggle('active', !!active);
        box.classList.toggle('open', !!panelOf(grid));
        syncPrintBorders(grid, name);
        syncConfirm(ctx);
      },
    };
    customViews.add(view);
    view.render();
    // Selecting another printing swaps edhplay's classes; re-check which border is green.
    new MutationObserver(() => syncPrintBorders(grid, name))
      .observe(grid, { subtree: true, attributes: true, attributeFilter: ['class'] });
    const toggle = () => togglePanel(ctx);
    box.addEventListener('click', toggle);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); } });
  }

  // ---------- edhplay's Confirm/Cancel also drive the Custom choice ----------

  const printCtx = new WeakMap(); // dialog element -> ctx

  // The footer has a [Cancel, Confirm] pair per layout (desktop and mobile), each the last
  // child of its row. Matching on structure keeps this independent of edhplay's UI language.
  function footerPairs(dlg) {
    const pairs = [];
    for (const group of dlg.querySelectorAll('.chakra-dialog__footer *')) {
      const [a, b] = group.children;
      if (group.children.length === 2 && a.tagName === 'BUTTON' && b.tagName === 'BUTTON'
        && group === group.parentElement.lastElementChild) pairs.push({ cancel: a, confirm: b });
    }
    return pairs;
  }

  // Library entries are re-read from storage on every change, so compare them by id.
  const sameChoice = (a, b) => a === b || !!(a && b && a.id && a.id === b.id);

  // Picking what is already in use is not a change, so there is nothing to confirm.
  const isCurrent = (ctx, choice) => (choice === 'original' ? !activeArtFor(ctx.name) : isActive(ctx.name, choice));

  function choose(ctx, choice) {
    ctx.pending = sameChoice(ctx.pending, choice) || isCurrent(ctx, choice) ? null : choice;
    refreshCustomViews();
  }

  // A staged Custom choice enables edhplay's Confirm, which is otherwise only enabled by
  // selecting a different printing.
  function syncConfirm(ctx) {
    for (const { confirm } of footerPairs(ctx.dlg)) {
      if (ctx.pending) {
        if (!confirm.hasAttribute('data-ea-enabled')) {
          confirm.dataset.eaWasDisabled = confirm.disabled ? '1' : '';
          confirm.setAttribute('data-ea-enabled', '');
        }
        confirm.disabled = false;
        confirm.removeAttribute('data-disabled');
      } else if (confirm.hasAttribute('data-ea-enabled')) {
        confirm.removeAttribute('data-ea-enabled');
        if (confirm.dataset.eaWasDisabled) confirm.disabled = true;
      }
    }
  }

  // Clicking a real printing replaces any staged Custom choice. Clicking the current printing
  // while a custom art is in use stages "back to original", which edhplay alone can't confirm.
  function watchPrintingClicks(ctx) {
    ctx.grid.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('[data-ea-custom-tile]')) return;
      const box = [...ctx.grid.querySelectorAll('img[alt]')].map(i => i.parentElement).find(b => b.contains(e.target));
      if (!box) return;
      ctx.pending = box.hasAttribute('data-ea-hide-current') ? 'original' : null;
      refreshCustomViews();
    }, true);
  }

  window.addEventListener('click', (e) => {
    const dlg = e.target.closest && e.target.closest('[role="dialog"]');
    const ctx = dlg && printCtx.get(dlg);
    if (!ctx) return;
    const pair = footerPairs(dlg).find(p => p.confirm.contains(e.target));
    if (!pair) return;
    if (ctx.pending) {
      // Our choice: apply it and close through edhplay's Cancel so no printing change is sent.
      e.preventDefault();
      e.stopImmediatePropagation();
      const choice = ctx.pending;
      ctx.pending = null;
      activateArt(ctx.name, choice === 'original' ? null : choice).then(() => pair.cancel.click());
    } else if (activeArtFor(ctx.name)) {
      // Confirming a real printing switches away from the custom art.
      activateArt(ctx.name, null);
    }
  }, true);

  const panelOf = (grid) => grid.parentElement && grid.parentElement.querySelector(':scope > [data-ea-custom-panel]');

  function togglePanel(ctx) {
    const { grid, card, name } = ctx;
    const existing = panelOf(grid);
    if (existing) {
      existing.remove();
      refreshCustomViews();
      return;
    }
    const host = document.createElement('div');
    host.dataset.eaCustomPanel = '1';
    grid.parentElement.insertBefore(host, grid);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${PANEL_CSS}</style>
      <div class="panel">
        <div class="head">
          <div class="text"><b></b>
            <span class="sub"></span></div>
          <button class="x sm"></button>
        </div>
        <div class="grid"></div>
        <div class="form"></div>
      </div>`;
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
    root.querySelector('.x').onclick = () => togglePanel(ctx);
    const gridEl = root.querySelector('.grid');
    const baseUrl = `https://cards.scryfall.io/normal/${card.face}/${card.id[0]}/${card.id[1]}/${card.id}.jpg`;

    function item({ cls = '', thumb, caption, meta, title, onClick, onDelete, onRename }) {
      const el = document.createElement('div');
      el.className = 'item ' + cls;
      const tile = document.createElement('div');
      tile.className = 'card' + (cls.includes('active') ? ' active' : '') + (cls.includes('selected') ? ' selected' : '');
      tile.title = title || '';
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      if (typeof thumb === 'string') tile.textContent = thumb; else tile.append(thumb);
      tile.onclick = onClick;
      tile.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } };
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = caption;
      el.append(tile, cap);
      if (meta) {
        const m = document.createElement('div');
        m.className = 'meta';
        m.textContent = meta;
        el.append(m);
      }
      if (onRename) {
        const ren = document.createElement('button');
        ren.className = 'ren';
        ren.innerHTML = PENCIL_SVG;
        ren.title = t('renameTitle');
        ren.setAttribute('aria-label', t('rename'));
        ren.onclick = (e) => {
          e.stopPropagation();
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'rename';
          input.maxLength = 40;
          input.placeholder = t('renamePlaceholder');
          input.value = cap.dataset.name || '';
          cap.replaceWith(input);
          input.focus();
          input.select();
          let done = false;
          const finish = (save) => {
            if (done) return;
            done = true;
            if (save) onRename(input.value.trim()); else input.replaceWith(cap);
          };
          input.onkeydown = (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
          };
          input.onblur = () => finish(true);
        };
        el.append(ren);
      }
      if (onDelete) {
        const del = document.createElement('button');
        del.className = 'del';
        del.innerHTML = CLOSE_SVG;
        del.title = t('deleteTitle');
        del.setAttribute('aria-label', t('deleteTitle'));
        // Confirmation lives on the tile itself instead of a browser confirm() popup.
        const ask = document.createElement('div');
        ask.className = 'confirm';
        ask.innerHTML = '<span></span><button class="danger-solid sm yes"></button><button class="subtle sm no"></button>';
        ask.querySelector('span').textContent = t('deleteAsk');
        ask.querySelector('.yes').textContent = t('delete');
        ask.querySelector('.no').textContent = t('cancel');
        ask.onclick = (e) => e.stopPropagation();
        ask.onkeydown = (e) => e.stopPropagation();
        ask.querySelector('.yes').onclick = () => onDelete();
        ask.querySelector('.no').onclick = () => el.classList.remove('asking');
        tile.append(ask);
        del.onclick = (e) => { e.stopPropagation(); el.classList.add('asking'); ask.querySelector('.no').focus(); };
        el.append(del);
      }
      return el;
    }

    function img(src) {
      const i = document.createElement('img');
      i.alt = '';
      i.referrerPolicy = 'no-referrer';
      i.src = src;
      return i;
    }

    const view = {
      host,
      render() {
        const list = library[name.toLowerCase()] || [];
        root.querySelector('b').textContent = t('panelTitle', { name });
        // Name edhplay's own Confirm button as the site shows it, in whatever language it uses.
        const pair = footerPairs(ctx.dlg)[0];
        const confirm = (pair && pair.confirm.textContent.trim()) || 'Confirm';
        root.querySelector('.head .sub').textContent = t('panelSub', { confirm });
        root.querySelector('.x').textContent = t('close');
        gridEl.textContent = '';
        const selected = (choice) => (sameChoice(ctx.pending, choice) ? ' selected' : '');
        gridEl.append(item({
          cls: (activeArtFor(name) ? '' : 'active') + selected('original'), thumb: img(baseUrl), caption: t('original'),
          title: t('originalTitle'), onClick: () => choose(ctx, 'original'),
        }));
        for (const entry of list) {
          const local = entry.u.startsWith('data:') ? t('localFile') : null;
          const el = item({
            cls: (isActive(name, entry) ? 'active' : '') + selected(entry), thumb: img(entry.u),
            caption: entry.n || t('unnamed'), meta: local,
            title: t('chooseArt'), onClick: () => choose(ctx, entry),
            onDelete: () => deleteFromLibrary(name, entry),
            onRename: (n) => renameEntry(name, entry, n),
          });
          el.querySelector('.cap').dataset.name = entry.n || '';
          gridEl.append(el);
        }
        gridEl.append(item({
          cls: 'add', thumb: '+', caption: t('add'), title: t('addTitle'),
          onClick: () => openUploadForm(card, name, root.querySelector('.form'), (entry) => choose(ctx, entry)),
        }));
      },
    };
    customViews.add(view);
    refreshCustomViews();
  }

  // Local files are stored as data URLs; downscale big ones to keep storage small.
  async function shrinkFile(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const img = await loadImage(dataUrl);
    const max = 1200;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size < 600 * 1024) return dataUrl;
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  }

  function showHint() {
    const el = document.createElement('div');
    el.textContent = t('hint');
    Object.assign(el.style, {
      position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: 2147483646,
      background: '#18181b', color: '#d4d4d8', padding: '12px 16px', borderRadius: '8px',
      font: '500 14px Inter, -apple-system, "Segoe UI", sans-serif',
      boxShadow: '0 8px 16px rgba(0,0,0,.64), inset 0 0 1px rgba(212,212,216,.3)', transition: 'opacity .5s',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 6000);
    setTimeout(() => el.remove(), 6600);
  }

  // ---------- wiring ----------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.arts) {
      ownArts = changes.arts.newValue || {};
      scheduleScan();
      if (sync) publishSoon(800);
    }
    if (changes.library) library = changes.library.newValue || {};
    if (changes.arts || changes.library) refreshCustomViews();
    if (changes.settings) {
      const old = settings;
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      if (old.syncEnabled !== settings.syncEnabled || old.server !== settings.server) {
        lastRoom = undefined;
        checkRoom();
      } else if (old.uploadLocal !== settings.uploadLocal && sync) {
        shareLocalArts();
        publishSoon(300);
      }
      scheduleScan();
    }
  });

  // Usernames come from edhplay itself (via page-owner.js), never from the sync channel.
  function playerNames() {
    try {
      return JSON.parse(document.documentElement.dataset.eaPlayers || '{}');
    } catch {
      return {};
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'status') return;
    const names = playerNames();
    sendResponse({
      room: currentRoom(),
      syncing: !!sync,
      connected: !!(sync && sync.connected),
      peers: [...remote.values()].map(p => ({
        name: (p.player && names[p.player]) || null,
        count: Object.keys(p.arts).length,
      })),
    });
  });

  async function init() {
    const data = await chrome.storage.local.get(['settings', 'arts', 'library', 'nameCache', 'clientId', 'hintCustomShown']);
    settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    ownArts = data.arts || {};
    library = data.library || {};
    let migrated = false;
    // Only whole-card images are supported now; older "art"/"extended" entries become whole-card.
    for (const a of [...Object.values(ownArts), ...Object.values(library).flat()]) {
      if (a.m !== 'full') { a.m = 'full'; migrated = true; }
    }
    if (migrated) chrome.storage.local.set({ arts: ownArts });
    // Arts saved before the library existed become its first entries.
    for (const a of Object.values(ownArts)) {
      const lower = (a.label || '').toLowerCase();
      if (!lower || /^[0-9a-f-]{36}$/.test(lower) || (library[lower] || []).some(x => x.u === a.u && x.m === a.m)) continue;
      addToLibrary(a.label, a.u, a.m);
      migrated = true;
    }
    if (migrated) chrome.storage.local.set({ library });
    nameCache = data.nameCache || {};
    clientId = data.clientId;
    if (!clientId) {
      clientId = crypto.randomUUID();
      chrome.storage.local.set({ clientId });
    }
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['src', 'data-ea-owner', 'data-ea-local-player'],
    });
    scanAll();
    scanPrintDialogs();
    checkRoom();
    setInterval(checkRoom, 1000);
    setInterval(shareLocalArts, 5 * 60 * 1000);
    let lang = EA_I18N.pick(siteLang());
    chrome.storage.local.set({ siteLang: lang });
    setInterval(() => {
      const now = EA_I18N.pick(siteLang());
      if (now === lang) return;
      lang = now;
      chrome.storage.local.set({ siteLang: lang });
      refreshCustomViews();
    }, 1000);
    if (!data.hintCustomShown && onDeckPage()) {
      showHint();
      chrome.storage.local.set({ hintCustomShown: true });
    }
  }

  init();
})();
