(() => {
  'use strict';

  // cards.scryfall.io/<size>/<face>/<a>/<b>/<uuid>.jpg?...
  const CARD_RX = /^https:\/\/cards\.scryfall\.io\/([a-z_]+)\/(front|back)\/[0-9a-f]\/[0-9a-f]\/([0-9a-f-]{36})\./i;
  const ROOM_RX = /^\/games\/([^/]+)\/(?:play|spectate)/;
  const CHUNK_CHARS = 3000; // ntfy turns messages > 4096 bytes into attachments
  const DEFAULT_SETTINGS = { syncEnabled: true, showOthers: true, uploadLocal: true, foilEnabled: true, manaSymbols: false, server: 'https://ntfy.sh' };

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
  let ownFoils = {};   // lowercase card name -> true   cards shown with the foil overlay (all decks)
  // Per-deck choices, which win over the ones above for that deck:
  let deckArts = {};   // deckId -> { "name:<lowercase name>": art | { none: true } }  (none = original art)
  let deckFoils = {};  // deckId -> { <lowercase name>: true | false }
  let playmats = [];   // [{ id, u, n?, t }]   playmats uploaded by this user
  let activePlaymat = null; // id of the custom playmat in use, or null for edhplay's own
  let sleeves = [];    // [{ id, u? | c?, n?, t }]   custom sleeves: a cropped image (u) or a matte color (c)
  let activeSleeve = null;  // id of the custom sleeve in use, or null for edhplay's own
  let nameCache = {};  // uuid -> [frontName, backName]
  let clientId = null;
  const remote = new Map();      // clientId -> { player, arts, foils: Set<name>, playmat, sleeve, rev, pend }
  const pendingNames = new Set();

  const sendOnce = (msg) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(Object.assign(new Error(chrome.runtime.lastError.message), { channel: true }));
      if (!res || !res.ok) return reject(new Error(res ? res.error : 'no response'));
      resolve(res);
    });
  });

  // The browser may stop the service worker while requests are pending ("message channel closed",
  // "Receiving end does not exist"); the next message starts it again, so retry those.
  async function send(msg, tries = 3) {
    for (let i = 1; ; i++) {
      try {
        return await sendOnce(msg);
      } catch (e) {
        if (!e.channel || i >= tries || !/channel closed|Receiving end/i.test(e.message)) throw e;
        await new Promise(r => setTimeout(r, 500 * i));
      }
    }
  }

  // ---------- art resolution ----------

  function parseCard(url) {
    const m = url && url.match(CARD_RX);
    return m ? { size: m[1].toLowerCase(), face: m[2].toLowerCase(), id: m[3].toLowerCase() } : null;
  }

  function faceName(id, face) {
    const names = nameCache[id];
    return names ? names[face === 'back' ? 1 : 0] : null;
  }

  // Whether some art or foil is keyed by card name, so images need their card's name looked up.
  function hasNameKeys() {
    if (Object.keys(ownArts).some(k => k.startsWith('name:'))) return true;
    if (settings.foilEnabled && Object.keys(ownFoils).length) return true;
    if (Object.keys(deckArts).length || (settings.foilEnabled && Object.keys(deckFoils).length)) return true;
    if (!settings.showOthers || !sync) return false;
    for (const p of remote.values()) {
      if (Object.keys(p.arts).some(k => k.startsWith('name:'))) return true;
      if (settings.foilEnabled && p.foils.size) return true;
    }
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

  // The deck in view: a deck page's own deck, or in a game/playtest the deck we joined with
  // (page-owner.js reads it from edhplay's lobby).
  function currentDeck() {
    const page = location.pathname.match(/^\/decks\/([0-9a-f-]{36})/i);
    return page ? page[1] : (document.documentElement.dataset.eaLocalDeck || inferDeck());
  }

  // In a game whose lobby this browser never saw (joined after it started), edhplay no longer
  // says which deck we play. Guess it: the deck whose own arts and foils name the most of our
  // cards on screen (commander, hand, battlefield).
  let inferred = { room: null, deck: null, at: 0 };
  function inferDeck() {
    const room = currentRoom();
    if (!room) return null;
    if (inferred.room === room && Date.now() - inferred.at < 2000) return inferred.deck;
    const me = myPlayer();
    const names = new Set();
    for (const img of document.querySelectorAll('img[data-ea-owner]')) {
      if (me && img.dataset.eaOwner !== me) continue;
      const card = parseCard(img.dataset.eaSrc && img.getAttribute('src') === img.dataset.eaSrc ? img.dataset.eaOrig : img.getAttribute('src'));
      for (const n of (card && nameCache[card.id]) || []) names.add(n.toLowerCase());
    }
    let best = null, bestScore = 0;
    for (const deck of new Set([...Object.keys(deckArts), ...Object.keys(deckFoils)])) {
      const keys = [...Object.keys(deckArts[deck] || {}).map(k => k.replace(/^name:/, '')), ...Object.keys(deckFoils[deck] || {})];
      const score = new Set(keys.filter(k => names.has(k))).size;
      if (score > bestScore) { best = deck; bestScore = score; }
    }
    // Keep the last guess while nothing on screen points anywhere (e.g. between zone changes).
    inferred = { room, deck: best || (inferred.room === room ? inferred.deck : null), at: Date.now() };
    return inferred.deck;
  }

  // Deck covers (My Decks, Explore) sit in a tile with data-deck-id, or link to their deck; every
  // other image belongs to the deck in view.
  function deckOf(img) {
    const tile = img.closest('[data-deck-id]');
    if (tile && /^[0-9a-f-]{36}$/i.test(tile.dataset.deckId)) return tile.dataset.deckId;
    const link = img.closest('a[href*="/decks/"]') || (img.parentElement && img.parentElement.querySelector(':scope > a[href*="/decks/"]'));
    const m = link && link.getAttribute('href').match(/\/decks\/([0-9a-f-]{36})/i);
    return m ? m[1] : currentDeck();
  }

  function ownArtFor(idKey, nameKey, deck) {
    const scoped = deck && nameKey && deckArts[deck] && deckArts[deck][nameKey];
    if (scoped) return scoped.none ? null : scoped;
    return ownArts[idKey] || (nameKey && ownArts[nameKey]) || null;
  }

  function ownFoilFor(keys, deck) {
    const scoped = deck && deckFoils[deck];
    if (scoped) for (const k of keys) if (k in scoped) return scoped[k];
    return keys.some(k => ownFoils[k]);
  }

  // In a room each player's arts only apply to the cards they own. Outside a room
  // (playtest) or when the owner is unknown, fall back to "mine first, then anyone's".
  function findArt(id, face, owner, deck) {
    const [idKey, nameKey] = artKeys(id, face);
    const own = ownArtFor(idKey, nameKey, deck);
    if (!currentRoom() || !owner) return own || latestRemote(idKey) || latestRemote(nameKey) || null;

    const me = myPlayer();
    if (owner === me) return own;
    const peer = peerFor(owner);
    if (peer) return peer.arts[idKey] || (nameKey && peer.arts[nameKey]) || null;
    // Until we know who we are, cards no peer claims are assumed to be ours.
    return me ? null : own;
  }

  // The room peer whose player owns a card (latest announcement wins).
  function peerFor(owner) {
    if (!sync || !settings.showOthers) return null;
    let peer = null;
    for (const p of remote.values()) if (p.player === owner && (!peer || p.rev > peer.rev)) peer = p;
    return peer;
  }

  // Lowercase names a foil can be stored under: both faces of a double-faced card count as the
  // same card (it's saved under the front face's name).
  const foilKeys = (names) => [...new Set(names.map(n => n.toLowerCase()))];

  // Foil follows the same ownership rules as arts, by card name.
  function findFoil(id, face, owner, deck) {
    if (!settings.foilEnabled || !nameCache[id]) return false;
    const keys = foilKeys(nameCache[id]);
    const own = ownFoilFor(keys, deck);
    if (!currentRoom() || !owner) return own;
    const me = myPlayer();
    if (owner === me) return own;
    const peer = peerFor(owner);
    if (peer) return keys.some(k => peer.foils.has(k));
    return me ? false : own;
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
      // Scryfall doesn't know it: remember that instead of asking again on every change.
      if (/not found/i.test(e.message)) nameCache[id] = null;
      else console.warn('[EDHProxy] card name lookup failed', id, e);
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

  // Google Drive share links (…/file/d/<id>/view, open?id=, uc?id=) open a viewer page, not the
  // image. lh3.googleusercontent.com serves the file itself, as long as it is shared with
  // "Anyone with the link".
  const DRIVE_RX = /^https:\/\/drive\.google\.com\/(?:file\/d\/|(?:open|uc)\?(?:[^#]*&)?id=)([\w-]{20,})/i;
  const isDriveLink = (url) => DRIVE_RX.test(url || '');
  function directImageUrl(url) {
    const m = (url || '').match(DRIVE_RX);
    return m ? `https://lh3.googleusercontent.com/d/${m[1]}` : url;
  }

  // Places that show only the illustration (deck covers) use Scryfall's art_crop. Custom arts are
  // whole cards, so crop them to the art window of a modern frame (fractions of the card image).
  const ART_CROP_VIEW = 'inset(10.9% 7.4% 44.3% 7.2%)';
  function setArtCrop(img, on) {
    if (on) img.style.setProperty('object-view-box', ART_CROP_VIEW);
    else if (img.style.getPropertyValue('object-view-box')) img.style.removeProperty('object-view-box');
  }

  // Scryfall serves each spot an image of about the size it is shown at; custom arts get copies of
  // the same widths (rendered once, in the background) so small thumbnails don't look jagged.
  // The same step paints the foil overlay. art_crop is wide because deck covers crop the custom
  // card down to its art box.
  const SIZE_WIDTH = { small: 146, normal: 488, border_crop: 480, large: 672, png: 745, art_crop: 745 };
  const rendered = new Map(); // `${foil}|${width}|${url}` -> data URL, or null = use url as is
  // The latest copy of each image at any width: shown (scaled by the browser) while the right
  // width is being made, so a new spot (a hover preview) doesn't flash the plain image first.
  const anyWidth = new Map(); // `${foil}|${image}` -> data URL
  // Scryfall's sizes of one card are the same picture (except the art_crop, which is cut).
  const sameImage = (url) => url.replace(/^(https:\/\/cards\.scryfall\.io\/)(?!art_crop\/)[a-z_]+\//, '$1*/');

  function renderedUrl(url, size, foil) {
    const width = SIZE_WIDTH[size] || 0;
    if (!width && !foil) return url;
    const key = `${foil ? 'foil' : 'plain'}|${width}|${url}`;
    const similar = `${foil ? 'foil' : 'plain'}|${sameImage(url)}`;
    if (rendered.has(key)) return rendered.get(key) || anyWidth.get(similar) || url;
    rendered.set(key, null);
    send({ type: 'render', url, width, foil })
      .then((res) => {
        if (!res.url) return;
        rendered.set(key, res.url);
        anyWidth.set(similar, res.url);
        scheduleScan(); // every image showing this card picks up the rendered copy
      })
      .catch((e) => console.warn('[EDHProxy] render failed, using the image as is', url, e));
    return anyWidth.get(similar) || url;
  }

  function hideUntilLoaded(img) {
    if (img.dataset.eaLoading) return;
    img.dataset.eaLoading = '1';
    img.style.setProperty('visibility', 'hidden', 'important');
    const done = () => {
      img.removeEventListener('load', done);
      img.removeEventListener('error', done);
      img.style.removeProperty('visibility');
      delete img.dataset.eaLoading;
    };
    img.addEventListener('load', done);
    img.addEventListener('error', done);
  }

  // Hover previews show a card at Scryfall's "normal" size, both faces of a double-faced card,
  // usually a size the table hasn't shown yet. Make those copies ahead of time so the preview
  // gets its final image straight away (no plain image first, no swap to a sharper one).
  function preparePreview(card, orig, owner, deck) {
    const faces = nameCache[card.id] && nameCache[card.id][0] !== nameCache[card.id][1] ? ['front', 'back'] : [card.face];
    for (const face of faces) {
      const art = findArt(card.id, face, owner, deck);
      const foil = findFoil(card.id, face, owner, deck);
      if (!art && !foil) continue;
      const plain = orig.replace(/^(https:\/\/cards\.scryfall\.io\/)[a-z_]+\/(front|back)\//i, `$1normal/${face}/`);
      renderedUrl(art ? directImageUrl(art.u) : plain, 'normal', foil);
    }
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
    if (isSleeveImg(img)) {
      processSleeve(img);
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

    if (!(card.id in nameCache) && hasNameKeys()) lookupName(card.id);
    const owner = img.dataset.eaOwner || null;
    const deck = deckOf(img);
    const art = findArt(card.id, card.face, owner, deck);
    const foil = findFoil(card.id, card.face, owner, deck);
    if (!art && !foil) {
      if (img.dataset.eaSrc) {
        delete img.dataset.eaSrc;
        setArtCrop(img, false);
        img.src = orig;
      }
      return;
    }

    const base = art ? directImageUrl(art.u) : orig;
    const url = renderedUrl(base, card.size, foil);
    preparePreview(card, orig, owner, deck);
    // Still showing the printing's own art while a custom one downloads: the browser keeps the
    // old picture on screen meanwhile, so hide it. Copies we made (data: URLs) are ready at once
    // and need no hiding, which would only blink the image.
    if (art && src !== url && !url.startsWith('data:') && !(img.dataset.eaSrc && src === img.dataset.eaSrc)) {
      hideUntilLoaded(img);
    }
    img.dataset.eaSrc = url;
    img.removeAttribute('srcset');
    setArtCrop(img, !!art && card.size === 'art_crop');
    if (src !== url) img.src = url;
    // Only our own arts can be local files (remote ones are always https).
    if (art && art.u.startsWith('data:') && sync) {
      wanted.add(art.u);
      shareLocalArts();
    }
  }

  // The library's shuffle animation draws flying card backs from a CSS variable, --sleeve-url,
  // that edhplay sets inline. Point it at each player's custom sleeve too (keeping edhplay's
  // value to put back).
  function applySleeveVars() {
    for (const zone of document.querySelectorAll('[data-zone="library"][data-player-id]')) {
      const sleeve = sleeveFor(zone.dataset.playerId);
      const value = sleeve ? `url("${sleeveImage(sleeve)}")` : null;
      if (value) {
        if (zone.dataset.eaSleeveVar === value) continue;
        if (!zone.dataset.eaSleeveVar) zone.dataset.eaSleeveVarOrig = zone.style.getPropertyValue('--sleeve-url');
        zone.style.setProperty('--sleeve-url', value, 'important');
        zone.dataset.eaSleeveVar = value;
      } else if (zone.dataset.eaSleeveVar) {
        const orig = zone.dataset.eaSleeveVarOrig;
        if (orig) zone.style.setProperty('--sleeve-url', orig); else zone.style.removeProperty('--sleeve-url');
        delete zone.dataset.eaSleeveVar;
        delete zone.dataset.eaSleeveVarOrig;
      }
    }
  }

  function scanAll() {
    applySleeveVars();
    for (const img of document.querySelectorAll('img')) processImg(img);
    // The deck we play may only be guessed once our cards show up: announce its arts then.
    // (Marked as announced right away so frequent scans don't keep postponing the publish.)
    if (sync && currentDeck() !== announcedDeck) {
      announcedDeck = currentDeck();
      publishSoon(500);
    }
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
        else if (m.attributeName === 'data-ea-mana') scheduleMana();
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') queueImg(n);
        else if (n.querySelectorAll) for (const i of n.querySelectorAll('img')) queueImg(i);
        schedulePrintDialogScan();
        schedulePlaymats();
        scheduleCosmeticSettings();
      }
    }
  });

  let announcedPlayer = null;
  let announcedDeck = null;
  function onLocalPlayerChange() {
    scheduleScan();
    schedulePlaymats();
    const me = myPlayer();
    if (sync && (me !== announcedPlayer || currentDeck() !== announcedDeck)) publishSoon(300);
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
    restoreRemote(roomId);
    publishSoon(0);
    streamLoop(s);
  }

  function stopSync() {
    if (!sync) return;
    sync.ctl.abort();
    sync = null;
    remote.clear();
    scheduleScan();
    schedulePlaymats();
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
    const p = remote.get(msg.c) || { player: null, arts: {}, foils: new Set(), playmat: null, sleeve: null, rev: -1, pend: null };
    remote.set(msg.c, p);
    if (msg.r < p.rev || (msg.r === p.rev && !p.pend)) return;
    if (!p.pend || p.pend.r !== msg.r) p.pend = { r: msg.r, parts: new Map() };
    p.pend.parts.set(msg.i, msg.e);

    if (p.pend.parts.size === msg.t) {
      const arts = {};
      const foils = new Set();
      let playmat = null;
      let sleeve = null;
      for (const part of p.pend.parts.values()) {
        for (const e of part) {
          // A local file still uploading on their side: keep what we had for it.
          if (Array.isArray(e) && e[2] === 'pending' && typeof e[0] === 'string') {
            if (e[0] === 'playmat') playmat = p.playmat;
            else if (e[0] === 'sleeve') sleeve = p.sleeve;
            else if (p.arts[e[0]]) arts[e[0]] = p.arts[e[0]];
            continue;
          }
          // The playmat travels as ["playmat", url, "playmat"]; older versions skip the key.
          if (Array.isArray(e) && e[0] === 'playmat') {
            if (validRemoteUrl(e[1])) playmat = e[1];
            continue;
          }
          // The sleeve as ["sleeve", url, "sleeve"] or ["sleeve", "#rrggbb", "matte"].
          if (Array.isArray(e) && e[0] === 'sleeve') {
            if (e[2] === 'matte' && validColor(e[1])) sleeve = { c: e[1].toLowerCase() };
            else if (e[2] === 'sleeve' && validRemoteUrl(e[1])) sleeve = { u: e[1] };
            continue;
          }
          // Foils travel as ["foil:<name>", "", "foil"]; older versions skip them (no URL).
          if (Array.isArray(e) && typeof e[0] === 'string' && /^foil:.{1,200}$/.test(e[0])) {
            foils.add(e[0].slice(5).toLowerCase());
            continue;
          }
          if (!Array.isArray(e) || typeof e[0] !== 'string' || !validRemoteUrl(e[1])) continue;
          if (!/^(id:[0-9a-f-]{36}\/(front|back)|name:.{1,200})$/.test(e[0])) continue;
          arts[e[0]] = { u: e[1], m: 'full', t: msg.r };
        }
      }
      p.arts = arts;
      p.foils = foils;
      p.playmat = playmat;
      p.sleeve = sleeve;
      p.rev = msg.r;
      p.pend = null;
      // Right after a reload they may not know their player id yet; keep the one we knew.
      p.player = typeof msg.p === 'string' && msg.p.length <= 100 ? msg.p : p.player;
      scheduleScan();
      schedulePlaymats();
      saveRemoteSoon();
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

  // What the others announced is kept in this tab's sessionStorage, so a reload shows their arts,
  // foils, playmats and sleeves right away instead of after the channel history comes back in.
  // It belongs to one room: another room starts from scratch.
  const REMOTE_KEY = 'edhpa-remote';
  let remoteSaveTimer = null;
  function saveRemoteSoon() {
    clearTimeout(remoteSaveTimer);
    remoteSaveTimer = setTimeout(() => {
      if (!sync) return;
      const peers = [...remote].filter(([, p]) => p.rev >= 0).map(([c, p]) => [c, {
        player: p.player, arts: p.arts, foils: [...p.foils], playmat: p.playmat, sleeve: p.sleeve, rev: p.rev,
      }]);
      try {
        sessionStorage.setItem(REMOTE_KEY, JSON.stringify({ room: sync.roomId, peers }));
      } catch {
        // Storage full or blocked: the channel history still brings everything back.
      }
    }, 500);
  }

  function restoreRemote(roomId) {
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(REMOTE_KEY) || 'null');
      if (saved && saved.room !== roomId) {
        sessionStorage.removeItem(REMOTE_KEY);
        saved = null;
      }
    } catch {
      return;
    }
    if (!saved || !Array.isArray(saved.peers)) return;
    for (const [c, p] of saved.peers) {
      if (typeof c !== 'string' || c === clientId || !p || typeof p !== 'object') continue;
      remote.set(c, {
        player: typeof p.player === 'string' ? p.player : null,
        arts: p.arts && typeof p.arts === 'object' ? p.arts : {},
        foils: new Set(Array.isArray(p.foils) ? p.foils : []),
        playmat: validRemoteUrl(p.playmat) ? p.playmat : null,
        sleeve: p.sleeve && (validColor(p.sleeve.c) || validRemoteUrl(p.sleeve.u)) ? p.sleeve : null,
        rev: Number.isFinite(p.rev) ? p.rev : -1,
        pend: null,
      });
    }
    scheduleScan();
    schedulePlaymats();
  }

  // ---------- local files: temporary public copies on litterbox (1h) ----------

  const HOST_TTL = 60 * 60 * 1000;
  const HOST_REFRESH = 10 * 60 * 1000; // re-upload when less than this is left
  // Uploads are reused while they last (across reloads and games, through extension storage)
  // instead of filling litterbox with copies. Keyed by a short fingerprint of the data URL.
  const HOSTED_KEY = 'hostedCache';
  const hosted = new Map();  // fingerprint -> { url, exp }
  const hosting = new Set(); // data URLs being uploaded
  const wanted = new Set();  // local arts of our cards seen on the table this game

  const fingerprint = (dataUrl) => `${dataUrl.length}:${dataUrl.slice(40, 120)}:${dataUrl.slice(-160)}`;

  function hostedUrl(dataUrl) {
    const h = hosted.get(fingerprint(dataUrl));
    return h && h.exp > Date.now() ? h.url : null;
  }

  function saveHosted() {
    const now = Date.now();
    for (const [k, h] of hosted) if (h.exp <= now) hosted.delete(k);
    chrome.storage.local.set({ [HOSTED_KEY]: Object.fromEntries(hosted) }).catch(() => {});
  }

  // Uploads only while someone else with the extension is in the room to see them.
  function shareLocalArts() {
    if (!sync || !settings.uploadLocal || remote.size === 0) return;
    for (const dataUrl of wanted) {
      const h = hosted.get(fingerprint(dataUrl));
      if ((h && h.exp - Date.now() > HOST_REFRESH) || hosting.has(dataUrl)) continue;
      hosting.add(dataUrl);
      send({ type: 'litterbox', dataUrl })
        .then((res) => {
          hosted.set(fingerprint(dataUrl), { url: res.url, exp: Date.now() + HOST_TTL });
          saveHosted();
          publishSoon(300);
        })
        .catch((e) => console.warn('[EDHProxy] litterbox upload failed', e))
        .finally(() => hosting.delete(dataUrl));
    }
  }

  async function publishAll() {
    const s = sync;
    if (!s) return;
    // Arts and foils as the deck we're playing has them (its own choices over the all-decks ones).
    const deck = currentDeck();
    const arts = { ...ownArts };
    for (const [k, a] of Object.entries((deck && deckArts[deck]) || {})) {
      if (a.none) delete arts[k]; else arts[k] = a;
    }
    const foils = { ...ownFoils };
    for (const [k, on] of Object.entries((deck && deckFoils[deck]) || {})) {
      if (on) foils[k] = true; else delete foils[k];
    }
    const entries = [];
    // A local file whose litterbox copy isn't up yet (right after a reload) goes out as
    // [key, "", "pending"], so the others keep showing what they had instead of dropping it.
    // Older versions skip it (no URL).
    const share = (key, u, mode) => {
      const local = u.startsWith('data:');
      const url = local ? (settings.uploadLocal && hostedUrl(u)) : u;
      if (validRemoteUrl(url)) entries.push([key, url, mode]);
      else if (local && settings.uploadLocal) entries.push([key, '', 'pending']);
    };
    for (const [k, a] of Object.entries(arts)) share(k, a.u, a.m);
    if (settings.foilEnabled) for (const name of Object.keys(foils)) entries.push(['foil:' + name, '', 'foil']);
    const mat = ownPlaymatUrl();
    if (mat) share('playmat', mat, 'playmat');
    const sleeve = ownSleeve();
    if (sleeve && sleeve.c) entries.push(['sleeve', sleeve.c, 'matte']);
    else if (sleeve) share('sleeve', directImageUrl(sleeve.u), 'sleeve');
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
    announcedDeck = deck;
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
              <label class="field">${t('urlLabel')} <span class="hint">${t('urlHint')}</span>
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

    const source = () => fileData || directImageUrl(urlInput.value.trim());

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
        if (seq === previewSeq) warn.textContent = t(isDriveLink(urlInput.value.trim()) ? 'errDrive' : 'errLoad');
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
    .all { display: inline-flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px; color: #d4d4d8; cursor: pointer; }
    .all input { accent-color: #0891b2; width: 15px; height: 15px; margin: 0; }
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
    const deck = currentDeck();
    const scoped = deck && deckArts[deck] && deckArts[deck]['name:' + lower];
    if (scoped) return scoped.none ? null : scoped;
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
  // allDecks: change the art every deck uses (and drop this deck's own choice); otherwise only the
  // deck in view changes. "Original" in one deck is stored as { none: true } so it can hide an art
  // the other decks use.
  async function activateArt(name, entry, allDecks) {
    const lower = name.toLowerCase();
    const key = 'name:' + lower;
    const deck = currentDeck();
    const art = entry && { u: entry.u, m: entry.m, label: name, t: Date.now() };
    if (allDecks || !deck) {
      for (const [k, a] of Object.entries(ownArts)) {
        if (k.startsWith('id:') && (a.label || '').toLowerCase() === lower) delete ownArts[k];
      }
      if (art) ownArts[key] = art; else delete ownArts[key];
      if (deck && deckArts[deck]) {
        delete deckArts[deck][key];
        if (!Object.keys(deckArts[deck]).length) delete deckArts[deck];
      }
    } else {
      const forDeck = deckArts[deck] || (deckArts[deck] = {});
      const global = ownArts[key] || Object.entries(ownArts).some(([k, a]) => k.startsWith('id:') && (a.label || '').toLowerCase() === lower);
      if (art) forDeck[key] = art;
      else if (global) forDeck[key] = { none: true, label: name, t: Date.now() };
      else delete forDeck[key];
      if (!Object.keys(forDeck).length) delete deckArts[deck];
    }
    await chrome.storage.local.set({ arts: ownArts, deckArts });
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
    for (const [deck, forDeck] of Object.entries(deckArts)) {
      const a = forDeck['name:' + lower];
      if (a && !a.none && a.u === entry.u && a.m === entry.m) delete forDeck['name:' + lower];
      if (!Object.keys(forDeck).length) delete deckArts[deck];
    }
    await chrome.storage.local.set({ library, arts: ownArts, deckArts });
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
    // allDecks: apply the choice to every deck instead of only the deck in view.
    const ctx = { dlg, grid, card, name, pending: null, allDecks: false };
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
        if (active) { const u = directImageUrl(active.u); if (bg.getAttribute('src') !== u) bg.src = u; } else bg.removeAttribute('src');
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
    const footers = [...dlg.querySelectorAll('.chakra-dialog__footer')];
    // The buttons sit in a row inside the footer (Change Printing) or right in it (Settings, game
    // Preferences — where the dialog's close button may come after the footer).
    for (const group of footers.flatMap(f => [f, ...f.querySelectorAll('*')])) {
      const [a, b] = group.children;
      if (group.children.length === 2 && a.tagName === 'BUTTON' && b.tagName === 'BUTTON'
        && (footers.includes(group) || group === group.parentElement.lastElementChild)) pairs.push({ cancel: a, confirm: b });
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
      activateArt(ctx.name, choice === 'original' ? null : choice, ctx.allDecks).then(() => pair.cancel.click());
    } else if (activeArtFor(ctx.name)) {
      // Confirming a real printing switches away from the custom art.
      activateArt(ctx.name, null, ctx.allDecks);
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
            <span class="sub"></span>
            <label class="all"><input type="checkbox"> <span></span></label></div>
          <button class="x sm"></button>
        </div>
        <div class="grid"></div>
        <div class="form"></div>
      </div>`;
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
    root.querySelector('.x').onclick = () => togglePanel(ctx);
    const allDecks = root.querySelector('.all input');
    allDecks.checked = ctx.allDecks;
    allDecks.onchange = () => { ctx.allDecks = allDecks.checked; };
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
        root.querySelector('.all span').textContent = t('allDecks');
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
            cls: (isActive(name, entry) ? 'active' : '') + selected(entry), thumb: img(directImageUrl(entry.u)),
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
  async function shrinkFile(file, max = 1200) {
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    const img = await loadImage(dataUrl);
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

  // ---------- custom playmats on the game board ----------

  // Each player's area is [data-player-board-id=<player id>] with the playmat as its background
  // (a Chakra class). An inline !important background replaces it; React never touches the
  // element's style attribute. Images go in as data URLs (see renderImage in background.js).
  const PLAYMAT_WIDTH = 2400;
  const playmatImages = new Map(); // url -> data URL, or null while loading / failed

  // While Settings is open, the playmat being picked is previewed on your board.
  let previewPlaymat; // undefined = no preview, null = edhplay's own playmat, id = a custom one

  function ownPlaymatUrl() {
    const id = previewPlaymat !== undefined ? previewPlaymat : activePlaymat;
    const mat = id && playmats.find(p => p.id === id);
    return mat ? directImageUrl(mat.u) : null;
  }

  // Same ownership rules as arts: your board gets yours, a peer's board gets theirs.
  function playmatUrlFor(playerId) {
    const own = ownPlaymatUrl();
    if (!currentRoom()) return own;
    const me = myPlayer();
    if (playerId === me) return own;
    const peer = peerFor(playerId);
    if (peer) return peer.playmat ? directImageUrl(peer.playmat) : null;
    return me ? null : own;
  }

  // Ready playmats are also kept in extension storage (the last few), so a reload doesn't
  // download and convert them again.
  const PLAYMAT_CACHE_KEY = 'playmatCache';
  const PLAYMAT_CACHE_SIZE = 4;

  function playmatImage(url) {
    if (playmatImages.has(url)) return playmatImages.get(url);
    playmatImages.set(url, null);
    (async () => {
      const { [PLAYMAT_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(PLAYMAT_CACHE_KEY);
      if (cache[url]) return cache[url].d;
      const { url: data } = await send({ type: 'render', url, width: PLAYMAT_WIDTH, asData: true });
      const entries = Object.entries({ ...cache, [url]: { d: data, t: Date.now() } })
        .sort((a, b) => b[1].t - a[1].t).slice(0, PLAYMAT_CACHE_SIZE);
      chrome.storage.local.set({ [PLAYMAT_CACHE_KEY]: Object.fromEntries(entries) }).catch(() => {});
      return data;
    })()
      .then((data) => { playmatImages.set(url, data); schedulePlaymats(); })
      .catch((e) => {
        // A playmat has no fallback (it must be a data URL), so try again in a while.
        console.warn('[EDHProxy] playmat failed to load, retrying soon', url, e);
        setTimeout(() => { playmatImages.delete(url); schedulePlaymats(); }, 15000);
      });
    return null;
  }

  function applyPlaymats() {
    applySleeveVars(); // runs on the same table changes
    for (const board of document.querySelectorAll('[data-player-board-id]')) {
      const url = playmatUrlFor(board.dataset.playerBoardId);
      if (!url) {
        if (board.dataset.eaPlaymat) {
          for (const p of ['background-image', 'background-size', 'background-position', 'background-repeat']) board.style.removeProperty(p);
          delete board.dataset.eaPlaymat;
        }
        continue;
      }
      const image = playmatImage(url);
      if (!image || board.dataset.eaPlaymat === url) continue;
      board.style.setProperty('background-image', `url("${image}")`, 'important');
      board.style.setProperty('background-size', 'cover', 'important');
      board.style.setProperty('background-position', 'center', 'important');
      board.style.setProperty('background-repeat', 'no-repeat', 'important');
      board.dataset.eaPlaymat = url;
    }
    // A local-file playmat is shared through litterbox like local arts.
    const own = ownPlaymatUrl();
    if (own && own.startsWith('data:') && sync) {
      wanted.add(own);
      shareLocalArts();
    }
  }

  let cosmeticSettingsQueued = false;
  function scheduleCosmeticSettings() {
    if (cosmeticSettingsQueued) return;
    cosmeticSettingsQueued = true;
    setTimeout(() => { cosmeticSettingsQueued = false; scanCosmeticSettings(); }, 50);
  }

  let playmatsQueued = false;
  function schedulePlaymats() {
    if (playmatsQueued) return;
    playmatsQueued = true;
    requestAnimationFrame(() => { playmatsQueued = false; applyPlaymats(); });
  }

  // ---------- custom sleeves on card backs ----------

  // edhplay draws every card back (library, hands, face-down cards) as .card-frame > div > img with
  // the sleeve image (274x384, object-fit: cover). page-owner.js tags those images with the player
  // they belong to (data-ea-sleeve-owner). A sleeve is an image (u) or a matte color (c); matte
  // sleeves travel as just the color and every browser paints the texture itself.
  const SLEEVE_W = 548, SLEEVE_H = 768; // twice edhplay's sleeve images
  const matteImages = new Map(); // color -> data URL
  let matteLayer = null; // { canvas, url }: everything but the color, painted once

  // The matte look as a transparent layer over the color: grain (seeded, so it's the same
  // everywhere), soft light from the top left, shade toward the bottom right and a darker rim.
  // The form previews it over a CSS background color, so picking a color costs nothing.
  function matteOverlay() {
    if (matteLayer) return matteLayer;
    const c = document.createElement('canvas');
    c.width = SLEEVE_W;
    c.height = SLEEVE_H;
    const g = c.getContext('2d');
    const px = g.createImageData(SLEEVE_W, SLEEVE_H);
    let seed = 0x2f6b9a1d;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < px.data.length; i += 4) {
      const n = rand() - 0.5;
      const v = n > 0 ? 255 : 0;
      px.data[i] = px.data[i + 1] = px.data[i + 2] = v;
      px.data[i + 3] = Math.abs(n) * 32;
    }
    g.putImageData(px, 0, 0);
    const light = g.createLinearGradient(0, 0, SLEEVE_W, SLEEVE_H);
    light.addColorStop(0, 'rgba(255,255,255,.12)');
    light.addColorStop(0.5, 'rgba(255,255,255,0)');
    light.addColorStop(1, 'rgba(0,0,0,.18)');
    g.fillStyle = light;
    g.fillRect(0, 0, SLEEVE_W, SLEEVE_H);
    const rim = g.createRadialGradient(SLEEVE_W / 2, SLEEVE_H / 2, SLEEVE_H * 0.32, SLEEVE_W / 2, SLEEVE_H / 2, SLEEVE_H * 0.72);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(1, 'rgba(0,0,0,.25)');
    g.fillStyle = rim;
    g.fillRect(0, 0, SLEEVE_W, SLEEVE_H);
    matteLayer = { canvas: c, url: c.toDataURL('image/png') };
    return matteLayer;
  }

  function matteSleeve(color) {
    if (matteImages.has(color)) return matteImages.get(color);
    const c = document.createElement('canvas');
    c.width = SLEEVE_W;
    c.height = SLEEVE_H;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, SLEEVE_W, SLEEVE_H);
    g.drawImage(matteOverlay().canvas, 0, 0);
    const url = c.toDataURL('image/webp', 0.9);
    matteImages.set(color, url);
    return url;
  }

  const validColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  const sleeveImage = (s) => (s.c ? matteSleeve(s.c) : directImageUrl(s.u));

  function ownSleeve() {
    return (activeSleeve && sleeves.find(s => s.id === activeSleeve)) || null;
  }

  // Same ownership rules as arts and playmats.
  function sleeveFor(playerId) {
    const own = ownSleeve();
    if (!currentRoom() || !playerId) return own;
    const me = myPlayer();
    if (playerId === me) return own;
    const peer = peerFor(playerId);
    if (peer) return peer.sleeve;
    return me ? null : own;
  }

  // Card faces use .card-frame too, with more inside; a sleeve is exactly .card-frame > div > img.
  // Face-down cards are drawn by the card face itself, with the player's sleeve image (or Magic's
  // card back, backs.scryfall.io, for the Classic sleeve). Outside dialogs (Settings lists the
  // same images as tiles) any of those images is a sleeve.
  const BACKS_RX = /^https:\/\/backs\.scryfall\.io\//i;
  const SITE_SLEEVE_RX = /^(?:https:\/\/(?:www\.)?edhplay\.com)?\/sleeves\//i;
  function isFrameSleeve(img) {
    const box = img.parentElement, frame = box && box.parentElement;
    return !!frame && frame.classList.contains('card-frame') && frame.children.length === 1 && box.children.length === 1;
  }

  // edhplay's own image for this <img>: what we saved when we replaced it, else its src. The same
  // element can switch from a card face to a sleeve (turned face down), so a saved value only
  // counts while the src is still the replacement we put there.
  function siteSrc(img) {
    const src = img.getAttribute('src') || '';
    if (img.dataset.eaSleeve && src === img.dataset.eaSleeve) return img.dataset.eaSleeveOrig || '';
    if (img.dataset.eaSrc && src === img.dataset.eaSrc) return img.dataset.eaOrig || '';
    return src;
  }

  function isSleeveImg(img) {
    const src = siteSrc(img);
    if (CARD_RX.test(src)) return false;
    if ((BACKS_RX.test(src) || SITE_SLEEVE_RX.test(src)) && !img.closest('[role="dialog"]')) return true;
    return isFrameSleeve(img);
  }

  function processSleeve(img) {
    const src = img.getAttribute('src') || '';
    if (!(img.dataset.eaSleeve && src === img.dataset.eaSleeve)) {
      img.dataset.eaSleeveOrig = src;
      delete img.dataset.eaSleeve;
    }
    const sleeve = sleeveFor(img.dataset.eaSleeveOwner || null);
    if (!sleeve) {
      if (img.dataset.eaSleeve) {
        delete img.dataset.eaSleeve;
        img.src = img.dataset.eaSleeveOrig;
      }
      return;
    }
    const url = sleeveImage(sleeve);
    img.dataset.eaSleeve = url;
    if (src !== url) img.src = url;
    // A cropped image sleeve is a local file: share it through litterbox like local arts.
    if (sleeve === ownSleeve() && url.startsWith('data:') && !sleeve.c && sync) {
      wanted.add(url);
      shareLocalArts();
    }
  }

  // ---------- "Custom" tabs in edhplay's Settings > Card Sleeves and Playmats ----------

  // Both panels have filter tabs (All / Free / Patreon, role="tab" with data-value) above a grid
  // of tiles; the panel's id says which one it is. A cloned "Custom" tab swaps that grid for ours.
  // A custom pick only takes effect with edhplay's own Save Preferences; Close throws it away.

  const CHECK_SVG = '<svg viewBox="0 0 512 512" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M256 48C141.31 48 48 141.31 48 256s93.31 208 208 208 208-93.31 208-208S370.69 48 256 48zm108.25 138.29-134.4 160a16 16 0 0 1-12 5.71h-.27a16 16 0 0 1-11.89-5.3l-57.6-64a16 16 0 1 1 23.78-21.4l45.29 50.32 122.59-145.91a16 16 0 0 1 24.5 20.58z"/></svg>';

  const COSMETICS = {
    playmat: {
      panel: 'playmats',
      items: () => playmats,
      setItems: (list) => { playmats = list; return { playmats: list }; },
      active: () => activePlaymat,
      store: (id) => ({ playmat: id }),
      image: (mat) => directImageUrl(mat.u),
      note: 'pm_note',
      addTitle: 'pm_addTitle',
      openForm: (mount, onSaved) => openPlaymatForm(mount, onSaved),
      // The playmat being picked is previewed on your board.
      preview: (id) => { previewPlaymat = id; schedulePlaymats(); },
    },
    sleeve: {
      panel: 'sleeves',
      items: () => sleeves,
      setItems: (list) => { sleeves = list; return { sleeves: list }; },
      active: () => activeSleeve,
      store: (id) => ({ sleeve: id }),
      image: sleeveImage,
      note: 'sl_note',
      addTitle: 'sl_addTitle',
      openForm: (mount, onSaved) => openSleeveForm(mount, onSaved),
      preview: () => {},
    },
  };

  // Tiles copy edhplay's: 12px corners, name on hover, cyan inset when selected.
  const PLAYMAT_CSS = EDH_BASE_CSS + `
    :host { display: block; }
    .note { color: #a1a1aa; font-size: 12px; margin: 0 0 10px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--tile-min, 180px), 1fr)); gap: 12px; }
    .tile { position: relative; overflow: hidden; border-radius: 12px; background: rgba(255,255,255,.04); cursor: pointer; aspect-ratio: var(--tile-aspect, 16/9); }
    .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .tile .cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 28px 8px 6px; font-size: 12px; font-weight: 500;
      color: #fafafa; background: linear-gradient(to top, rgba(0,0,0,.92), rgba(0,0,0,0)); opacity: 0; transition: opacity .18s;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile:hover .cap { opacity: 1; }
    .tile .sel { position: absolute; inset: 0; border-radius: 12px; pointer-events: none; display: none;
      box-shadow: inset 0 0 0 2px rgb(32,184,205), inset 0 0 20px 5px rgba(32,184,205,.5); }
    .tile .check { position: absolute; top: 4px; right: 4px; color: rgb(32,184,205); display: none; line-height: 0; }
    .tile.selected .sel, .tile.selected .check { display: block; }
    .tile.add { border: 1px dashed rgba(255,255,255,.12); display: flex; align-items: center; justify-content: center;
      color: #a1a1aa; font-size: 13px; font-weight: 500; text-align: center; padding: 8px; }
    .tile.add:hover { border-color: #0891b2; color: #22d3ee; }
    .tile:focus-visible { outline: 2px solid #0891b2; outline-offset: 2px; }
    .act { position: absolute; top: 6px; width: 28px; height: 28px; padding: 0; border-radius: 9999px; justify-content: center;
      background: rgba(24,24,27,.85); opacity: 0; transition: opacity .15s, background-color .15s; }
    .act svg { width: 14px; height: 14px; fill: currentColor; }
    .tile:hover .act, .act:focus-visible { opacity: 1; }
    .del { left: 6px; color: #f87171; }
    .ren { left: 38px; color: #d4d4d8; }
    .act:hover { background: #18181b; }
    .confirm { position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center;
      gap: 8px; background: rgba(24,24,27,.92); cursor: default; text-align: center; padding: 6px; }
    .confirm span { font-size: 13px; font-weight: 500; color: #fafafa; }
    .confirm .row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
    .tile.asking .confirm { display: flex; }
    .tile.asking .act { display: none; }
    button.danger-solid { background: #dc2626; color: #fff; }
    button.danger-solid:hover { background: #b91c1c; }
    input.rename { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 28px; font-size: 12px; }
  `;

  // A pick waits here until Save Preferences: dialog -> { playmat?, sleeve? } (an id, or null for
  // edhplay's own). It outlives the panel, which edhplay rebuilds when switching tabs.
  const pendingChoices = new Map();
  const pendingOf = (dlg, kind) => (pendingChoices.get(dlg) || {})[kind];
  function setPending(dlg, kind, value) {
    const all = pendingChoices.get(dlg) || {};
    if (value === undefined) delete all[kind]; else all[kind] = value;
    if (Object.keys(all).length) pendingChoices.set(dlg, all); else pendingChoices.delete(dlg);
    COSMETICS[kind].preview(value);
  }

  function kindOfList(dlg, list) {
    const panel = list.closest('[role="tabpanel"]');
    for (const [kind, c] of Object.entries(COSMETICS)) {
      if (panel && panel.id.endsWith('content-' + c.panel)) return kind;
    }
    // No panel id to go by: use the dialog's selected section tab.
    for (const [kind, c] of Object.entries(COSMETICS)) {
      if (dlg.querySelector(`[role="tab"][data-value="${c.panel}"][aria-selected="true"]`)) return kind;
    }
    return null;
  }

  function scanCosmeticSettings() {
    for (const dlg of document.querySelectorAll('[role="dialog"][data-state="open"]')) {
      for (const free of dlg.querySelectorAll('[role="tab"][data-value="free"]')) {
        const list = free.closest('[role="tablist"]');
        if (!list || !list.querySelector('[role="tab"][data-value="patreon"]') || list.querySelector('[data-ea-custom-tab]')) continue;
        const kind = kindOfList(dlg, list);
        if (kind) injectCustomTab(dlg, list, free, kind);
      }
    }
    // Settings closed without saving: drop its picks (and the playmat preview).
    for (const dlg of [...pendingChoices.keys()]) {
      if (dlg.isConnected && dlg.getAttribute('data-state') === 'open') continue;
      for (const kind of Object.keys(pendingChoices.get(dlg))) setPending(dlg, kind, undefined);
    }
  }

  function injectCustomTab(dlg, list, template, kind) {
    const c = COSMETICS[kind];
    const trigger = template.cloneNode(true);
    trigger.dataset.eaCustomTab = kind;
    trigger.dataset.value = 'edhproxy-custom';
    trigger.id = 'edhproxy-' + kind + '-tab';
    trigger.removeAttribute('data-selected');
    trigger.removeAttribute('data-focus');
    trigger.setAttribute('aria-selected', 'false');
    trigger.tabIndex = -1;
    list.insertBefore(trigger, list.querySelector('[data-part="indicator"]'));

    const ctx = { kind, dlg, list, trigger, active: false, host: null };
    ctx.pending = () => pendingOf(dlg, kind);
    ctx.setLabel = () => { trigger.textContent = `${t('custom')} (${c.items().length})`; };
    ctx.grid = () => list.closest('[data-part="root"]').nextElementSibling;
    ctx.setLabel();

    // Keep edhplay's tabs machinery out of it; we drive this tab ourselves.
    for (const type of ['pointerdown', 'mousedown', 'keydown', 'focus']) trigger.addEventListener(type, (e) => e.stopPropagation());
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCustomTab(ctx, true);
    });
    // Any of edhplay's own filters takes the view back.
    list.addEventListener('click', (e) => {
      const tab = e.target.closest('[role="tab"]');
      if (tab && tab !== trigger) showCustomTab(ctx, false);
    }, true);
  }

  // Picking one of edhplay's tiles replaces the custom one. Listened for on the window: edhplay
  // rebuilds the grid when switching All / Free / Patreon, which would drop a listener on it.
  window.addEventListener('click', (e) => {
    const tile = e.target.closest && e.target.closest('.group');
    const dlg = tile && tile.closest('[role="dialog"]');
    const list = dlg && tile.closest('[role="tabpanel"]') && tile.closest('[role="tabpanel"]').querySelector('[role="tablist"]');
    const kind = list && kindOfList(dlg, list);
    if (!kind) return;
    if (COSMETICS[kind].active() || pendingOf(dlg, kind)) {
      setPending(dlg, kind, COSMETICS[kind].active() ? null : undefined);
      refreshCustomViews();
    }
  }, true);

  function showCustomTab(ctx, on) {
    if (on === ctx.active) return;
    ctx.active = on;
    const grid = ctx.grid();
    const indicator = ctx.list.querySelector('[data-part="indicator"]');
    ctx.trigger.setAttribute('aria-selected', String(on));
    ctx.trigger.toggleAttribute('data-selected', on);
    if (on) {
      // The selected tab's underline is a ::before, which inline styles can't reach. An unlayered
      // rule outranks Chakra's layered styles.
      if (!document.getElementById('edhproxy-tab-style')) {
        const style = document.createElement('style');
        style.id = 'edhproxy-tab-style';
        style.textContent = '[data-ea-dimmed]::before { content: none; }';
        document.head.append(style);
      }
      // edhplay still thinks its tab is selected; make it look unselected while ours is shown.
      for (const tab of ctx.list.querySelectorAll('[role="tab"][aria-selected="true"]')) {
        if (tab === ctx.trigger) continue;
        tab.style.setProperty('color', 'rgb(161, 161, 170)', 'important');
        tab.style.setProperty('background', 'transparent', 'important');
        tab.dataset.eaDimmed = '1';
      }
      if (indicator) indicator.style.setProperty('opacity', '0', 'important');
      grid.style.setProperty('display', 'none', 'important');
      ctx.host = renderCustomPanel(ctx);
      grid.after(ctx.host);
      refreshCustomViews();
    } else {
      for (const tab of ctx.list.querySelectorAll('[data-ea-dimmed]')) {
        tab.style.removeProperty('color');
        tab.style.removeProperty('background');
        delete tab.dataset.eaDimmed;
      }
      if (indicator) indicator.style.removeProperty('opacity');
      grid.style.removeProperty('display');
      if (ctx.host) ctx.host.remove();
      ctx.host = null;
    }
  }

  // id = a custom item, null = back to edhplay's. Choosing what is already in use is no change.
  function chooseCustom(ctx, id) {
    setPending(ctx.dlg, ctx.kind, id === COSMETICS[ctx.kind].active() ? undefined : id);
    refreshCustomViews();
    const sleeve = ctx.kind === 'sleeve' && id && sleeves.find(s => s.id === id);
    if (sleeve) playSleevePreview(sleeveImage(sleeve));
  }

  // edhplay's own sleeve preview: a big card flipping over at the side of the screen, styled by
  // its global sleeve-preview-* classes (loaded with the Settings dialog).
  const SLEEVE_PREVIEW_FRONT = 'https://cards.scryfall.io/normal/front/4/a/4a1f905f-1d55-4d02-9d24-e58070793d3f.jpg?1717951088';
  const SLEEVE_PREVIEW_MS = 2800;
  function playSleevePreview(back) {
    for (const old of document.querySelectorAll('[data-ea-sleeve-preview]')) old.remove();
    const container = document.createElement('div');
    container.className = 'sleeve-preview-container';
    container.dataset.eaSleevePreview = '1';
    container.innerHTML = `<div class="sleeve-preview-perspective standard" style="--animation-duration: ${SLEEVE_PREVIEW_MS}ms">
      <div class="sleeve-preview-card"><div class="sleeve-card-face sleeve-card-front"></div><div class="sleeve-card-face sleeve-card-back"></div></div></div>`;
    container.querySelector('.sleeve-card-front').style.backgroundImage = `url("${SLEEVE_PREVIEW_FRONT}")`;
    container.querySelector('.sleeve-card-back').style.backgroundImage = `url("${back}")`;
    document.body.append(container);
    setTimeout(() => container.remove(), SLEEVE_PREVIEW_MS + 100);
  }

  function renderCustomPanel(ctx) {
    const c = COSMETICS[ctx.kind];
    const host = document.createElement('div');
    host.dataset.eaCustomPanel = ctx.kind;
    if (ctx.kind === 'sleeve') {
      host.style.setProperty('--tile-min', '110px');
      host.style.setProperty('--tile-aspect', '274/384');
    }
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${PLAYMAT_CSS}</style><p class="note"></p><div class="grid"></div><div class="form"></div>`;
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
    const gridEl = root.querySelector('.grid');

    const view = {
      host,
      render() {
        const pair = footerPairs(ctx.dlg)[0];
        root.querySelector('.note').textContent = t(c.note, { save: (pair && pair.confirm.textContent.trim()) || 'Save' });
        ctx.setLabel();
        const pending = ctx.pending();
        const current = pending !== undefined ? pending : c.active();
        gridEl.textContent = '';
        for (const item of c.items()) gridEl.append(customTile(ctx, item, current === item.id));
        const add = document.createElement('div');
        add.className = 'tile add';
        add.tabIndex = 0;
        add.setAttribute('role', 'button');
        add.title = t(c.addTitle);
        add.textContent = '+ ' + t('add');
        add.onclick = () => c.openForm(root.querySelector('.form'), (item) => chooseCustom(ctx, item.id));
        add.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add.onclick(); } };
        gridEl.append(add);
      },
    };
    customViews.add(view);
    view.render();
    return host;
  }

  function customTile(ctx, item, selected) {
    const c = COSMETICS[ctx.kind];
    const tile = document.createElement('div');
    tile.className = 'tile' + (selected ? ' selected' : '');
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = c.image(item);
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = item.n || t('unnamed');
    tile.title = item.n || '';
    tile.append(img, cap);
    tile.insertAdjacentHTML('beforeend', `<div class="sel"></div><div class="check">${CHECK_SVG}</div>`);
    tile.onclick = () => chooseCustom(ctx, item.id);
    tile.onkeydown = (e) => { if (e.target === tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tile.onclick(); } };

    const del = document.createElement('button');
    del.className = 'act del';
    del.innerHTML = CLOSE_SVG;
    del.title = t('deleteTitle');
    del.setAttribute('aria-label', t('deleteTitle'));
    const ask = document.createElement('div');
    ask.className = 'confirm';
    ask.innerHTML = '<span></span><div class="row"><button class="danger-solid sm yes"></button><button class="subtle sm no"></button></div>';
    ask.querySelector('span').textContent = t('deleteAsk');
    ask.querySelector('.yes').textContent = t('delete');
    ask.querySelector('.no').textContent = t('cancel');
    ask.onclick = (e) => e.stopPropagation();
    ask.onkeydown = (e) => e.stopPropagation();
    ask.querySelector('.yes').onclick = () => deleteCustom(ctx, item.id);
    ask.querySelector('.no').onclick = () => tile.classList.remove('asking');
    del.onclick = (e) => { e.stopPropagation(); tile.classList.add('asking'); ask.querySelector('.no').focus(); };

    const ren = document.createElement('button');
    ren.className = 'act ren';
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
      input.value = item.n || '';
      input.onclick = (ev) => ev.stopPropagation();
      tile.append(input);
      input.focus();
      input.select();
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        input.remove();
        if (!save) return;
        const n = input.value.trim().slice(0, 40);
        await chrome.storage.local.set(c.setItems(c.items().map(x => (x.id === item.id ? { ...x, n: n || undefined } : x))));
      };
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      };
      input.onblur = () => finish(true);
    };
    tile.append(ask, del, ren);
    return tile;
  }

  async function deleteCustom(ctx, id) {
    const c = COSMETICS[ctx.kind];
    const changes = c.setItems(c.items().filter(x => x.id !== id));
    if (ctx.pending() === id) setPending(ctx.dlg, ctx.kind, undefined);
    if (c.active() === id) Object.assign(changes, c.store(null));
    await chrome.storage.local.set(changes);
  }

  // Same look as the art form; the preview is a 16:9 playmat.
  function openPlaymatForm(mount, onSaved) {
    if (mount.firstChild) return;
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${FORM_CSS} .previews img { width: 220px; aspect-ratio: 16/9; border-radius: 12px; }</style>
      <div class="box" role="group" aria-label="${t('pm_formTitle')}">
        <div class="header"><h2>${t('pm_formTitle')}</h2><div class="sub">${t('pm_formSub')}</div></div>
        <div class="body"><div class="row">
          <div class="previews"><figure><img class="prev" alt=""><figcaption>${t('preview')}</figcaption></figure></div>
          <div class="form">
            <label class="field">${t('nameLabel')} <span class="hint">${t('nameHint')}</span>
              <input type="text" class="name" maxlength="40" spellcheck="false"></label>
            <label class="field">${t('urlLabel')} <span class="hint">${t('urlHint')}</span>
              <input type="text" class="url" placeholder="https://i.imgur.com/....png" spellcheck="false"></label>
            <label class="field">${t('fileLabel')}<input type="file" class="file" accept="image/*"></label>
            <div class="warn"></div>
          </div>
        </div></div>
        <div class="footer"><button class="cancel">${t('cancel')}</button><button class="primary save">${t('save')}</button></div>
      </div>`;
    mount.appendChild(host);
    const $ = (sel) => root.querySelector(sel);
    const nameInput = $('.name'), urlInput = $('.url'), fileInput = $('.file'), warn = $('.warn'), prev = $('.prev');
    let fileData = null;
    let previewSeq = 0;
    const close = () => host.remove();
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
    $('.cancel').onclick = close;
    const source = () => fileData || directImageUrl(urlInput.value.trim());

    async function updatePreview() {
      const seq = ++previewSeq;
      const u = source();
      warn.textContent = '';
      if (!u) { prev.removeAttribute('src'); return; }
      if (!fileData && !/^https:\/\//i.test(u)) { warn.textContent = t('errHttps'); return; }
      try {
        await loadImage(u);
        if (seq === previewSeq) prev.src = u;
      } catch {
        if (seq === previewSeq) warn.textContent = t(isDriveLink(urlInput.value.trim()) ? 'errDrive' : 'errLoad');
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
      fileData = await shrinkFile(f, PLAYMAT_WIDTH);
      urlInput.value = '';
      if (!nameInput.value) nameInput.value = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
      updatePreview();
    });
    $('.save').onclick = async () => {
      const u = source();
      if (!u) { warn.textContent = t('errMissing'); return; }
      if (!fileData && !/^https:\/\//i.test(u)) { warn.textContent = t('errHttps'); return; }
      const mat = { id: crypto.randomUUID(), u, t: Date.now() };
      const n = nameInput.value.trim();
      if (n) mat.n = n;
      try {
        await chrome.storage.local.set(COSMETICS.playmat.setItems([mat, ...playmats]));
      } catch (e) {
        warn.textContent = t('errSave', { msg: e.message });
        return;
      }
      close();
      onSaved(mat);
    };
    nameInput.focus();
  }

  // New sleeve: a Custom Matte (pick a color) or an image framed in the sleeve's shape. Images
  // are cropped here (drag to move, zoom with the slider or the wheel), the same way an avatar
  // is cropped on Discord, and saved at twice edhplay's sleeve size.
  const SLEEVE_FORM_CSS = FORM_CSS + `
    .modes { display: flex; gap: 4px; padding: 3px; border-radius: 8px; background: rgba(255,255,255,.04); align-self: flex-start; }
    .modes button { height: 30px; font-size: 13px; padding: 0 12px; }
    .modes button[aria-pressed="true"] { background: rgba(255,255,255,.1); color: #fafafa; }
    .crop { position: relative; width: 196px; aspect-ratio: 274/384; overflow: hidden; border-radius: 4.4% / 3.15%;
      background: rgba(255,255,255,.04); touch-action: none; cursor: grab; user-select: none; flex: none;
      box-shadow: 0 0 0 2px #52525b; }
    .crop.dragging { cursor: grabbing; }
    .crop.blank { box-shadow: none; border: 1px dashed rgba(255,255,255,.12); cursor: default; }
    .crop img { position: absolute; left: 0; top: 0; max-width: none; transform-origin: 0 0; pointer-events: none; }
    .crop .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center;
      padding: 12px; color: #71717a; font-size: 12px; }
    .side { display: flex; flex-direction: column; gap: 8px; align-items: center; }
    .side .hint { text-align: center; max-width: 196px; }
    input[type=range] { width: 196px; accent-color: #0891b2; }
    input[type=color] { width: 56px; height: 36px; padding: 2px; border-radius: 6px; border: 1px solid rgba(255,255,255,.06);
      background: rgba(255,255,255,.04); cursor: pointer; }
    .colors { display: flex; align-items: center; gap: 10px; }
    [hidden] { display: none !important; }
  `;

  function openSleeveForm(mount, onSaved) {
    if (mount.firstChild) return;
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${SLEEVE_FORM_CSS}</style>
      <div class="box" role="group" aria-label="${t('sl_formTitle')}">
        <div class="header"><h2>${t('sl_formTitle')}</h2><div class="sub">${t('sl_formSub')}</div></div>
        <div class="body"><div class="row">
          <div class="side">
            <div class="crop"><img alt=""><div class="empty">${t('sl_pick')}</div></div>
            <input type="range" class="zoom" min="1" max="4" step="0.01" value="1" aria-label="${t('sl_zoom')}" hidden>
            <span class="hint drag" hidden>${t('sl_drag')}</span>
          </div>
          <div class="form">
            <div class="modes" role="group">
              <button type="button" class="mode" data-mode="matte" aria-pressed="true">${t('sl_matte')}</button>
              <button type="button" class="mode" data-mode="image" aria-pressed="false">${t('sl_image')}</button>
            </div>
            <label class="field">${t('nameLabel')} <span class="hint">${t('nameHint')}</span>
              <input type="text" class="name" maxlength="40" spellcheck="false"></label>
            <div class="field matte-only">${t('sl_color')}
              <div class="colors"><input type="color" class="color" value="#1e3a8a"><span class="hint hex"></span></div></div>
            <label class="field image-only" hidden>${t('urlLabel')} <span class="hint">${t('urlHint')}</span>
              <input type="text" class="url" placeholder="https://i.imgur.com/....png" spellcheck="false"></label>
            <label class="field image-only" hidden>${t('fileLabel')}<input type="file" class="file" accept="image/*"></label>
            <div class="warn"></div>
          </div>
        </div></div>
        <div class="footer"><button class="cancel">${t('cancel')}</button><button class="primary save">${t('save')}</button></div>
      </div>`;
    mount.appendChild(host);
    const $ = (sel) => root.querySelector(sel);
    const nameInput = $('.name'), urlInput = $('.url'), fileInput = $('.file'), warn = $('.warn');
    const colorInput = $('.color'), crop = $('.crop'), cropImg = $('.crop img'), empty = $('.crop .empty'), zoom = $('.zoom');
    const close = () => host.remove();
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    for (const type of ['keydown', 'keyup', 'keypress']) root.addEventListener(type, (e) => e.stopPropagation());
    $('.cancel').onclick = close;

    let mode = 'matte';
    // The picture being framed: a data URL (pixels we may read) and its size.
    let pic = null; // { src, w, h }
    let view = { scale: 1, x: 0, y: 0 }; // image px -> crop box px: box = img * scale + (x, y)
    let loadSeq = 0;

    const box = () => crop.getBoundingClientRect();
    const minScale = () => Math.max(box().width / pic.w, box().height / pic.h);
    function clamp() {
      const b = box();
      view.x = Math.min(0, Math.max(b.width - pic.w * view.scale, view.x));
      view.y = Math.min(0, Math.max(b.height - pic.h * view.scale, view.y));
    }
    function draw() {
      if (mode === 'matte') {
        // The texture layer over a background color: dragging the color picker repaints nothing.
        crop.style.backgroundColor = colorInput.value;
        const layer = matteOverlay().url;
        if (cropImg.getAttribute('src') !== layer) cropImg.src = layer;
        Object.assign(cropImg.style, { width: '100%', height: '100%', transform: 'none' });
        empty.hidden = true;
        cropImg.hidden = false;
        crop.classList.remove('blank');
        return;
      }
      crop.style.backgroundColor = '';
      empty.hidden = !!pic;
      zoom.hidden = $('.drag').hidden = !pic;
      // No picture yet: a dashed empty box like the Add tiles, not a broken image.
      crop.classList.toggle('blank', !pic);
      cropImg.hidden = !pic;
      if (!pic) { cropImg.removeAttribute('src'); return; }
      if (cropImg.getAttribute('src') !== pic.src) cropImg.src = pic.src;
      Object.assign(cropImg.style, { width: pic.w + 'px', height: pic.h + 'px', transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` });
    }
    // Zoom keeping the point under (cx, cy) of the crop box still.
    function zoomTo(factor, cx, cy) {
      const s = minScale() * factor;
      const b = box();
      if (cx === undefined) { cx = b.width / 2; cy = b.height / 2; }
      view.x = cx - ((cx - view.x) / view.scale) * s;
      view.y = cy - ((cy - view.y) / view.scale) * s;
      view.scale = s;
      clamp();
      draw();
    }

    function setMode(m) {
      mode = m;
      for (const b of root.querySelectorAll('.mode')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
      for (const el of root.querySelectorAll('.matte-only')) el.hidden = m !== 'matte';
      for (const el of root.querySelectorAll('.image-only')) el.hidden = m !== 'image';
      zoom.hidden = $('.drag').hidden = m !== 'image' || !pic;
      crop.style.cursor = m === 'image' && pic ? '' : 'default';
      warn.textContent = '';
      draw();
    }
    for (const b of root.querySelectorAll('.mode')) b.onclick = () => setMode(b.dataset.mode);
    const showHex = () => { $('.hex').textContent = colorInput.value.toUpperCase(); };
    colorInput.addEventListener('input', () => { showHex(); draw(); });
    showHex();

    async function usePicture(src) {
      const seq = ++loadSeq;
      try {
        const img = await loadImage(src);
        if (seq !== loadSeq) return;
        pic = { src, w: img.naturalWidth, h: img.naturalHeight };
        view.scale = minScale();
        const b = box();
        view.x = (b.width - pic.w * view.scale) / 2;
        view.y = (b.height - pic.h * view.scale) / 2;
        zoom.value = '1';
        crop.style.cursor = '';
        draw();
      } catch {
        if (seq === loadSeq) warn.textContent = t('errLoad');
      }
    }

    let typingTimer = null;
    urlInput.addEventListener('input', () => {
      fileInput.value = '';
      clearTimeout(typingTimer);
      typingTimer = setTimeout(async () => {
        const typed = urlInput.value.trim();
        const u = directImageUrl(typed);
        warn.textContent = '';
        if (!u) return;
        if (!/^https:\/\//i.test(u)) { warn.textContent = t('errHttps'); return; }
        // Fetched by the background as a data URL, so the crop can be saved from a canvas.
        try {
          const res = await send({ type: 'render', url: u, width: 1600, asData: true });
          if (urlInput.value.trim() === typed) usePicture(res.url);
        } catch {
          if (urlInput.value.trim() === typed) warn.textContent = t(isDriveLink(typed) ? 'errDrive' : 'errLoad');
        }
      }, 400);
    });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      urlInput.value = '';
      warn.textContent = '';
      if (!nameInput.value) nameInput.value = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
      usePicture(await shrinkFile(f, 1600));
    });

    zoom.addEventListener('input', () => { if (pic) zoomTo(Number(zoom.value)); });
    crop.addEventListener('wheel', (e) => {
      if (mode !== 'image' || !pic) return;
      e.preventDefault();
      const b = box();
      const factor = Math.min(4, Math.max(1, Number(zoom.value) * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      zoom.value = String(factor);
      zoomTo(factor, e.clientX - b.left, e.clientY - b.top);
    }, { passive: false });
    let drag = null;
    crop.addEventListener('pointerdown', (e) => {
      if (mode !== 'image' || !pic) return;
      drag = { id: e.pointerId, x: e.clientX - view.x, y: e.clientY - view.y };
      crop.setPointerCapture(e.pointerId);
      crop.classList.add('dragging');
    });
    crop.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      view.x = e.clientX - drag.x;
      view.y = e.clientY - drag.y;
      clamp();
      draw();
    });
    const endDrag = () => { drag = null; crop.classList.remove('dragging'); };
    crop.addEventListener('pointerup', endDrag);
    crop.addEventListener('pointercancel', endDrag);

    // The framed part of the picture at the sleeve's resolution.
    async function cropped() {
      const img = await loadImage(pic.src);
      const b = box();
      const c = document.createElement('canvas');
      c.width = SLEEVE_W;
      c.height = SLEEVE_H;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, -view.x / view.scale, -view.y / view.scale, b.width / view.scale, b.height / view.scale, 0, 0, SLEEVE_W, SLEEVE_H);
      return c.toDataURL('image/webp', 0.9);
    }

    $('.save').onclick = async () => {
      const sleeve = { id: crypto.randomUUID(), t: Date.now() };
      if (mode === 'matte') {
        sleeve.c = colorInput.value.toLowerCase();
      } else {
        if (!pic) { warn.textContent = t('errMissing'); return; }
        sleeve.u = await cropped();
      }
      const n = nameInput.value.trim() || (mode === 'matte' ? t('sl_matte') : '');
      if (n) sleeve.n = n.slice(0, 40);
      try {
        await chrome.storage.local.set(COSMETICS.sleeve.setItems([sleeve, ...sleeves]));
      } catch (e) {
        warn.textContent = t('errSave', { msg: e.message });
        return;
      }
      close();
      onSaved(sleeve);
    };
    setMode('matte');
    nameInput.focus();
  }

  // Save Preferences commits the custom picks; edhplay saves its own settings as usual.
  window.addEventListener('click', (e) => {
    const dlg = e.target.closest && e.target.closest('[role="dialog"]');
    const picks = dlg && pendingChoices.get(dlg);
    if (!picks) return;
    if (!footerPairs(dlg).some(p => p.confirm.contains(e.target))) return;
    const changes = {};
    for (const [kind, id] of Object.entries(picks)) {
      Object.assign(changes, COSMETICS[kind].store(id));
      setPending(dlg, kind, undefined);
    }
    chrome.storage.local.set(changes);
  }, true);

  // ---------- mana symbols instead of edhplay's letters (an option, off by default) ----------

  // page-owner.js marks each of edhplay's mana circles with data-ea-mana="<symbol>" while
  // <html data-ea-mana-symbols> is set. The circle then shows Scryfall's symbol (fetched by the
  // background, kept in extension storage) and its letter is hidden.
  const MANA_CACHE_KEY = 'manaSymbolCache';
  const manaUrls = new Map(); // file name -> data URL, or null while loading / failed
  const manaFile = (symbol) => symbol.replace(/[{}/]/g, '').toUpperCase();

  function manaUrl(file) {
    if (manaUrls.has(file)) return manaUrls.get(file);
    manaUrls.set(file, null);
    (async () => {
      const { [MANA_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(MANA_CACHE_KEY);
      if (cache[file]) return cache[file];
      const { url } = await send({ type: 'manaSymbol', file });
      const latest = (await chrome.storage.local.get(MANA_CACHE_KEY))[MANA_CACHE_KEY] || {};
      chrome.storage.local.set({ [MANA_CACHE_KEY]: { ...latest, [file]: url } }).catch(() => {});
      return url;
    })()
      .then((url) => { manaUrls.set(file, url); scheduleMana(); })
      .catch((e) => console.warn('[EDHProxy] mana symbol failed to load', file, e));
    return null;
  }

  function applyMana() {
    const on = !!settings.manaSymbols;
    const root = document.documentElement;
    if (on && !('eaManaSymbols' in root.dataset)) root.dataset.eaManaSymbols = '';
    if (!on && 'eaManaSymbols' in root.dataset) delete root.dataset.eaManaSymbols;
    if (on && !document.getElementById('edhproxy-mana-style')) {
      const style = document.createElement('style');
      style.id = 'edhproxy-mana-style';
      style.textContent = '[data-ea-mana-on] { border-color: transparent !important; box-shadow: none !important; }'
        + ' [data-ea-mana-on] > * { visibility: hidden !important; }';
      document.head.append(style);
    }
    for (const el of document.querySelectorAll('[data-ea-mana]')) {
      const file = manaFile(el.dataset.eaMana);
      const url = on && manaUrl(file);
      if (url) {
        if (el.dataset.eaManaOn === file) continue;
        // A bit smaller than edhplay's circle, so neighbouring symbols don't touch.
        el.style.setProperty('background', `url("${url}") center / 82% no-repeat`, 'important');
        el.dataset.eaManaOn = file;
      } else if (el.dataset.eaManaOn) {
        el.style.removeProperty('background');
        delete el.dataset.eaManaOn;
      }
    }
  }

  let manaQueued = false;
  function scheduleMana() {
    if (manaQueued) return;
    manaQueued = true;
    requestAnimationFrame(() => { manaQueued = false; applyMana(); });
  }

  // ---------- foil toggle on deck pages: card menu item and the F key ----------

  // Deck cards are [data-deck-card-id] elements holding the card's Scryfall image.
  const deckCardOf = (el) => (el && el.closest ? el.closest('[data-deck-card-id]') : null);
  let hoveredCard = null;   // deck card under the pointer, for the F key
  let menuCard = null;      // deck card whose menu was just opened: { el, at }

  function cardOfDeckElement(el) {
    for (const img of el.querySelectorAll('img')) {
      const card = parseCard(img.dataset.eaOrig || img.getAttribute('src'));
      if (card) return card;
    }
    return null;
  }

  async function isOwnFoil(card) {
    const names = await lookupName(card.id);
    return !!names && ownFoilFor(foilKeys(names), currentDeck());
  }

  // Foil is toggled for the deck in view only.
  async function toggleFoil(card) {
    const names = await lookupName(card.id);
    const deck = currentDeck();
    if (!names || !deck) return;
    const keys = foilKeys(names);
    const on = !ownFoilFor(keys, deck);
    const forDeck = deckFoils[deck] || (deckFoils[deck] = {});
    for (const k of keys) delete forDeck[k];
    // Only store what differs from the all-decks setting.
    if (on !== keys.some(k => ownFoils[k])) forDeck[keys[0]] = on;
    if (!Object.keys(forDeck).length) delete deckFoils[deck];
    await chrome.storage.local.set({ deckFoils });
  }

  const foilActive = () => settings.foilEnabled && onDeckPage();

  document.addEventListener('pointerover', (e) => { hoveredCard = deckCardOf(e.target); }, true);

  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'f' && e.key !== 'F') || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !foilActive()) return;
    const target = e.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (document.querySelector('[role="dialog"][data-state="open"]')) return;
    const card = hoveredCard && hoveredCard.isConnected && cardOfDeckElement(hoveredCard);
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    toggleFoil(card);
  }, true);

  // edhplay's card menu (Ark/Chakra) has no hook for extra items, so a "Foil" item is cloned from
  // one of its own (same look, with the F shortcut) and handled entirely by us.
  for (const type of ['pointerdown', 'contextmenu']) {
    document.addEventListener(type, (e) => {
      const el = deckCardOf(e.target);
      if (!el || !foilActive()) return;
      menuCard = { el, at: Date.now() };
      setTimeout(scanMenus, 60);
      setTimeout(scanMenus, 300);
    }, true);
  }

  function scanMenus() {
    if (!menuCard || Date.now() - menuCard.at > 2000 || !menuCard.el.isConnected) return;
    for (const menu of document.querySelectorAll('[role="menu"][data-state="open"]')) injectFoilItem(menu, menuCard.el);
  }

  function injectFoilItem(menu, deckCard) {
    if (menu.querySelector('[data-ea-foil-item]')) return;
    const card = cardOfDeckElement(deckCard);
    const template = [...menu.querySelectorAll('[role="menuitem"]')].find(i => i.querySelector('kbd'));
    if (!card || !template) return;

    const item = template.cloneNode(true);
    item.dataset.eaFoilItem = '1';
    item.id = 'edhproxy-foil';
    item.dataset.value = 'edhproxy-foil';
    item.removeAttribute('data-highlighted');
    const kbd = item.querySelector('kbd');
    kbd.textContent = 'F';
    const label = document.createTextNode(t('foilAdd'));
    item.replaceChildren(label, kbd);
    isOwnFoil(card).then((on) => { if (on) label.textContent = t('foilRemove'); });

    item.addEventListener('pointerenter', () => item.setAttribute('data-highlighted', ''));
    item.addEventListener('pointerleave', () => item.removeAttribute('data-highlighted'));
    // Keep the menu's own handlers from treating this as one of its items.
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) item.addEventListener(type, (e) => e.stopPropagation());
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFoil(card);
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    const separator = menu.querySelector('[role="separator"]');
    menu.insertBefore(item, separator || null);
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
    if (changes.deckArts || changes.deckFoils) {
      if (changes.deckArts) deckArts = changes.deckArts.newValue || {};
      if (changes.deckFoils) deckFoils = changes.deckFoils.newValue || {};
      scheduleScan();
      refreshCustomViews();
      if (sync) publishSoon(800);
    }
    if (changes.foils) {
      ownFoils = changes.foils.newValue || {};
      scheduleScan();
      if (sync) publishSoon(800);
    }
    if (changes.playmats || changes.playmat) {
      if (changes.playmats) playmats = changes.playmats.newValue || [];
      if (changes.playmat) activePlaymat = changes.playmat.newValue || null;
      schedulePlaymats();
      refreshCustomViews();
      if (sync) publishSoon(800);
    }
    if (changes.sleeves || changes.sleeve) {
      if (changes.sleeves) sleeves = changes.sleeves.newValue || [];
      if (changes.sleeve) activeSleeve = changes.sleeve.newValue || null;
      scheduleScan();
      refreshCustomViews();
      if (sync) publishSoon(800);
    }
    if (changes.settings) {
      const old = settings;
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      if (old.syncEnabled !== settings.syncEnabled || old.server !== settings.server) {
        lastRoom = undefined;
        checkRoom();
      } else if (old.uploadLocal !== settings.uploadLocal && sync) {
        shareLocalArts();
        publishSoon(300);
      } else if (old.foilEnabled !== settings.foilEnabled && sync) {
        publishSoon(300);
      }
      if (old.manaSymbols !== settings.manaSymbols) applyMana();
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
        foils: p.foils.size,
        playmat: !!p.playmat,
        sleeve: !!p.sleeve,
      })),
    });
  });

  async function init() {
    const data = await chrome.storage.local.get(['settings', 'arts', 'library', 'foils', 'deckArts', 'deckFoils', 'playmats', 'playmat', 'sleeves', 'sleeve', 'nameCache', 'clientId', 'hintCustomShown', HOSTED_KEY]);
    ownFoils = data.foils || {};
    deckArts = data.deckArts || {};
    deckFoils = data.deckFoils || {};
    playmats = data.playmats || [];
    activePlaymat = data.playmat || null;
    sleeves = data.sleeves || [];
    for (const [k, h] of Object.entries(data[HOSTED_KEY] || {})) {
      if (h && validRemoteUrl(h.url) && h.exp > Date.now()) hosted.set(k, h);
    }
    activeSleeve = data.sleeve || null;
    settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    ownArts = data.arts || {};
    library = data.library || {};
    let migrated = false;
    // Only whole-card images are supported now; older "art"/"extended" entries become whole-card.
    for (const a of [...Object.values(ownArts), ...Object.values(library).flat()]) {
      if (a.m !== 'full') { a.m = 'full'; migrated = true; }
      const direct = directImageUrl(a.u);
      if (direct !== a.u) { a.u = direct; migrated = true; }
    }
    if (migrated) chrome.storage.local.set({ arts: ownArts, library });
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
      attributeFilter: ['src', 'data-ea-owner', 'data-ea-sleeve-owner', 'data-ea-local-player', 'data-ea-local-deck', 'data-ea-mana'],
    });
    scanAll();
    scanPrintDialogs();
    scanCosmeticSettings();
    applyPlaymats();
    applyMana();
    checkRoom();
    setInterval(checkRoom, 1000);
    // Closing Settings removes nodes, which the observer above ignores; drop a stale preview here.
    setInterval(() => { if (pendingChoices.size) scanCosmeticSettings(); }, 1000);
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
