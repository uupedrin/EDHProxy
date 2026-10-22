// Runs in the page's main world so it can read React props, which the isolated content
// script can't see. It only publishes facts as DOM attributes for content.js to read:
//   <img data-ea-owner="<player id>">          owner of the card shown by that image
//   <html data-ea-local-player="<player id>">  the player using this browser
//   <html data-ea-players='{"<player id>":"<username>"}'>  usernames of everyone in the game
//   <html data-ea-local-deck="<deck id>">      the deck this browser's player joined with
(() => {
  'use strict';

  const CARD_IMG_RX = /^https:\/\/cards\.scryfall\.io\//;
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

  function tag(img) {
    const src = img.dataset.eaOrig || img.getAttribute('src') || '';
    if (!CARD_IMG_RX.test(src)) return;
    const owner = ownerOf(img);
    if (owner && img.dataset.eaOwner !== owner) img.dataset.eaOwner = owner;
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

  function refresh() {
    loadStore('meta', /\/assets\/playerMetadataStore-[\w-]+\.js$/, st => st.players instanceof Map && 'localPlayerId' in st);
    loadStore('lobby', /\/assets\/lobbyStore-[\w-]+\.js$/, st => st.players instanceof Map && 'setPlayerDeck' in st);
    const state = stores.meta && stores.meta.getState();
    const local = (state && state.localPlayerId) || findLocalPlayer();
    if (local) setRootData('eaLocalPlayer', String(local));
    const lobby = stores.lobby && stores.lobby.getState();
    const mine = lobby && local && lobby.players.get(local);
    setRootData('eaLocalDeck', mine && mine.deckId ? String(mine.deckId) : null);
    if (state) {
      const names = {};
      for (const [id, p] of state.players) if (p && p.username) names[id] = String(p.username);
      setRootData('eaPlayers', Object.keys(names).length ? JSON.stringify(names) : null);
    }
    for (const img of document.images) tag(img);
  }

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target.tagName === 'IMG') tag(m.target);
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') tag(n);
        else for (const i of n.querySelectorAll('img')) tag(i);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

  refresh();
  setInterval(refresh, 2000);
})();
