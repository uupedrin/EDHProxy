// Runs in the page's main world so it can read React props, which the isolated content
// script can't see. It only publishes facts as DOM attributes for content.js to read:
//   <img data-ea-owner="<player id>">          owner of the card shown by that image
//   <img data-ea-sleeve-owner="<player id>">   whose sleeve a card back (.card-frame > div > img, or a face-down card) shows
//   <html data-ea-local-player="<player id>">  the player using this browser
//   <html data-ea-players='{"<player id>":"<username>"}'>  usernames of everyone in the game
//   <html data-ea-local-deck="<deck id>">      the deck this browser's player joined with
(() => {
  'use strict';

  const CARD_IMG_RX = /^https:\/\/cards\.scryfall\.io\//;
  const BACKS_IMG_RX = /^https:\/\/backs\.scryfall\.io\//;
  const SITE_SLEEVE_RX = /^(?:https:\/\/(?:www\.)?edhplay\.com)?\/sleeves\//i;
  let fiberKey = null;

  function fiberOf(el) {
    if (fiberKey && el[fiberKey]) return el[fiberKey];
    for (const k in el) {
      if (k.startsWith('__reactFiber$')) { fiberKey = k; return el[k]; }
    }
    return null;
  }

  function ownerOf(img) {
    let f = fiberOf(img);
    for (let d = 0; f && d < 20; d++, f = f.return) {
      const card = f.memoizedProps && f.memoizedProps.card;
      if (card && typeof card === 'object' && card.owner_id) return String(card.owner_id);
    }
    return null;
  }

  // Card backs: the card's owner when the back belongs to a card, else the player whose zone
  // (hand, library) it is drawn in.
  function sleeveOwnerOf(img) {
    let f = fiberOf(img);
    for (let d = 0; f && d < 20; d++, f = f.return) {
      const p = f.memoizedProps;
      if (!p) continue;
      if (p.card && typeof p.card === 'object' && p.card.owner_id) return String(p.card.owner_id);
      if (p.playerId) return String(p.playerId);
    }
    return null;
  }

  // Same test as content.js: a sleeve is exactly .card-frame > div > img (card faces have more
  // inside their frame), or a sleeve image (edhplay's /sleeves/ or Magic's card back) anywhere
  // outside dialogs, which is how face-down cards are drawn.
  function isSleeve(img, src) {
    if ((BACKS_IMG_RX.test(src) || SITE_SLEEVE_RX.test(src)) && !img.closest('[role="dialog"]')) return true;
    const box = img.parentElement, frame = box && box.parentElement;
    return !!frame && frame.classList.contains('card-frame') && frame.children.length === 1 && box.children.length === 1;
  }

  // edhplay's own image for this <img> (content.js may have replaced it). The same element can
  // switch from a card face to a sleeve when turned face down, so a saved value only counts
  // while the src is still content.js's replacement.
  function siteSrc(img) {
    const src = img.getAttribute('src') || '';
    if (img.dataset.eaSleeve && src === img.dataset.eaSleeve) return img.dataset.eaSleeveOrig || '';
    if (img.dataset.eaSrc && src === img.dataset.eaSrc) return img.dataset.eaOrig || '';
    return src;
  }

  function tag(img) {
    const src = siteSrc(img);
    if (!CARD_IMG_RX.test(src)) {
      if (!isSleeve(img, src)) return;
      const owner = sleeveOwnerOf(img);
      if (owner && img.dataset.eaSleeveOwner !== owner) img.dataset.eaSleeveOwner = owner;
      return;
    }
    const owner = ownerOf(img);
    if (owner && img.dataset.eaOwner !== owner) img.dataset.eaOwner = owner;
  }

  // edhplay draws mana symbols (mana pool, costs, color identity) with a component that takes
  // { symbol, size } and renders a colored circle with a letter. Mark that circle with the symbol
  // so content.js can show the real mana symbol instead (an option, off by default).
  // Walks up from the letter; the last element passed before reaching the component is the circle.
  function tagMana(leaf) {
    let f = fiberOf(leaf);
    let el = null;
    for (let d = 0; f && d < 6; d++, f = f.return) {
      if (f.tag === 5 && f.stateNode && f.stateNode.nodeType === 1) el = f.stateNode; // host element
      const p = f.memoizedProps;
      if (!p || typeof p.symbol !== 'string' || !('size' in p)) continue;
      if (el && el.dataset.eaMana !== p.symbol) el.dataset.eaMana = p.symbol;
      return;
    }
  }

  function tagManaIn(root) {
    for (const el of root.querySelectorAll('span')) {
      if (el.children.length === 0 && el.textContent.length <= 4) tagMana(el);
    }
  }

  // Only cards in your own hand carry localPlayerId, so remember it once seen.
  function findLocalPlayer() {
    for (const el of document.querySelectorAll('.hand-card')) {
      let f = fiberOf(el);
      for (let d = 0; f && d < 4; d++, f = f.return) {
        const id = f.memoizedProps && f.memoizedProps.localPlayerId;
        if (id) return String(id);
      }
    }
    return null;
  }

  // edhplay keeps game state in zustand stores, each in its own lazy-loaded chunk. Importing the
  // same URL returns the same module instance, so the same store:
  //   playerMetadataStore: players (id -> username) and localPlayerId
  //   lobbyStore: players (id -> { deckId, ... }), i.e. which deck everyone joined with
  const stores = {};
  const storeLoading = {};
  async function loadStore(key, fileRx, isIt) {
    if (stores[key] || storeLoading[key]) return;
    const url = performance.getEntriesByType('resource').map(r => r.name).find(n => fileRx.test(n))
      || [...document.querySelectorAll('link[href]')].map(l => l.href).find(h => fileRx.test(h));
    if (!url) return;
    storeLoading[key] = true;
    try {
      const mod = await import(url);
      for (const v of Object.values(mod)) {
        const st = v && typeof v.getState === 'function' && v.getState();
        if (st && isIt(st)) { stores[key] = v; break; }
      }
    } catch (e) {
      console.warn('[EDHProxy] could not read edhplay store', key, e);
    } finally {
      storeLoading[key] = false;
    }
  }

  function setRootData(key, value) {
    const root = document.documentElement;
    if (value) {
      if (root.dataset[key] !== value) root.dataset[key] = value;
    } else if (key in root.dataset) {
      delete root.dataset[key];
    }
  }

  // The lobby knows our deck only until the game starts (or the page reloads), so remember it per
  // room for the rest of the game.
  function roomDeck(fromLobby) {
    const room = (location.pathname.match(/^\/games\/([^/]+)/) || [])[1];
    if (!room) return fromLobby;
    const key = 'edhpa-deck:' + room;
    try {
      if (fromLobby) localStorage.setItem(key, fromLobby);
      return fromLobby || localStorage.getItem(key);
    } catch {
      return fromLobby;
    }
  }

  function refresh() {
    loadStore('meta', /\/assets\/playerMetadataStore-[\w-]+\.js$/, st => st.players instanceof Map && 'localPlayerId' in st);
    loadStore('lobby', /\/assets\/lobbyStore-[\w-]+\.js$/, st => st.players instanceof Map && 'setPlayerDeck' in st);
    const state = stores.meta && stores.meta.getState();
    const local = (state && state.localPlayerId) || findLocalPlayer();
    if (local) setRootData('eaLocalPlayer', String(local));
    const lobby = stores.lobby && stores.lobby.getState();
    const mine = lobby && local && lobby.players.get(local);
    setRootData('eaLocalDeck', roomDeck(mine && mine.deckId ? String(mine.deckId) : null));
    if (state) {
      const names = {};
      for (const [id, p] of state.players) if (p && p.username) names[id] = String(p.username);
      setRootData('eaPlayers', Object.keys(names).length ? JSON.stringify(names) : null);
    }
    for (const img of document.images) tag(img);
    // content.js sets this while the mana symbols option is on.
    if (manaWanted()) tagManaIn(document.body);
  }

  const manaWanted = () => 'eaManaSymbols' in document.documentElement.dataset;

  new MutationObserver((mutations) => {
    const mana = manaWanted();
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target.tagName === 'IMG') tag(m.target);
        else if (m.target === document.documentElement && mana) tagManaIn(document.body);
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') tag(n);
        else for (const i of n.querySelectorAll('img')) tag(i);
        if (mana) {
          if (n.tagName === 'SPAN' && n.children.length === 0) tagMana(n);
          else tagManaIn(n);
        }
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-ea-mana-symbols'] });

  refresh();
  setInterval(refresh, 2000);
})();
